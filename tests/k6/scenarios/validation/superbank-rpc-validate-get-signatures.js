// SPDX-License-Identifier: AGPL-3.0-only
/*
 * Copyright 2025-2026 Triton One Limited. All rights reserved.
 */

// Validation test for superbank-rpc getSignaturesForAddress
//
// Purpose: Compare Superbank RPC responses against a reference RPC.
//
// Usage:
//   k6 run tests/k6/scenarios/validation/superbank-rpc-validate-get-signatures.js \
//     -e RPC_URL=http://localhost:8899 \
//     -e REFERENCE_RPC_URL=https://api.mainnet-beta.solana.com

import { check } from 'k6';
import { config, scenarios } from '../../lib/config.js';
import { initAddressPool, randomAddress } from '../../lib/addresses.js';
import { deepEqual, summarizeJson } from '../../lib/compare.js';
import { executeRequest, makeGetSignaturesRequest } from '../../lib/rpc.js';
import {
  addDownstreamMetrics,
  collectJsonrpcErrorCodeCounts,
  makeJsonrpcErrorCodeThresholds,
} from '../../lib/summary.js';

if (!config.referenceRpcUrl) {
  throw new Error('REFERENCE_RPC_URL is required for validation tests.');
}

const addressPool = initAddressPool();
const logMismatches = __ENV.VALIDATION_LOG_MISMATCHES !== '0';

function extractSignatures(body) {
  const result = body?.result;
  if (!Array.isArray(result)) {
    return null;
  }

  const signatures = [];
  for (const entry of result) {
    if (typeof entry === 'string') {
      signatures.push(entry);
      continue;
    }
    if (entry && typeof entry === 'object' && typeof entry.signature === 'string') {
      signatures.push(entry.signature);
    }
  }

  return signatures;
}

function logMissingSignatures(address, superbankBody, referenceBody) {
  const rpcSignatures = extractSignatures(superbankBody);
  const referenceSignatures = extractSignatures(referenceBody);

  if (!rpcSignatures || !referenceSignatures) {
    return false;
  }

  const rpcSet = new Set(rpcSignatures);
  const missing = referenceSignatures.filter((signature) => !rpcSet.has(signature));

  if (missing.length === 0) {
    return false;
  }

  for (const signature of missing) {
    console.error(`missing_signature=${signature} address=${address}`);
  }

  const delta = referenceSignatures.length - rpcSignatures.length;
  console.error(
    `address=${address} rpc_count=${rpcSignatures.length} reference_count=${referenceSignatures.length} delta=${delta}`
  );

  return true;
}

export const options = {
  vus: scenarios.basic.vus,
  duration: scenarios.basic.duration,
  thresholds: {
    http_req_failed: ['rate==0.0'],
    checks: ['rate==1.0'],
    ...makeJsonrpcErrorCodeThresholds(),
  },
};

export default function () {
  const address = randomAddress();
  const requestId = Math.floor(Math.random() * 1_000_000_000);
  const payload = makeGetSignaturesRequest(address, {}, requestId);

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
    match = deepEqual(superbank.body, reference.body);
  }

  if (!match && basicChecks && logMismatches) {
    const loggedMissing = logMissingSignatures(address, superbank.body, reference.body);
    if (!loggedMissing) {
      console.error(
        `Response mismatch for address ${address} (vu ${__VU}, iter ${__ITER})`
      );
      console.error(`Superbank: ${summarizeJson(superbank.body)}`);
      console.error(`Reference: ${summarizeJson(reference.body)}`);
    }
  }

  check(null, {
    'responses match': () => match,
  });
}

export function handleSummary(data) {
  const jsonrpcCodes = collectJsonrpcErrorCodeCounts(data);
  const summary = {
    testType: 'validate-get-signatures',
    timestamp: new Date().toISOString(),
    config: {
      rpcUrl: config.rpcUrl,
      referenceRpcUrl: config.referenceRpcUrl,
      limit: config.limit,
      vus: scenarios.basic.vus,
      duration: scenarios.basic.duration,
      addressPoolSize: addressPool.length,
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
