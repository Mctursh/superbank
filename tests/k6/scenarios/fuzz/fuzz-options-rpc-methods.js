// SPDX-License-Identifier: AGPL-3.0-only
/*
 * Copyright 2025-2026 Triton One Limited. All rights reserved.
 */

// Assumptions:
// - Enumerated option values are fully covered; numeric ranges are sampled at boundaries.
// - Input pools are representative; failures may reflect missing data, not invalid options.
//
// Usage:
//   k6 run tests/k6/scenarios/fuzz/fuzz-options-rpc-methods.js -e RPC_URL=http://localhost:8899
//   k6 run tests/k6/scenarios/fuzz/fuzz-options-rpc-methods.js -e RPC_URL=http://localhost:8899 -e FUZZ_OPTIONS_METHODS=getBlock,getTransaction
//   k6 run tests/k6/scenarios/fuzz/fuzz-options-rpc-methods.js -e RPC_URL=http://localhost:8899 -e FUZZ_OPTIONS_MAX_CASES=500
//   k6 run tests/k6/scenarios/fuzz/fuzz-options-rpc-methods.js -e RPC_URL=http://localhost:8899 -e FUZZ_OPTIONS_LOG_DOWNSTREAM=1 -e FUZZ_OPTIONS_LOG_DOWNSTREAM_THRESHOLD_MS=200

import http from 'k6/http';
import { Trend, Counter, Rate } from 'k6/metrics';
import { config } from '../../lib/config.js';
import { initAddressPool } from '../../lib/addresses.js';
import { initSignaturePool } from '../../lib/signatures.js';
import { initSlotPool } from '../../lib/slots.js';
import {
  downstreamClickhouseElapsedMs,
  downstreamReceivedBytes,
  downstreamDecodedBytes,
  downstreamRowsRead,
  downstreamRowsReturned,
  downstreamDataReadBytes,
} from '../../lib/metrics.js';
import { addDownstreamMetrics } from '../../lib/summary.js';
import { parseResponseMetricsHeaders } from '../../lib/rpc.js';
import {
  OFFICIAL_ENUMS,
  assertOfficialMethods,
  assertOfficialOptionKeys,
} from '../../lib/official-rpc-spec.js';

const PARAMS_OMIT = Symbol('params_omit');

const VALID_COMMITMENTS = OFFICIAL_ENUMS.commitment;
const VALID_ENCODINGS = OFFICIAL_ENUMS.encoding;
const VALID_BLOCK_DETAILS = OFFICIAL_ENUMS.transactionDetails;

const REQUESTED_METHODS = parseMethodList(__ENV.FUZZ_OPTIONS_METHODS);
const MAX_CASES = parsePositiveInt(__ENV.FUZZ_OPTIONS_MAX_CASES);
const LOG_LIMIT = parsePositiveInt(__ENV.FUZZ_OPTIONS_LOG_LIMIT, 25);
const VUS = parsePositiveInt(__ENV.FUZZ_OPTIONS_VUS, 1);
const LOG_DOWNSTREAM =
  __ENV.FUZZ_OPTIONS_LOG_DOWNSTREAM === '1' ||
  __ENV.FUZZ_OPTIONS_LOG_DOWNSTREAM === 'true';
const LOG_DOWNSTREAM_MAX = parsePositiveInt(
  __ENV.FUZZ_OPTIONS_LOG_DOWNSTREAM_MAX,
  50
);
const LOG_DOWNSTREAM_THRESHOLD_MS = parseNonNegativeInt(
  __ENV.FUZZ_OPTIONS_LOG_DOWNSTREAM_THRESHOLD_MS,
  0
);
const LOG_DOWNSTREAM_THRESHOLD_BYTES = parseNonNegativeInt(
  __ENV.FUZZ_OPTIONS_LOG_DOWNSTREAM_THRESHOLD_BYTES,
  0
);

assertOfficialMethods(REQUESTED_METHODS);

const addressPool = initAddressPool();
const signaturePool = initSignaturePool();
const slotPool = initSlotPool();

const BASE_ADDRESS = pickPoolValue(addressPool, 0);
const BASE_SIGNATURE = pickPoolValue(signaturePool, 0);
const ALT_SIGNATURE = pickPoolValue(signaturePool, 1, BASE_SIGNATURE);
const BASE_SLOT = pickPoolValue(slotPool, 0);

