// SPDX-License-Identifier: AGPL-3.0-only
/*
 * Copyright 2025-2026 Triton One Limited. All rights reserved.
 */

// Validation test for superbank-rpc getTransaction
//
// Purpose: Compare Superbank RPC responses against a reference RPC.
//
// Usage:
//   k6 run tests/k6/scenarios/validation/superbank-rpc-validate-get-transaction.js \
//     -e RPC_URL=http://localhost:8899 \
//     -e REFERENCE_RPC_URL=https://api.mainnet-beta.solana.com \
//     -e SIGNATURE_FILE=./tests/k6/data/pools/signatures.txt

import { check } from 'k6';
import { config, scenarios } from '../../lib/config.js';
import { initSignaturePool, randomSignature } from '../../lib/signatures.js';
import {
  deepEqualWithLogSuperset,
  normalizeGetTransactionResponse,
  summarizeJson,
} from '../../lib/compare.js';
import { executeRequest, makeGetTransactionRequest } from '../../lib/rpc.js';
import {
  addDownstreamMetrics,
  collectJsonrpcErrorCodeCounts,
  makeJsonrpcErrorCodeThresholds,
} from '../../lib/summary.js';

if (!config.referenceRpcUrl) {
  throw new Error('REFERENCE_RPC_URL is required for validation tests.');
}

const signaturePool = initSignaturePool();
const logMismatches = __ENV.VALIDATION_LOG_MISMATCHES !== '0';

export const options = {
  vus: scenarios.basic.vus,
  duration: scenarios.basic.duration,
  thresholds: {
    http_req_failed: ['rate==0.0'],
    checks: ['rate==1.0'],
    ...makeJsonrpcErrorCodeThresholds(),
  },
};

// Some RPC fields are not stable across nodes (or across historic backfills).
// For getTransaction, some nodes differ on whether certain fields are included.
// Normalize those differences away so this validation focuses on the rest of the payload.
function cloneAndNormalizeGetTransactionBody(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return body;
  }

  if (
    body.result === null ||
    body.result === undefined ||
    typeof body.result !== 'object' ||
    Array.isArray(body.result)
  ) {
    return body;
  }

  if (
    body.result.meta === null ||
    body.result.meta === undefined ||
    typeof body.result.meta !== 'object' ||
    Array.isArray(body.result.meta)
  ) {
    return body;
  }

  const meta = { ...body.result.meta };
  if ('costUnits' in meta) {
    delete meta.costUnits;
  }
  // Some nodes return `rewards: null` while others return `rewards: []` when there
  // are no rewards. Treat the empty cases as equivalent.
  if (meta.rewards === null || (Array.isArray(meta.rewards) && meta.rewards.length === 0)) {
    delete meta.rewards;
  }

  return {
    ...body,
    result: {
      ...body.result,
      meta,
    },
  };
}

function buildTransactionOptions() {
  const options = {
    encoding: config.transactionEncoding,
  };
  if (config.transactionCommitment) {
    options.commitment = config.transactionCommitment;
  }
  if (config.maxSupportedTransactionVersion !== null) {
    options.maxSupportedTransactionVersion = config.maxSupportedTransactionVersion;
  }
  return options;
}

