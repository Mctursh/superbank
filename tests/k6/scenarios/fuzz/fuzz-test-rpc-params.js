// SPDX-License-Identifier: AGPL-3.0-only
/*
 * Copyright 2025-2026 Triton One Limited. All rights reserved.
 */

// Fuzz Test for superbank-rpc parameter handling across methods
//
// Usage:
//   k6 run tests/k6/scenarios/fuzz/fuzz-test-rpc-params.js -e RPC_URL=http://localhost:8899
//   k6 run tests/k6/scenarios/fuzz/fuzz-test-rpc-params.js -e RPC_URL=http://localhost:8899 -e FUZZ_VALID_RATIO=0.2
//   k6 run tests/k6/scenarios/fuzz/fuzz-test-rpc-params.js -e RPC_URL=http://localhost:8899 -e FUZZ_METHODS=getTransaction,getBlock

import { Trend, Counter, Rate } from 'k6/metrics';
import { config, parseNonNegativeIntEnv, scenarios } from '../../lib/config.js';
import { initAddressPool, randomAddress } from '../../lib/addresses.js';
import { initSignaturePool, randomSignature, randomSignatures } from '../../lib/signatures.js';
import { initSlotPool, randomSlot } from '../../lib/slots.js';
import { executeRequest } from '../../lib/rpc.js';
import { addDownstreamMetrics } from '../../lib/summary.js';

const addressPool = initAddressPool();
const signaturePool = initSignaturePool();
const slotPool = initSlotPool();

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const INVALID_BASE58_CHARS = '0OIl+/=';

const VALID_COMMITMENTS = ['confirmed', 'finalized'];
const INVALID_COMMITMENTS = ['processed', 'recent', 'invalid', ''];
const VALID_ENCODINGS = ['json', 'jsonParsed', 'base64', 'base58'];
const INVALID_ENCODINGS = ['binary', 'raw', 'hex', ''];
const VALID_BLOCK_DETAILS = ['full', 'accounts', 'signatures', 'none'];
const INVALID_BLOCK_DETAILS = ['all', 'summary', ''];
const VALID_SORT_ORDERS = ['asc', 'desc'];
const INVALID_SORT_ORDERS = ['up', 'down', ''];
const VALID_TX_DETAILS = ['signatures', 'full'];
const INVALID_TX_DETAILS = ['all', 'summary', ''];
const VALID_TOKEN_ACCOUNTS = ['none', 'balanceChanged', 'all'];
const INVALID_TOKEN_ACCOUNTS = ['balances', 'unknown', ''];
const VALID_STATUS = ['any', 'all', 'succeeded', 'failed'];
const INVALID_STATUS = ['ok', 'error', ''];

const DEBUG_FAILURES =
  __ENV.FUZZ_DEBUG_FAILURES === '1' || __ENV.FUZZ_DEBUG_FAILURES === 'true';
const DEBUG_FAILURES_MAX = parseNonNegativeIntEnv('FUZZ_DEBUG_FAILURES_MAX', 20);
const DEBUG_PAYLOAD_MAX = parseNonNegativeIntEnv('FUZZ_DEBUG_PAYLOAD_MAX', 300);
const DEBUG_BODY_MAX = parseNonNegativeIntEnv('FUZZ_DEBUG_BODY_MAX', 300);
const DEBUG_RPC_ERRORS =
  __ENV.FUZZ_DEBUG_RPC_ERRORS === '1' || __ENV.FUZZ_DEBUG_RPC_ERRORS === 'true';

const VALID_RATIO = clampRatio(__ENV.FUZZ_VALID_RATIO, 0.35);
const REQUESTED_METHODS = parseMethodList(__ENV.FUZZ_METHODS);

const fuzzLatency = new Trend('rpc_fuzz_latency', true);
const fuzzNo5xxRate = new Rate('rpc_fuzz_no_5xx_rate');
const fuzzJsonOkRate = new Rate('rpc_fuzz_json_ok_rate');
const fuzzServerErrors = new Counter('rpc_fuzz_server_errors');
const fuzzNonJson = new Counter('rpc_fuzz_non_json');
const rpcErrorCodeCounter = new Counter('rpc_fuzz_rpc_error_code_count');

