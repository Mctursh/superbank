// SPDX-License-Identifier: AGPL-3.0-only
/*
 * Copyright 2025-2026 Triton One Limited. All rights reserved.
 */

// Validation test for superbank-rpc getTransactionCount
//
// Purpose: Compare Superbank RPC responses against a reference RPC.
//
// Usage:
//   k6 run tests/k6/scenarios/validation/superbank-rpc-validate-get-transaction-count.js \
//     -e RPC_URL=http://localhost:8899 \
//     -e REFERENCE_RPC_URL=https://api.mainnet-beta.solana.com

import { check } from 'k6';
import { config, scenarios, transactionCountOptions } from '../../lib/config.js';
import {
  executeRequest,
  makeGetTransactionCountRequest,
} from '../../lib/rpc.js';
import {
  addDownstreamMetrics,
  collectJsonrpcErrorCodeCounts,
  makeJsonrpcErrorCodeThresholds,
} from '../../lib/summary.js';

if (!config.referenceRpcUrl) {
  throw new Error('REFERENCE_RPC_URL is required for validation tests.');
}

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

export default function () {
  const requestId = Math.floor(Math.random() * 1_000_000_000);
  const payload = makeGetTransactionCountRequest(
    transactionCountOptions(),
    requestId
  );

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

  const superbankResult = superbank.body?.result;
  const referenceResult = reference.body?.result;
  const match =
    basicChecks &&
    !superbank.body?.error &&
    !reference.body?.error &&
    typeof superbankResult === 'number' &&
    superbankResult === referenceResult;

  if (!match && basicChecks && logMismatches) {
    console.error(
      `Response mismatch (vu ${__VU}, iter ${__ITER}) superbank=${JSON.stringify(superbank.body)} reference=${JSON.stringify(reference.body)}`
    );
  }

  check(null, {
    'responses match': () => match,
  });
}

export function handleSummary(data) {
  const jsonrpcCodes = collectJsonrpcErrorCodeCounts(data);
  const summary = {
    testType: 'validate-get-transaction-count',
    timestamp: new Date().toISOString(),
    config: {
      rpcUrl: config.rpcUrl,
      referenceRpcUrl: config.referenceRpcUrl,
      vus: scenarios.basic.vus,
      duration: scenarios.basic.duration,
      commitment: config.transactionCountCommitment,
      minContextSlot: config.transactionCountMinContextSlot,
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