export default function () {
  const signature = randomSignature();
  const requestId = Math.floor(Math.random() * 1_000_000_000);
  const payload = makeGetTransactionRequest(signature, buildTransactionOptions(), requestId);

  const superbank = executeRequest(payload, { rpcUrl: config.rpcUrl });
  const reference = executeRequest(payload, {
    rpcUrl: config.referenceRpcUrl,
    recordMetrics: false,
  });

  const basicChecks = check(null, {
    'superbank status is 200': () => superbank.response.status === 200,
    'reference status is 200': () => reference.response.status === 200,
    'superbank response is json': () => superbank.body !== null,
    'reference response is json': () => reference.body !== null,
  });

  let match = false;
  if (basicChecks) {
    const normalizedSuperbank = normalizeGetTransactionResponse(superbank.body);
    const normalizedReference = normalizeGetTransactionResponse(reference.body);
    match = deepEqualWithLogSuperset(normalizedSuperbank, normalizedReference);
  }

  if (!match && basicChecks && logMismatches) {
    const superbankResult = superbank.body?.result;
    const referenceResult = reference.body?.result;

    const superbankMsg = superbankResult?.transaction?.message;
    const referenceMsg = referenceResult?.transaction?.message;

    const superbankMeta = superbankResult?.meta;
    const referenceMeta = referenceResult?.meta;

    const superbankLoaded = superbankMeta?.loadedAddresses;
    const referenceLoaded = referenceMeta?.loadedAddresses;

    const superbankAccountKeysLen = Array.isArray(superbankMsg?.accountKeys)
      ? superbankMsg.accountKeys.length
      : 0;
    const referenceAccountKeysLen = Array.isArray(referenceMsg?.accountKeys)
      ? referenceMsg.accountKeys.length
      : 0;

    const superbankLookupsLen = Array.isArray(superbankMsg?.addressTableLookups)
      ? superbankMsg.addressTableLookups.length
      : 0;
    const referenceLookupsLen = Array.isArray(referenceMsg?.addressTableLookups)
      ? referenceMsg.addressTableLookups.length
      : 0;

    const superbankLoadedWritableLen = Array.isArray(superbankLoaded?.writable)
      ? superbankLoaded.writable.length
      : 0;
    const superbankLoadedReadonlyLen = Array.isArray(superbankLoaded?.readonly)
      ? superbankLoaded.readonly.length
      : 0;
    const referenceLoadedWritableLen = Array.isArray(referenceLoaded?.writable)
      ? referenceLoaded.writable.length
      : 0;
    const referenceLoadedReadonlyLen = Array.isArray(referenceLoaded?.readonly)
      ? referenceLoaded.readonly.length
      : 0;

    console.error(
      `Response mismatch for signature ${signature} (vu ${__VU}, iter ${__ITER})`
    );
    console.error(
      `accountKeys_len superbank=${superbankAccountKeysLen} reference=${referenceAccountKeysLen} addressTableLookups_len superbank=${superbankLookupsLen} reference=${referenceLookupsLen} loadedAddresses_len superbank=${superbankLoadedWritableLen + superbankLoadedReadonlyLen} (w=${superbankLoadedWritableLen},r=${superbankLoadedReadonlyLen}) reference=${referenceLoadedWritableLen + referenceLoadedReadonlyLen} (w=${referenceLoadedWritableLen},r=${referenceLoadedReadonlyLen})`
    );
    console.error(`Superbank: ${summarizeJson(superbank.body)}`);
    console.error(`Reference: ${summarizeJson(reference.body)}`);
  }

  check(null, {
    'responses match': () => match,
  });
}

export function handleSummary(data) {
  const jsonrpcCodes = collectJsonrpcErrorCodeCounts(data);
  const summary = {
    testType: 'validate-get-transaction',
    timestamp: new Date().toISOString(),
    config: {
      rpcUrl: config.rpcUrl,
      referenceRpcUrl: config.referenceRpcUrl,
      vus: scenarios.basic.vus,
      duration: scenarios.basic.duration,
      signaturePoolSize: signaturePool.length,
      encoding: config.transactionEncoding,
      commitment: config.transactionCommitment,
      maxSupportedTransactionVersion: config.maxSupportedTransactionVersion,
    },
    metrics: {
      checks: {
        rate: data.metrics.checks?.values?.rate || 0,
        passed: data.metrics.checks?.values?.passes || 0,
        failed: data.metrics.checks?.values?.fails || 0,
      },
      requests: {
        total: data.metrics.rpc_requests_total?.values?.count || 0,
        successful: data.metrics.rpc_requests_success?.values?.count || 0,
        failed: data.metrics.http_req_failed?.values?.passes || 0,
      },
      errors: {
        http: data.metrics.rpc_errors_http?.values?.count || 0,
        rpc: data.metrics.rpc_errors_rpc?.values?.count || 0,
        timeout: data.metrics.rpc_errors_timeout?.values?.count || 0,
        jsonrpcTotal: jsonrpcCodes.total,
        jsonrpcUntracked: jsonrpcCodes.untracked,
        jsonrpcByCode: jsonrpcCodes.byCode,
      },
    },
  };

  addDownstreamMetrics(data, summary.metrics);

  return {
    stdout: JSON.stringify(summary, null, 2) + '\n',
  };
}