const methodCounters = {
  getSignaturesForAddress: new Counter('rpc_fuzz_method_getSignaturesForAddress'),
  getSignatureStatuses: new Counter('rpc_fuzz_method_getSignatureStatuses'),
  getTransaction: new Counter('rpc_fuzz_method_getTransaction'),
  getBlock: new Counter('rpc_fuzz_method_getBlock'),
  getBlockHeight: new Counter('rpc_fuzz_method_getBlockHeight'),
  getSlot: new Counter('rpc_fuzz_method_getSlot'),
  getTransactionCount: new Counter('rpc_fuzz_method_getTransactionCount'),
  getBlockTime: new Counter('rpc_fuzz_method_getBlockTime'),
  getBlocks: new Counter('rpc_fuzz_method_getBlocks'),
  getBlocksWithLimit: new Counter('rpc_fuzz_method_getBlocksWithLimit'),
  getFirstAvailableBlock: new Counter('rpc_fuzz_method_getFirstAvailableBlock'),
  getTransactionsForAddress: new Counter('rpc_fuzz_method_getTransactionsForAddress'),
};

const methodMetrics = {
  getSignaturesForAddress: buildMethodMetrics('getSignaturesForAddress'),
  getSignatureStatuses: buildMethodMetrics('getSignatureStatuses'),
  getTransaction: buildMethodMetrics('getTransaction'),
  getBlock: buildMethodMetrics('getBlock'),
  getBlockHeight: buildMethodMetrics('getBlockHeight'),
  getSlot: buildMethodMetrics('getSlot'),
  getTransactionCount: buildMethodMetrics('getTransactionCount'),
  getBlockTime: buildMethodMetrics('getBlockTime'),
  getBlocks: buildMethodMetrics('getBlocks'),
  getBlocksWithLimit: buildMethodMetrics('getBlocksWithLimit'),
  getFirstAvailableBlock: buildMethodMetrics('getFirstAvailableBlock'),
  getTransactionsForAddress: buildMethodMetrics('getTransactionsForAddress'),
};

let debugFailuresLogged = 0;

const PARAMS_OMIT = Symbol('params_omit');

const METHODS = [
  { name: 'getSignaturesForAddress', buildParams: fuzzGetSignaturesParams },
  { name: 'getSignatureStatuses', buildParams: fuzzGetSignatureStatusesParams },
  { name: 'getTransaction', buildParams: fuzzGetTransactionParams },
  { name: 'getBlock', buildParams: fuzzGetBlockParams },
  { name: 'getBlockHeight', buildParams: fuzzGetBlockHeightParams },
  { name: 'getSlot', buildParams: fuzzGetSlotParams },
  { name: 'getTransactionCount', buildParams: fuzzGetTransactionCountParams },
  { name: 'getBlockTime', buildParams: fuzzGetBlockTimeParams },
  { name: 'getBlocks', buildParams: fuzzGetBlocksParams },
  { name: 'getBlocksWithLimit', buildParams: fuzzGetBlocksWithLimitParams },
  { name: 'getFirstAvailableBlock', buildParams: fuzzGetFirstAvailableBlockParams },
  { name: 'getTransactionsForAddress', buildParams: fuzzGetTransactionsForAddressParams },
];

const ACTIVE_METHODS = REQUESTED_METHODS.length
  ? METHODS.filter((entry) => REQUESTED_METHODS.includes(entry.name))
  : METHODS;

if (ACTIVE_METHODS.length === 0) {
  throw new Error(
    `FUZZ_METHODS filtered out all methods. Requested: ${REQUESTED_METHODS.join(', ')}`
  );
}

export const options = {
  vus: scenarios.basic.vus,
  duration: scenarios.basic.duration,
  thresholds: {
    rpc_fuzz_no_5xx_rate: ['rate>0.99'],
    rpc_fuzz_json_ok_rate: ['rate>0.95'],
  },
};

