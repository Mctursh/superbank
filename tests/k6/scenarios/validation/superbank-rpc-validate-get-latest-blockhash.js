// SPDX-License-Identifier: AGPL-3.0-only
/*
 * Copyright 2025-2026 Triton One Limited. All rights reserved.
 */

// Validation test for superbank-rpc getLatestBlockhash
//
// Purpose: Ensure Superbank returns a usable (non-expired) blockhash by checking it against a
// reference RPC via isBlockhashValid. This matches the method's main client usage: building and
// submitting transactions.
//
// Usage:
//   k6 run tests/k6/scenarios/validation/superbank-rpc-validate-get-latest-blockhash.js \
//     -e RPC_URL=http://localhost:8899 \
//     -e REFERENCE_RPC_URL=https://api.mainnet-beta.solana.com

import { check } from 'k6';
import { config, latestBlockhashOptions, scenarios } from '../../lib/config.js';
import { executeRequest, makeGetLatestBlockhashRequest } from '../../lib/rpc.js';
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

function makeIsBlockhashValidRequest(blockhash, commitment, requestId) {
  const effectiveCommitment = commitment || 'finalized';
  const isBlockhashValidConfig = { commitment: effectiveCommitment };
  return JSON.stringify({
    jsonrpc: '2.0',
    id: requestId,
    method: 'isBlockhashValid',
    params: [blockhash, isBlockhashValidConfig],
  });
}

export default function () {
  const requestId = Math.floor(Math.random() * 1_000_000_000);
  const payload = makeGetLatestBlockhashRequest(
    latestBlockhashOptions(),
    requestId
  );

  const superbank = executeRequest(payload, { rpcUrl: config.rpcUrl });

  const basicChecks = check(null, {
    'superbank status is 200': () => superbank.response.status === 200,
    'superbank response is json': () => superbank.body !== null,
    'superbank has no rpc error': () => superbank.body && !superbank.body.error,
  });

  const blockhash = superbank.body?.result?.value?.blockhash;
  const contextSlot = superbank.body?.result?.context?.slot;
  const lastValid = superbank.body?.result?.value?.lastValidBlockHeight;

  const shapeOk = check(null, {
    'blockhash is string': () => typeof blockhash === 'string' && blockhash.length > 0,
    'context.slot is number': () => typeof contextSlot === 'number',
    'lastValidBlockHeight is number': () => typeof lastValid === 'number',
  });

  let validOnReference = false;
  if (basicChecks && shapeOk) {
    const refPayload = makeIsBlockhashValidRequest(
      blockhash,
      config.latestBlockhashCommitment,
      requestId
    );
    const reference = executeRequest(refPayload, {
      rpcUrl: config.referenceRpcUrl,
      recordMetrics: false,
    });

    validOnReference =
      reference.response.status === 200 &&
      reference.body &&
      !reference.body.error &&
      reference.body.result &&
      reference.body.result.value === true;

    if (!validOnReference && logMismatches) {
      const effectiveCommitment = config.latestBlockhashCommitment || 'finalized';
      console.error(
        `Reference rejected blockhash (vu ${__VU}, iter ${__ITER}) blockhash=${blockhash} commitment=${effectiveCommitment}`
      );
      console.error(`Superbank body: ${JSON.stringify(superbank.body).slice(0, 500)}`);
      console.error(`Reference body: ${JSON.stringify(reference.body).slice(0, 500)}`);
    }
  }

  check(null, {
    'blockhash valid on reference': () => validOnReference,
  });

  // Basic minContextSlot compliance check with a value that should never be reached mid-iteration.
  // This keeps the assertion stable even if slots advance during the test.
  if (basicChecks && shapeOk) {
    const unreachable = contextSlot + 1_000_000;
    const errorPayload = makeGetLatestBlockhashRequest(
      { minContextSlot: unreachable },
      requestId + 1
    );
    const errResp = executeRequest(errorPayload, { rpcUrl: config.rpcUrl });
    const code = errResp.body?.error?.code;
    check(null, {
      'minContextSlot returns -32016': () => code === -32016,
    });
  }
}

export function handleSummary(data) {
  const jsonrpcCodes = collectJsonrpcErrorCodeCounts(data);
  const summary = {
    testType: 'validate-get-latest-blockhash',
    timestamp: new Date().toISOString(),
    config: {
      rpcUrl: config.rpcUrl,
      referenceRpcUrl: config.referenceRpcUrl,
      vus: scenarios.basic.vus,
      duration: scenarios.basic.duration,
      commitment: config.latestBlockhashCommitment,
      minContextSlot: config.latestBlockhashMinContextSlot,
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