if (!BASE_ADDRESS || !BASE_SIGNATURE || BASE_SLOT === undefined) {
  throw new Error(
    'Pools are empty. Provide ADDRESS_FILE, SIGNATURE_FILE, and SLOT_FILE for stable fuzz coverage.'
  );
}

const METHODS = [
  { name: 'getSignaturesForAddress', buildCases: buildGetSignaturesForAddressCases },
  { name: 'getSignatureStatuses', buildCases: buildGetSignatureStatusesCases },
  { name: 'getTransaction', buildCases: buildGetTransactionCases },
  { name: 'getBlock', buildCases: buildGetBlockCases },
  { name: 'getBlockHeight', buildCases: buildGetBlockHeightCases },
  { name: 'getSlot', buildCases: buildGetSlotCases },
  { name: 'getTransactionCount', buildCases: buildGetTransactionCountCases },
  { name: 'getBlockTime', buildCases: buildGetBlockTimeCases },
  { name: 'getBlocks', buildCases: buildGetBlocksCases },
  { name: 'getBlocksWithLimit', buildCases: buildGetBlocksWithLimitCases },
  { name: 'getFirstAvailableBlock', buildCases: buildGetFirstAvailableBlockCases },
  { name: 'getInflationReward', buildCases: buildGetInflationRewardCases },
];

const ACTIVE_METHODS = REQUESTED_METHODS.length
  ? METHODS.filter((entry) => REQUESTED_METHODS.includes(entry.name))
  : METHODS;

if (ACTIVE_METHODS.length === 0) {
  throw new Error(
    `FUZZ_OPTIONS_METHODS filtered out all methods. Requested: ${REQUESTED_METHODS.join(', ')}`
  );
}

let cases = [];
let caseId = 0;
for (const method of ACTIVE_METHODS) {
  const methodCases = method.buildCases();
  for (const entry of methodCases) {
    cases.push({
      id: caseId,
      method: method.name,
      params: entry.params,
      expectJson: entry.expectJson !== false,
      allowedRpcErrors: entry.allowedRpcErrors || null,
      note: entry.note || null,
    });
    caseId += 1;
  }
}

if (MAX_CASES && MAX_CASES > 0 && cases.length > MAX_CASES) {
  cases = cases.slice(0, MAX_CASES);
}

if (cases.length === 0) {
  throw new Error('No fuzz cases generated.');
}

if (VUS > 1) {
  console.log(
    `FUZZ_OPTIONS_VUS=${VUS}. Case order may repeat; set FUZZ_OPTIONS_VUS=1 for full coverage.`
  );
}

export const options = {
  vus: VUS,
  iterations: cases.length,
  thresholds: {
    rpc_fuzz_options_no_5xx_rate: ['rate>0.99'],
    rpc_fuzz_options_json_expected_rate: ['rate>0.95'],
  },
};

const fuzzLatency = new Trend('rpc_fuzz_options_latency', true);
const fuzzNo5xxRate = new Rate('rpc_fuzz_options_no_5xx_rate');
const fuzzJsonExpectedRate = new Rate('rpc_fuzz_options_json_expected_rate');
const fuzzFailures = new Counter('rpc_fuzz_options_failures');
const fuzzSuccesses = new Counter('rpc_fuzz_options_success');
const fuzzRpcErrors = new Counter('rpc_fuzz_options_rpc_errors');
const fuzzExpectedRpcErrors = new Counter('rpc_fuzz_options_expected_rpc_errors');
const fuzzNonJson = new Counter('rpc_fuzz_options_non_json');
const fuzzServerErrors = new Counter('rpc_fuzz_options_server_errors');
const fuzzExpectedNonJson = new Counter('rpc_fuzz_options_expected_non_json');
const fuzzDownstreamElapsedByCase = new Trend(
  'rpc_fuzz_options_downstream_elapsed_ms',
  true
);
const fuzzDownstreamReceivedByCase = new Trend(
  'rpc_fuzz_options_downstream_received_bytes',
  true
);
const fuzzDownstreamDecodedByCase = new Trend(
  'rpc_fuzz_options_downstream_decoded_bytes',
  true
);
const fuzzDownstreamRowsReadByCase = new Trend(
  'rpc_fuzz_options_downstream_rows_read'
);
const fuzzDownstreamRowsReturnedByCase = new Trend(
  'rpc_fuzz_options_downstream_rows_returned'
);
const fuzzDownstreamDataReadBytesByCase = new Trend(
  'rpc_fuzz_options_downstream_data_read_bytes'
);
const fuzzDownstreamMissingByCase = new Counter(
  'rpc_fuzz_options_downstream_missing'
);