export default function () {
  const target = pick(ACTIVE_METHODS);
  methodCounters[target.name].add(1);

  const params = target.buildParams();
  const payload = buildPayload(target.name, params);

  const { response, body } = executeRequest(payload, {
    latencyMetric: fuzzLatency,
  });

  const status = response && typeof response.status === 'number' ? response.status : 0;
  const no5xx = status > 0 && status < 500;
  const jsonOk = body !== null;
  const hasRpcError = !!(body && body.error);

  recordRpcErrorCode(target.name, body);
  maybeLogFailure(target.name, payload, response, body, no5xx, jsonOk);
  recordMethodMetrics(target.name, response, no5xx, jsonOk, hasRpcError);

  fuzzNo5xxRate.add(no5xx);
  fuzzJsonOkRate.add(jsonOk);

  if (!no5xx) {
    fuzzServerErrors.add(1);
  }
  if (!jsonOk) {
    fuzzNonJson.add(1);
  }
}

export function handleSummary(data) {
  const summary = {
    testType: 'fuzz-params',
    timestamp: new Date().toISOString(),
    config: {
      rpcUrl: config.rpcUrl,
      vus: scenarios.basic.vus,
      duration: scenarios.basic.duration,
      validRatio: VALID_RATIO,
      methods: ACTIVE_METHODS.map((entry) => entry.name),
      addressPoolSize: addressPool.length,
      signaturePoolSize: signaturePool.length,
      slotPoolSize: slotPool.length,
    },
    metrics: {
      requests: {
        total: data.metrics.rpc_requests_total?.values?.count || 0,
        successful: data.metrics.rpc_requests_success?.values?.count || 0,
        failed: data.metrics.http_req_failed?.values?.passes || 0,
      },
      latency: {
        avg: data.metrics.rpc_fuzz_latency?.values?.avg || 0,
        p95: data.metrics.rpc_fuzz_latency?.values['p(95)'] || 0,
        p99: data.metrics.rpc_fuzz_latency?.values['p(99)'] || 0,
        max: data.metrics.rpc_fuzz_latency?.values?.max || 0,
      },
      errors: {
        http: data.metrics.rpc_errors_http?.values?.count || 0,
        rpc: data.metrics.rpc_errors_rpc?.values?.count || 0,
        timeout: data.metrics.rpc_errors_timeout?.values?.count || 0,
        server: data.metrics.rpc_fuzz_server_errors?.values?.count || 0,
        nonJson: data.metrics.rpc_fuzz_non_json?.values?.count || 0,
      },
      rpcErrorCodes: buildRpcErrorCodeSummary(
        data.metrics.rpc_fuzz_rpc_error_code_count
      ),
      fuzzRates: {
        no5xx: data.metrics.rpc_fuzz_no_5xx_rate?.values?.rate || 0,
        jsonOk: data.metrics.rpc_fuzz_json_ok_rate?.values?.rate || 0,
      },
      methods: buildMethodSummary(data),
      responseSize: {
        avg: data.metrics.rpc_response_size?.values?.avg || 0,
        max: data.metrics.rpc_response_size?.values?.max || 0,
      },
    },
  };

  addDownstreamMetrics(data, summary.metrics);

  return {
    stdout: JSON.stringify(summary, null, 2) + '\n',
  };
}

function buildPayload(method, params) {
  const request = {
    jsonrpc: '2.0',
    id: randomId(),
    method,
  };
  if (params !== PARAMS_OMIT) {
    request.params = params;
  }
  return JSON.stringify(request);
}

function fuzzGetSignaturesParams() {
  if (chance(VALID_RATIO)) {
    const options = {};
    if (chance(0.6)) {
      options.limit = pick([1, 5, 10, 25, 50, config.limit]);
    }
    if (chance(0.3)) {
      options.before = randomSignature();
    }
    if (chance(0.3)) {
      options.until = randomSignature();
    }
    return Object.keys(options).length ? [randomAddress(), options] : [randomAddress()];
  }

  const invalidCases = [
    PARAMS_OMIT,
    [],
    [null],
    [123],
    [''],
    [randomInvalidBase58(32)],
    [randomAddress(), { limit: 0 }],
    [randomAddress(), { limit: -1 }],
    [randomAddress(), { limit: 'ten' }],
    [randomAddress(), { before: 123 }],
    [randomAddress(), { until: true }],
    [randomAddress(), { commitment: pick(INVALID_COMMITMENTS) }],
    [randomAddress(), { minContextSlot: -5 }],
    [randomAddress(), []],
    [randomAddress(), 'not-an-object'],
  ];
  return pick(invalidCases);
}

function fuzzGetSignatureStatusesParams() {
  if (chance(VALID_RATIO)) {
    const batchSize = randomInt(1, Math.min(10, signaturePool.length));
    const signatures = randomSignatures(batchSize);
    const options = chance(0.4)
      ? { searchTransactionHistory: chance(0.5) }
      : null;
    return options ? [signatures, options] : [signatures];
  }

  const tooMany = randomSignatures(260);
  const invalidCases = [
    PARAMS_OMIT,
    [],
    [null],
    ['not-an-array'],
    [[]],
    [[123]],
    [[randomSignature(), null, 99]],
    [tooMany],
    [randomSignatures(3), { searchTransactionHistory: 'yes' }],
    [randomSignatures(2), 'not-an-object'],
  ];
  return pick(invalidCases);
}

function fuzzGetTransactionParams() {
  if (chance(VALID_RATIO)) {
    const options = {};
    if (chance(0.6)) {
      options.encoding = pick(VALID_ENCODINGS);
    }
    if (chance(0.4)) {
      options.commitment = pick(VALID_COMMITMENTS);
    }
    if (chance(0.3)) {
      options.maxSupportedTransactionVersion = pick([0, 1]);
    }
    return Object.keys(options).length ? [randomSignature(), options] : [randomSignature()];
  }

  const invalidCases = [
    PARAMS_OMIT,
    [],
    [null],
    [123],
    [''],
    [randomInvalidBase58(64)],
    [randomSignature(), { encoding: pick(INVALID_ENCODINGS) }],
    [randomSignature(), { commitment: pick(INVALID_COMMITMENTS) }],
    [randomSignature(), { maxSupportedTransactionVersion: -1 }],
    [randomSignature(), { maxSupportedTransactionVersion: '1' }],
    [randomSignature(), 'not-an-object'],
  ];
  return pick(invalidCases);
}

function fuzzGetBlockParams() {
  if (chance(VALID_RATIO)) {
    const options = {};
    if (chance(0.6)) {
      options.encoding = pick(VALID_ENCODINGS);
    }
    if (chance(0.6)) {
      options.transactionDetails = pick(VALID_BLOCK_DETAILS);
    }
    if (chance(0.3)) {
      options.rewards = chance(0.5);
    }
    if (chance(0.4)) {
      options.commitment = pick(VALID_COMMITMENTS);
    }
    if (chance(0.2)) {
      options.maxSupportedTransactionVersion = pick([0, 1]);
    }
    return Object.keys(options).length ? [randomSlot(), options] : [randomSlot()];
  }

  const invalidCases = [
    PARAMS_OMIT,
    [],
    [null],
    ['123'],
    [-1],
    [1.5],
    [randomSlot(), { encoding: pick(INVALID_ENCODINGS) }],
    [randomSlot(), { transactionDetails: pick(INVALID_BLOCK_DETAILS) }],
    [randomSlot(), { rewards: 'yes' }],
    [randomSlot(), { commitment: pick(INVALID_COMMITMENTS) }],
    [randomSlot(), { maxSupportedTransactionVersion: -1 }],
    [randomSlot(), 'not-an-object'],
  ];
  return pick(invalidCases);
}

function fuzzGetBlockHeightParams() {
  if (chance(VALID_RATIO)) {
    // Params are optional for getBlockHeight.
    const options = {};
    if (chance(0.4)) {
      options.commitment = pick(VALID_COMMITMENTS);
    }
    // Keep this at 0 by default so it does not depend on the DB's latest slot.
    if (chance(0.2)) {
      options.minContextSlot = 0;
    }

    const variants = [PARAMS_OMIT, [], [null]];
    if (Object.keys(options).length > 0) {
      variants.push([options]);
    }
    return pick(variants);
  }

  const invalidCases = [
    [123],
    ['not-an-object'],
    [{}, {}],
    [null, null],
    [{ unknown: true }],
    [{ commitment: pick(INVALID_COMMITMENTS) }],
    [{ minContextSlot: -1 }],
    [{ minContextSlot: 'nope' }],
  ];
  return pick(invalidCases);
}