const methodCounters = buildMethodCounters('rpc_fuzz_options_method');
const methodFailureCounters = buildMethodCounters('rpc_fuzz_options_method_failures');

let loggedFailures = 0;
let loggedDownstream = 0;
const TOP_N = parsePositiveInt(__ENV.FUZZ_OPTIONS_TOP_N, 10);
const caseById = new Map(cases.map((entry) => [String(entry.id), entry]));

export default function () {
  const index = selectCaseIndex(__ITER, __VU, cases.length);
  const testCase = cases[index];
  methodCounters[testCase.method].add(1);

  const payload = buildPayload(testCase.method, testCase.params);
  const { response, body } = executeRpc(payload);
  const downstream = parseResponseMetricsHeaders(response);
  recordDownstreamByCase(testCase, downstream);

  const status = response && typeof response.status === 'number' ? response.status : 0;
  const no5xx = status > 0 && status < 500;
  const jsonOk = body !== null;
  const hasRpcError = !!(body && body.error);
  const expectJson = testCase.expectJson;
  const allowedRpcError = isAllowedRpcError(testCase, body);

  fuzzLatency.add(response.timings.duration);
  fuzzNo5xxRate.add(no5xx);
  if (expectJson) {
    fuzzJsonExpectedRate.add(jsonOk);
  } else {
    fuzzExpectedNonJson.add(1);
  }

  if (!jsonOk) {
    fuzzNonJson.add(1);
  }
  if (!no5xx) {
    fuzzServerErrors.add(1);
  }
  if (hasRpcError && allowedRpcError) {
    fuzzExpectedRpcErrors.add(1);
  } else if (hasRpcError) {
    fuzzRpcErrors.add(1);
  }

  const success =
    status === 200 &&
    (!hasRpcError || allowedRpcError) &&
    (expectJson ? jsonOk : true);

  if (success) {
    fuzzSuccesses.add(1);
  } else {
    fuzzFailures.add(1);
    methodFailureCounters[testCase.method].add(1);
    maybeLogFailure(testCase, response, body);
  }
}

export function handleSummary(data) {
  const summary = {
    testType: 'fuzz-options',
    timestamp: new Date().toISOString(),
    config: {
      rpcUrl: config.rpcUrl,
      rpcUrls: config.rpcUrls,
      vus: VUS,
      iterations: cases.length,
      methods: ACTIVE_METHODS.map((entry) => entry.name),
      maxCases: MAX_CASES || null,
      logLimit: LOG_LIMIT,
      pools: {
        addresses: addressPool.length,
        signatures: signaturePool.length,
        slots: slotPool.length,
      },
    },
    metrics: {
      results: {
        success: data.metrics.rpc_fuzz_options_success?.values?.count || 0,
        failures: data.metrics.rpc_fuzz_options_failures?.values?.count || 0,
        rpcErrors: data.metrics.rpc_fuzz_options_rpc_errors?.values?.count || 0,
        expectedRpcErrors:
          data.metrics.rpc_fuzz_options_expected_rpc_errors?.values?.count || 0,
        nonJson: data.metrics.rpc_fuzz_options_non_json?.values?.count || 0,
        serverErrors: data.metrics.rpc_fuzz_options_server_errors?.values?.count || 0,
        expectedNonJson: data.metrics.rpc_fuzz_options_expected_non_json?.values?.count || 0,
      },
      rates: {
        no5xx: data.metrics.rpc_fuzz_options_no_5xx_rate?.values?.rate || 0,
        jsonExpected:
          data.metrics.rpc_fuzz_options_json_expected_rate?.values?.rate || 0,
      },
      latency: {
        avg: data.metrics.rpc_fuzz_options_latency?.values?.avg || 0,
        p95: data.metrics.rpc_fuzz_options_latency?.values['p(95)'] || 0,
        p99: data.metrics.rpc_fuzz_options_latency?.values['p(99)'] || 0,
        max: data.metrics.rpc_fuzz_options_latency?.values?.max || 0,
      },
      downstreamByCase: {
        clickhouseElapsedMs: buildTopTrendCases(
          data,
          'rpc_fuzz_options_downstream_elapsed_ms',
          'max',
          TOP_N
        ),
        receivedBytes: buildTopTrendCases(
          data,
          'rpc_fuzz_options_downstream_received_bytes',
          'max',
          TOP_N
        ),
        decodedBytes: buildTopTrendCases(
          data,
          'rpc_fuzz_options_downstream_decoded_bytes',
          'max',
          TOP_N
        ),
        rowsRead: buildTopTrendCases(
          data,
          'rpc_fuzz_options_downstream_rows_read',
          'max',
          TOP_N
        ),
        rowsReturned: buildTopTrendCases(
          data,
          'rpc_fuzz_options_downstream_rows_returned',
          'max',
          TOP_N
        ),
        dataReadBytes: buildTopTrendCases(
          data,
          'rpc_fuzz_options_downstream_data_read_bytes',
          'max',
          TOP_N
        ),
        missingHeader: buildTopCounterCases(
          data,
          'rpc_fuzz_options_downstream_missing',
          TOP_N
        ),
      },
      methods: summarizeMethodCounts(
        data,
        'rpc_fuzz_options_method',
        'rpc_fuzz_options_method_failures'
      ),
    },
  };

  addDownstreamMetrics(data, summary.metrics);

  return {
    stdout: JSON.stringify(summary, null, 2) + '\n',
  };
}