function fuzzGetSlotParams() {
  if (chance(VALID_RATIO)) {
    // Params are optional for getSlot.
    const options = {};
    if (chance(0.4)) {
      options.commitment = pick(VALID_COMMITMENTS);
    }
    // Keep this at 0 by default so it does not depend on the DB's latest slot.
    if (chance(0.2)) {
      options.minContextSlot = 0;
    }

    const variants = [PARAMS_OMIT, [], [null]];
    if (Object.keys(options).length > 0) {
      variants.push([options]);
    }
    return pick(variants);
  }

  const invalidCases = [
    [123],
    ['not-an-object'],
    [{}, {}],
    [null, null],
    [{ unknown: true }],
    [{ commitment: pick(INVALID_COMMITMENTS) }],
    [{ minContextSlot: -1 }],
    [{ minContextSlot: 'nope' }],
  ];
  return pick(invalidCases);
}

function fuzzGetTransactionCountParams() {
  if (chance(VALID_RATIO)) {
    const options = {};
    if (chance(0.4)) {
      options.commitment = pick(VALID_COMMITMENTS);
    }
    if (chance(0.2)) {
      options.minContextSlot = 0;
    }

    const variants = [PARAMS_OMIT, [], [null]];
    if (Object.keys(options).length > 0) {
      variants.push([options]);
    }
    return pick(variants);
  }

  const invalidCases = [
    [123],
    ['not-an-object'],
    [{}, {}],
    [null, null],
    [{ unknown: true }],
    [{ commitment: pick(INVALID_COMMITMENTS) }],
    [{ minContextSlot: -1 }],
    [{ minContextSlot: 'nope' }],
  ];
  return pick(invalidCases);
}

function fuzzGetBlockTimeParams() {
  if (chance(VALID_RATIO)) {
    const options = chance(0.4) ? { commitment: pick(VALID_COMMITMENTS) } : null;
    return options ? [randomSlot(), options] : [randomSlot()];
  }

  const invalidCases = [
    PARAMS_OMIT,
    [],
    [null],
    ['123'],
    [-1],
    [1.25],
    [randomSlot(), { commitment: pick(INVALID_COMMITMENTS) }],
    [randomSlot(), 'not-an-object'],
  ];
  return pick(invalidCases);
}

function fuzzGetBlocksParams() {
  if (chance(VALID_RATIO)) {
    const start = randomSlot();
    const end = start + randomInt(0, 1000);
    const options = chance(0.4) ? { commitment: pick(VALID_COMMITMENTS) } : null;
    if (chance(0.5)) {
      return options ? [start, end, options] : [start, end];
    }
    return options ? [start, options] : [start];
  }

  const start = randomSlot();
  const invalidCases = [
    PARAMS_OMIT,
    [],
    [null],
    ['123'],
    [start, start - 1],
    [start, 'end'],
    [start, start + 600000],
    [start, { commitment: pick(INVALID_COMMITMENTS) }],
    [start, start + 5, 'not-an-object'],
    [start, null, { commitment: pick(INVALID_COMMITMENTS) }],
  ];
  return pick(invalidCases);
}

function fuzzGetBlocksWithLimitParams() {
  if (chance(VALID_RATIO)) {
    const start = randomSlot();
    const limit = randomInt(0, 1000);
    const options = chance(0.4) ? { commitment: pick(VALID_COMMITMENTS) } : null;
    return options ? [start, limit, options] : [start, limit];
  }

  const start = randomSlot();
  const invalidCases = [
    PARAMS_OMIT,
    [],
    [null],
    [start],
    ['123', 10],
    [start, 'ten'],
    [start, 600000],
    [start, { commitment: pick(INVALID_COMMITMENTS) }],
    [start, 5, { commitment: pick(INVALID_COMMITMENTS) }],
    [start, 5, 'not-an-object'],
  ];
  return pick(invalidCases);
}

function fuzzGetFirstAvailableBlockParams() {
  if (chance(VALID_RATIO)) {
    return chance(0.5) ? PARAMS_OMIT : [];
  }

  const invalidCases = [[null], [0], ['unexpected'], [{}]];
  return pick(invalidCases);
}