function buildGetSignaturesForAddressCases() {
  const cases = [];

  const limitValues = uniqueValues([
    undefined,
    1,
    config.limit,
    config.limit * 2,
  ]).filter((value) => value === undefined || value > 0);

  const paginationVariants = [
    {},
    { before: BASE_SIGNATURE },
    { until: ALT_SIGNATURE },
    { before: BASE_SIGNATURE, until: ALT_SIGNATURE },
  ];

  const commitmentValues = [undefined, ...VALID_COMMITMENTS];
  const minContextSlots = [undefined, 0];

  for (const limit of limitValues) {
    for (const pagination of paginationVariants) {
      for (const commitment of commitmentValues) {
        for (const minContextSlot of minContextSlots) {
          const options = { ...pagination };
          addOption(options, 'limit', limit);
          addOption(options, 'commitment', commitment);
          addOption(options, 'minContextSlot', minContextSlot);

          const params = Object.keys(options).length
            ? [BASE_ADDRESS, options]
            : [BASE_ADDRESS];

          assertOfficialOptionKeys('getSignaturesForAddress', options);
          cases.push({ params, expectJson: true });
        }
      }
    }
  }
  return cases;
}

function buildGetSignatureStatusesCases() {
  const cases = [];
  const maxBatch = Math.min(256, signaturePool.length);
  const batchSizes = uniqueValues([
    1,
    2,
    config.signatureStatusesBatch,
    maxBatch,
  ]).filter((value) => value > 0);

  const signatureSets = batchSizes.map((size, index) =>
    samplePool(signaturePool, size, index * size)
  );

  const configVariants = [
    undefined,
    { searchTransactionHistory: true },
    { searchTransactionHistory: false },
  ];

  for (const signatures of signatureSets) {
    for (const configVariant of configVariants) {
      const params = configVariant ? [signatures, configVariant] : [signatures];
      if (configVariant) {
        assertOfficialOptionKeys('getSignatureStatuses', configVariant);
      }
      cases.push({ params, expectJson: true });
    }
  }

  if (signatureSets.length > 0) {
    cases.push({
      params: [signatureSets[0], null],
      expectJson: true,
      note: 'null-config',
    });
  }

  return cases;
}

function buildGetTransactionCases() {
  const cases = [];
  const encodingValues = [undefined, ...VALID_ENCODINGS];
  const commitmentValues = [undefined, ...VALID_COMMITMENTS];
  const maxSupportedValues = [undefined, 0, 1];

  cases.push({ params: [BASE_SIGNATURE], expectJson: true });
  cases.push({ params: [BASE_SIGNATURE, null], expectJson: true, note: 'null-config' });

  for (const encoding of encodingValues) {
    for (const commitment of commitmentValues) {
      for (const maxSupported of maxSupportedValues) {
        const options = {};
        addOption(options, 'encoding', encoding);
        addOption(options, 'commitment', commitment);
        addOption(options, 'maxSupportedTransactionVersion', maxSupported);

        if (Object.keys(options).length === 0) {
          continue;
        }

        assertOfficialOptionKeys('getTransaction', options);
        cases.push({ params: [BASE_SIGNATURE, options], expectJson: true });
      }
    }
  }

  return cases;
}

function buildGetBlockCases() {
  const cases = [];
  const encodingValues = [undefined, ...VALID_ENCODINGS];
  const detailValues = [undefined, ...VALID_BLOCK_DETAILS];
  const rewardValues = [undefined, true, false];
  const commitmentValues = [undefined, ...VALID_COMMITMENTS];
  const maxSupportedValues = [undefined, 0, 1];

  cases.push({ params: [BASE_SLOT], expectJson: true });
  cases.push({ params: [BASE_SLOT, null], expectJson: true, note: 'null-config' });

  for (const encoding of encodingValues) {
    for (const transactionDetails of detailValues) {
      for (const rewards of rewardValues) {
        for (const commitment of commitmentValues) {
          for (const maxSupported of maxSupportedValues) {
            const options = {};
            addOption(options, 'encoding', encoding);
            addOption(options, 'transactionDetails', transactionDetails);
            addOption(options, 'rewards', rewards);
            addOption(options, 'commitment', commitment);
            addOption(options, 'maxSupportedTransactionVersion', maxSupported);

            if (Object.keys(options).length === 0) {
              continue;
            }

            assertOfficialOptionKeys('getBlock', options);
            cases.push({ params: [BASE_SLOT, options], expectJson: true });
          }
        }
      }
    }
  }

  return cases;
}

function buildGetBlockHeightCases() {
  const cases = [];

  cases.push({ params: PARAMS_OMIT, expectJson: true });
  cases.push({ params: [], expectJson: true });
  cases.push({ params: [null], expectJson: true, note: 'null-config' });

  const commitmentValues = [undefined, ...VALID_COMMITMENTS];
  const minContextSlots = [undefined, 0];

  for (const commitment of commitmentValues) {
    for (const minContextSlot of minContextSlots) {
      const options = {};
      addOption(options, 'commitment', commitment);
      addOption(options, 'minContextSlot', minContextSlot);

      if (Object.keys(options).length === 0) {
        continue;
      }

      assertOfficialOptionKeys('getBlockHeight', options);
      cases.push({ params: [options], expectJson: true });
    }
  }

  return cases;
}

function buildGetSlotCases() {
  const cases = [];

  cases.push({ params: PARAMS_OMIT, expectJson: true });
  cases.push({ params: [], expectJson: true });
  cases.push({ params: [null], expectJson: true, note: 'null-config' });

  const commitmentValues = [undefined, ...VALID_COMMITMENTS];
  const minContextSlots = [undefined, 0];

  for (const commitment of commitmentValues) {
    for (const minContextSlot of minContextSlots) {
      const options = {};
      addOption(options, 'commitment', commitment);
      addOption(options, 'minContextSlot', minContextSlot);

      if (Object.keys(options).length === 0) {
        continue;
      }

      assertOfficialOptionKeys('getSlot', options);
      cases.push({ params: [options], expectJson: true });
    }
  }

  return cases;
}

function buildGetTransactionCountCases() {
  const cases = [];

  cases.push({ params: PARAMS_OMIT, expectJson: true });
  cases.push({ params: [], expectJson: true });
  cases.push({ params: [null], expectJson: true, note: 'null-config' });

  const commitmentValues = [undefined, ...VALID_COMMITMENTS];
  const minContextSlots = [undefined, 0];

  for (const commitment of commitmentValues) {
    for (const minContextSlot of minContextSlots) {
      const options = {};
      addOption(options, 'commitment', commitment);
      addOption(options, 'minContextSlot', minContextSlot);

      if (Object.keys(options).length === 0) {
        continue;
      }

      assertOfficialOptionKeys('getTransactionCount', options);
      cases.push({ params: [options], expectJson: true });
    }
  }

  return cases;
}

function buildGetBlockTimeCases() {
  return [
    { params: [BASE_SLOT], expectJson: true },
  ];
}