function fuzzGetTransactionsForAddressParams() {
  if (chance(VALID_RATIO)) {
    const options = {};
    if (chance(0.7)) {
      options.transactionDetails = pick(VALID_TX_DETAILS);
    }
    if (chance(0.5)) {
      options.sortOrder = pick(VALID_SORT_ORDERS);
    }
    if (chance(0.5)) {
      options.limit = pick([1, 5, 10, 25]);
    }
    if (chance(0.3)) {
      options.commitment = pick(VALID_COMMITMENTS);
    }
    if (options.transactionDetails === 'full' && chance(0.4)) {
      options.encoding = pick(VALID_ENCODINGS);
    }
    if (chance(0.2)) {
      options.filters = {
        status: pick(VALID_STATUS),
        tokenAccounts: pick(VALID_TOKEN_ACCOUNTS),
      };
    }
    return Object.keys(options).length ? [randomAddress(), options] : [randomAddress()];
  }

  const invalidCases = [
    PARAMS_OMIT,
    [],
    [null],
    [123],
    [''],
    [randomInvalidBase58(32)],
    [randomAddress(), { transactionDetails: pick(INVALID_TX_DETAILS) }],
    [randomAddress(), { sortOrder: pick(INVALID_SORT_ORDERS) }],
    [randomAddress(), { limit: 0 }],
    [randomAddress(), { limit: -5 }],
    [randomAddress(), { commitment: pick(INVALID_COMMITMENTS) }],
    [randomAddress(), { encoding: pick(INVALID_ENCODINGS) }],
    [randomAddress(), { minContextSlot: -10 }],
    [randomAddress(), { paginationToken: '' }],
    [randomAddress(), { filters: 'not-an-object' }],
    [randomAddress(), { filters: { status: pick(INVALID_STATUS) } }],
    [randomAddress(), { filters: { tokenAccounts: pick(INVALID_TOKEN_ACCOUNTS) } }],
    [randomAddress(), 'not-an-object'],
  ];
  return pick(invalidCases);
}