function buildGetBlocksCases() {
  const cases = [];
  const maxRange = 500_000;
  const range = Math.min(
    Number.isFinite(config.blocksRange) ? config.blocksRange : 0,
    maxRange
  );
  const deltaValues = uniqueValues([0, 1, range]).filter((value) => value >= 0);

  const endSlots = deltaValues.map((delta) => BASE_SLOT + delta);

  cases.push({
    params: [BASE_SLOT],
    expectJson: true,
    allowedRpcErrors: [expectedGetBlocksRangeError()],
  });
  cases.push({
    params: [BASE_SLOT, null],
    expectJson: true,
    note: 'null-end',
    allowedRpcErrors: [expectedGetBlocksRangeError()],
  });

  for (const endSlot of endSlots) {
    cases.push({ params: [BASE_SLOT, endSlot], expectJson: true });
  }

  for (const commitment of VALID_COMMITMENTS) {
    const config = { commitment };
    assertOfficialOptionKeys('getBlocks', config);
    cases.push({
      params: [BASE_SLOT, config],
      expectJson: true,
      allowedRpcErrors: [expectedGetBlocksRangeError()],
    });
    cases.push({
      params: [BASE_SLOT, null, config],
      expectJson: true,
      note: 'null-end',
      allowedRpcErrors: [expectedGetBlocksRangeError()],
    });
    for (const endSlot of endSlots) {
      cases.push({
        params: [BASE_SLOT, endSlot, config],
        expectJson: true,
      });
    }
  }

  return cases;
}

function buildGetBlocksWithLimitCases() {
  const cases = [];
  const maxLimit = 500_000;
  const range = Math.min(
    Number.isFinite(config.blocksRange) ? config.blocksRange : 0,
    maxLimit
  );
  const limitValues = uniqueValues([0, 1, range + 1, maxLimit]).filter(
    (value) => value >= 0 && value <= maxLimit
  );

  for (const limit of limitValues) {
    cases.push({ params: [BASE_SLOT, limit], expectJson: true });
  }

  cases.push({
    params: [BASE_SLOT, 1, null],
    expectJson: true,
    note: 'null-config',
  });

  for (const commitment of VALID_COMMITMENTS) {
    const methodConfig = { commitment };
    assertOfficialOptionKeys('getBlocksWithLimit', methodConfig);
    for (const limit of limitValues) {
      cases.push({
        params: [BASE_SLOT, limit, methodConfig],
        expectJson: true,
      });
    }
  }

  return cases;
}

function expectedGetBlocksRangeError() {
  return {
    code: -32602,
    messageIncludes: 'end_slot must be no more than',
  };
}

function isAllowedRpcError(testCase, body) {
  if (!body || !body.error) {
    return false;
  }
  const allowed = testCase.allowedRpcErrors || [];
  if (allowed.length === 0) {
    return false;
  }
  const code = body.error.code;
  const message = typeof body.error.message === 'string' ? body.error.message : '';
  return allowed.some((entry) => {
    if (entry.code !== undefined && entry.code !== code) {
      return false;
    }
    if (entry.messageIncludes && !message.includes(entry.messageIncludes)) {
      return false;
    }
    return true;
  });
}

function buildGetFirstAvailableBlockCases() {
  return [
    { params: PARAMS_OMIT, expectJson: true },
    { params: [], expectJson: true },
  ];
}

function buildGetInflationRewardCases() {
  const cases = [];
  const addressSets = [
    [BASE_ADDRESS],
    [BASE_ADDRESS, BASE_ADDRESS],
  ];
  const commitmentValues = [undefined, ...VALID_COMMITMENTS];
  const epochValues = [undefined, 0];
  const minContextSlots = [undefined, 0];

  for (const addresses of addressSets) {
    cases.push({ params: [addresses], expectJson: true });
    cases.push({ params: [addresses, null], expectJson: true, note: 'null-config' });

    for (const commitment of commitmentValues) {
      for (const epoch of epochValues) {
        for (const minContextSlot of minContextSlots) {
          const options = {};
          addOption(options, 'commitment', commitment);
          addOption(options, 'epoch', epoch);
          addOption(options, 'minContextSlot', minContextSlot);

          if (Object.keys(options).length === 0) {
            continue;
          }

          assertOfficialOptionKeys('getInflationReward', options);
          cases.push({ params: [addresses, options], expectJson: true });
        }
      }
    }
  }

  return cases;
}

function executeRpc(payload) {
  const res = http.post(selectRpcUrl(), payload, {
    headers: { 'Content-Type': 'application/json' },
  });

  let body = null;
  try {
    body = res.json();
  } catch (e) {
    // Non-JSON responses should be treated as failures.
  }

  recordDownstreamMetrics(res);
  return { response: res, body };
}

function recordDownstreamMetrics(res) {
  const metrics = parseResponseMetricsHeaders(res);
  if (!metrics) {
    return;
  }
  if (metrics.clickhouseElapsedMs !== null) {
    downstreamClickhouseElapsedMs.add(metrics.clickhouseElapsedMs);
  }
  if (metrics.receivedBytes !== null) {
    downstreamReceivedBytes.add(metrics.receivedBytes);
  }
  if (metrics.decodedBytes !== null) {
    downstreamDecodedBytes.add(metrics.decodedBytes);
  }
  if (metrics.rowsRead !== null) {
    downstreamRowsRead.add(metrics.rowsRead);
  }
  if (metrics.rowsReturned !== null) {
    downstreamRowsReturned.add(metrics.rowsReturned);
  }
  if (metrics.dataReadBytes !== null) {
    downstreamDataReadBytes.add(metrics.dataReadBytes);
  }
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

function addOption(target, key, value) {
  if (value !== undefined) {
    target[key] = value;
  }
}

function selectRpcUrl() {
  const urls = config.rpcUrls;
  if (urls && urls.length > 0) {
    return urls[(__ITER + __VU) % urls.length];
  }
  return config.rpcUrl;
}

function randomId() {
  return Math.floor(Math.random() * 1_000_000_000);
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

function parsePositiveInt(value, fallback = null) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function parseNonNegativeInt(value, fallback = null) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function uniqueValues(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const key = value === undefined ? 'undefined' : String(value);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(value);
  }
  return result;
}

function pickPoolValue(pool, index, fallback = null) {
  if (!pool || pool.length === 0) {
    return fallback;
  }
  const safeIndex = Math.min(Math.max(index, 0), pool.length - 1);
  return pool[safeIndex];
}

function samplePool(pool, count, offset = 0) {
  const results = [];
  if (!pool || pool.length === 0) {
    return results;
  }
  const total = Math.min(Math.max(count, 0), pool.length);
  for (let i = 0; i < total; i += 1) {
    const idx = (offset + i) % pool.length;
    results.push(pool[idx]);
  }
  return results;
}

function selectCaseIndex(iteration, vu, total) {
  if (total <= 1) {
    return 0;
  }
  return (iteration + vu - 1) % total;
}

function buildMethodCounters(prefix) {
  const counters = {};
  for (const method of METHODS.map((entry) => entry.name)) {
    counters[method] = new Counter(`${prefix}_${method}`);
  }
  return counters;
}

function summarizeMethodCounts(data, totalPrefix, failurePrefix) {
  const summary = {};
  for (const method of METHODS.map((entry) => entry.name)) {
    const totalMetric = `${totalPrefix}_${method}`;
    const failureMetric = `${failurePrefix}_${method}`;
    summary[method] = {
      total: data.metrics[totalMetric]?.values?.count || 0,
      failures: data.metrics[failureMetric]?.values?.count || 0,
    };
  }
  return summary;
}

function maybeLogFailure(testCase, response, body) {
  if (LOG_LIMIT <= 0 || loggedFailures >= LOG_LIMIT) {
    return;
  }
  loggedFailures += 1;

  const status = response && typeof response.status === 'number' ? response.status : 0;
  const error = body && body.error ? body.error : null;
  const payload = {
    caseId: testCase.id,
    method: testCase.method,
    params: summarizeValue(testCase.params),
    expectJson: testCase.expectJson,
    status,
    error,
    note: testCase.note,
  };
  console.warn(`fuzz-options failure: ${JSON.stringify(payload)}`);
}

function recordDownstreamByCase(testCase, metrics) {
  const tags = { method: testCase.method, caseId: String(testCase.id) };
  if (!metrics) {
    fuzzDownstreamMissingByCase.add(1, tags);
    return;
  }
  if (metrics.clickhouseElapsedMs !== null) {
    fuzzDownstreamElapsedByCase.add(metrics.clickhouseElapsedMs, tags);
  }
  if (metrics.receivedBytes !== null) {
    fuzzDownstreamReceivedByCase.add(metrics.receivedBytes, tags);
  }
  if (metrics.decodedBytes !== null) {
    fuzzDownstreamDecodedByCase.add(metrics.decodedBytes, tags);
  }
  if (metrics.rowsRead !== null) {
    fuzzDownstreamRowsReadByCase.add(metrics.rowsRead, tags);
  }
  if (metrics.rowsReturned !== null) {
    fuzzDownstreamRowsReturnedByCase.add(metrics.rowsReturned, tags);
  }
  if (metrics.dataReadBytes !== null) {
    fuzzDownstreamDataReadBytesByCase.add(metrics.dataReadBytes, tags);
  }

  if (!LOG_DOWNSTREAM || loggedDownstream >= LOG_DOWNSTREAM_MAX) {
    return;
  }
  const exceedsMs =
    LOG_DOWNSTREAM_THRESHOLD_MS !== null &&
    metrics.clickhouseElapsedMs !== null &&
    metrics.clickhouseElapsedMs >= LOG_DOWNSTREAM_THRESHOLD_MS;
  const exceedsBytes =
    LOG_DOWNSTREAM_THRESHOLD_BYTES !== null &&
    ((metrics.decodedBytes !== null &&
      metrics.decodedBytes >= LOG_DOWNSTREAM_THRESHOLD_BYTES) ||
      (metrics.dataReadBytes !== null &&
        metrics.dataReadBytes >= LOG_DOWNSTREAM_THRESHOLD_BYTES));
  if (!exceedsMs && !exceedsBytes) {
    return;
  }
  loggedDownstream += 1;
  const payload = {
    caseId: testCase.id,
    method: testCase.method,
    clickhouseElapsedMs: metrics.clickhouseElapsedMs,
    receivedBytes: metrics.receivedBytes,
    decodedBytes: metrics.decodedBytes,
    rowsRead: metrics.rowsRead,
    rowsReturned: metrics.rowsReturned,
    dataReadBytes: metrics.dataReadBytes,
    params: summarizeValue(testCase.params),
    note: testCase.note,
  };
  console.log(`fuzz-options downstream: ${JSON.stringify(payload)}`);
}

function buildTopTrendCases(data, metricName, valueKey, limit) {
  const metric = data.metrics[metricName];
  if (!metric || !metric.submetrics) {
    return [];
  }
  const results = [];
  for (const entry of Object.values(metric.submetrics)) {
    const tags = entry.tags || {};
    const caseId = tags.caseId || 'unknown';
    const method = tags.method || 'unknown';
    const values = entry.values || {};
    const value = values[valueKey] || 0;
    results.push(buildCaseSummary(caseId, method, value, valueKey));
  }
  return results
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}

function buildTopCounterCases(data, metricName, limit) {
  const metric = data.metrics[metricName];
  if (!metric || !metric.submetrics) {
    return [];
  }
  const results = [];
  for (const entry of Object.values(metric.submetrics)) {
    const tags = entry.tags || {};
    const caseId = tags.caseId || 'unknown';
    const method = tags.method || 'unknown';
    const count = entry.values?.count || 0;
    results.push(buildCaseSummary(caseId, method, count, 'count'));
  }
  return results.sort((a, b) => b.count - a.count).slice(0, limit);
}

function buildCaseSummary(caseId, method, value, stat) {
  const caseEntry = caseById.get(String(caseId));
  return {
    caseId,
    method,
    value,
    stat,
    count: stat === 'count' ? value : undefined,
    params: caseEntry ? summarizeValue(caseEntry.params) : null,
    note: caseEntry ? caseEntry.note : null,
  };
}

function summarizeValue(value) {
  if (value === PARAMS_OMIT) {
    return '(params omitted)';
  }
  if (Array.isArray(value)) {
    if (value.length <= 3) {
      return value.map((entry) => summarizeValue(entry));
    }
    return {
      arrayLength: value.length,
      sample: value.slice(0, 3).map((entry) => summarizeValue(entry)),
    };
  }
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = summarizeValue(entry);
    }
    return result;
  }
  if (typeof value === 'string') {
    if (value.length > 64) {
      return `${value.slice(0, 61)}...`;
    }
  }
  return value;
}