function randomInvalidBase58(length) {
  const size = length || randomInt(8, 64);
  let result = '';
  for (let i = 0; i < size; i += 1) {
    const useInvalid = chance(0.2);
    const alphabet = useInvalid ? INVALID_BASE58_CHARS : BASE58_ALPHABET;
    result += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  if (!containsInvalidBase58(result)) {
    result =
      result.slice(0, -1) +
      INVALID_BASE58_CHARS[Math.floor(Math.random() * INVALID_BASE58_CHARS.length)];
  }
  return result;
}

function containsInvalidBase58(value) {
  for (let i = 0; i < value.length; i += 1) {
    if (INVALID_BASE58_CHARS.includes(value[i])) {
      return true;
    }
  }
  return false;
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function chance(probability) {
  return Math.random() < probability;
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomId() {
  return Math.floor(Math.random() * 1_000_000_000);
}

function clampRatio(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  if (parsed < 0) {
    return 0;
  }
  if (parsed > 1) {
    return 1;
  }
  return parsed;
}

function parseMethodList(value) {
  if (!value) {
    return [];
  }
  return value
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function buildMethodMetrics(method) {
  return {
    latency: new Trend(`rpc_fuzz_method_${method}_latency`, true),
    no5xxRate: new Rate(`rpc_fuzz_method_${method}_no_5xx_rate`),
    jsonOkRate: new Rate(`rpc_fuzz_method_${method}_json_ok_rate`),
    serverErrors: new Counter(`rpc_fuzz_method_${method}_server_errors`),
    nonJson: new Counter(`rpc_fuzz_method_${method}_non_json`),
    rpcErrors: new Counter(`rpc_fuzz_method_${method}_rpc_errors`),
  };
}

function recordMethodMetrics(method, response, no5xx, jsonOk, hasRpcError) {
  const metrics = methodMetrics[method];
  if (!metrics) {
    return;
  }
  if (response && response.timings && typeof response.timings.duration === 'number') {
    metrics.latency.add(response.timings.duration);
  }
  metrics.no5xxRate.add(no5xx);
  metrics.jsonOkRate.add(jsonOk);
  if (!no5xx) {
    metrics.serverErrors.add(1);
  }
  if (!jsonOk) {
    metrics.nonJson.add(1);
  }
  if (hasRpcError) {
    metrics.rpcErrors.add(1);
  }
}

function recordRpcErrorCode(method, body) {
  if (!body || !body.error || body.error.code === undefined) {
    return;
  }
  const code = String(body.error.code);
  rpcErrorCodeCounter.add(1, { code, method });
  if (DEBUG_RPC_ERRORS) {
    const message = typeof body.error.message === 'string' ? body.error.message : '';
    const detail = message ? ` ${message}` : '';
    console.log(`FUZZ_RPC_ERROR ${method} code=${code}${detail}`);
  }
}

function maybeLogFailure(method, payload, response, body, no5xx, jsonOk) {
  if (!DEBUG_FAILURES || (no5xx && jsonOk)) {
    return;
  }
  if (debugFailuresLogged >= DEBUG_FAILURES_MAX) {
    return;
  }
  debugFailuresLogged += 1;

  const status = response && typeof response.status === 'number' ? response.status : 0;
  const headers = response && response.headers ? response.headers : null;
  const rawBody = response && response.body ? String(response.body) : '';
  const entry = {
    method,
    status,
    jsonOk,
    no5xx,
    payload: truncateString(payload, DEBUG_PAYLOAD_MAX),
    responseBody: jsonOk ? null : truncateString(rawBody, DEBUG_BODY_MAX),
    responseHeaders: headers,
  };
  console.log(`FUZZ_FAILURE ${JSON.stringify(entry)}`);
}

function truncateString(value, maxLength) {
  if (typeof value !== 'string') {
    return value;
  }
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...`;
}

function buildRpcErrorCodeSummary(metric) {
  const summary = { overall: {}, byMethod: {} };
  if (!metric || !metric.submetrics) {
    return summary;
  }
  for (const entry of Object.values(metric.submetrics)) {
    const tags = entry.tags || {};
    const code = tags.code || 'unknown';
    const method = tags.method || 'unknown';
    const count = entry.values?.count || 0;
    summary.overall[code] = (summary.overall[code] || 0) + count;
    const methodCounts = summary.byMethod[method] || {};
    methodCounts[code] = (methodCounts[code] || 0) + count;
    summary.byMethod[method] = methodCounts;
  }
  return summary;
}

function buildMethodSummary(data) {
  return {
    getSignaturesForAddress: summarizeMethodMetrics(data, 'getSignaturesForAddress'),
    getSignatureStatuses: summarizeMethodMetrics(data, 'getSignatureStatuses'),
    getTransaction: summarizeMethodMetrics(data, 'getTransaction'),
    getBlock: summarizeMethodMetrics(data, 'getBlock'),
    getBlockHeight: summarizeMethodMetrics(data, 'getBlockHeight'),
    getSlot: summarizeMethodMetrics(data, 'getSlot'),
    getTransactionCount: summarizeMethodMetrics(data, 'getTransactionCount'),
    getBlockTime: summarizeMethodMetrics(data, 'getBlockTime'),
    getBlocks: summarizeMethodMetrics(data, 'getBlocks'),
    getBlocksWithLimit: summarizeMethodMetrics(data, 'getBlocksWithLimit'),
    getFirstAvailableBlock: summarizeMethodMetrics(data, 'getFirstAvailableBlock'),
    getTransactionsForAddress: summarizeMethodMetrics(
      data,
      'getTransactionsForAddress'
    ),
  };
}

function summarizeMethodMetrics(data, method) {
  const count =
    data.metrics[`rpc_fuzz_method_${method}`]?.values?.count || 0;
  const latency = data.metrics[`rpc_fuzz_method_${method}_latency`]?.values;
  const no5xx = data.metrics[`rpc_fuzz_method_${method}_no_5xx_rate`]?.values;
  const jsonOk = data.metrics[`rpc_fuzz_method_${method}_json_ok_rate`]?.values;
  const serverErrors =
    data.metrics[`rpc_fuzz_method_${method}_server_errors`]?.values?.count || 0;
  const nonJson =
    data.metrics[`rpc_fuzz_method_${method}_non_json`]?.values?.count || 0;
  const rpcErrors =
    data.metrics[`rpc_fuzz_method_${method}_rpc_errors`]?.values?.count || 0;

  return {
    count,
    latency: latency
      ? {
          avg: latency.avg || 0,
          p95: latency['p(95)'] || 0,
          p99: latency['p(99)'] || 0,
          max: latency.max || 0,
        }
      : { avg: 0, p95: 0, p99: 0, max: 0 },
    rates: {
      no5xx: no5xx?.rate || 0,
      jsonOk: jsonOk?.rate || 0,
    },
    errors: {
      server: serverErrors,
      nonJson,
      rpc: rpcErrors,
    },
  };
}
