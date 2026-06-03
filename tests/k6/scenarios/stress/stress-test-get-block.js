// SPDX-License-Identifier: AGPL-3.0-only
/*
 * Copyright 2025-2026 Triton One Limited. All rights reserved.
 */

// Stress Test for superbank-rpc getBlock
//
// Purpose: Ramp up load until the system fails or degrades significantly.
// This test helps find the breaking point of getBlock performance.
//
// Usage:
//   k6 run tests/k6/scenarios/stress/stress-test-get-block.js -e RPC_URL=http://localhost:8899
//   k6 run tests/k6/scenarios/stress/stress-test-get-block.js -e RPC_URL=http://localhost:8899 -e SLOT_FILE=./tests/k6/data/pools/slots.txt

import { config, parseNonNegativeIntEnv, scenarios } from '../../lib/config.js';
import { initSlotPool, randomSlot } from '../../lib/slots.js';
import { getBlock } from '../../lib/rpc.js';
import {
  addDownstreamMetrics,
  collectJsonrpcErrorCodeCounts,
  makeJsonrpcErrorCodeThresholds,
} from '../../lib/summary.js';

// Initialize slot pool at module load
const slotPool = initSlotPool();
const DEBUG_FAILURES =
  __ENV.STRESS_DEBUG_FAILURES === '1' || __ENV.STRESS_DEBUG_FAILURES === 'true';
const DEBUG_FAILURES_MAX = parseNonNegativeIntEnv('STRESS_DEBUG_FAILURES_MAX', 10);
let debugFailuresLogged = 0;

export const options = {
  scenarios: {
    stress: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: scenarios.stress.stages,
      gracefulRampDown: '30s',
    },
  },
  thresholds: {
    // More lenient thresholds for stress testing
    http_req_failed: [`rate<${config.thresholds.stressHttpFailRate}`],
    rpc_getBlock_latency: [`p(95)<${config.thresholds.stressP95Latency}`],
    rpc_error_rate: ['rate<0.15'], // Allow up to 15% RPC errors
    ...makeJsonrpcErrorCodeThresholds(),
  },
};

function buildBlockOptions() {
  const options = {};
  if (config.blockEncoding) {
    options.encoding = config.blockEncoding;
  }
  if (config.blockTransactionDetails) {
    options.transactionDetails = config.blockTransactionDetails;
  }
  if (config.blockRewards !== null) {
    options.rewards = config.blockRewards;
  }
  if (config.blockCommitment) {
    options.commitment = config.blockCommitment;
  }
  if (config.blockMaxSupportedTransactionVersion !== null) {
    options.maxSupportedTransactionVersion = config.blockMaxSupportedTransactionVersion;
  }
  return options;
}

function getHeaderValue(headers, key) {
  if (!headers) {
    return null;
  }
  const value = headers[key] ?? headers[key.toLowerCase()];
  if (value === undefined || value === null) {
    return null;
  }
  return Array.isArray(value) ? value[0] : value;
}

function maybeLogFailure(slot, response, body) {
  if (!DEBUG_FAILURES || debugFailuresLogged >= DEBUG_FAILURES_MAX) {
    return;
  }

  const status = response && typeof response.status === 'number' ? response.status : 0;
  const jsonrpcError = body && body.error ? body.error : null;
  if (status === 200 && jsonrpcError === null) {
    return;
  }

  debugFailuresLogged += 1;

  const entry = {
    slot,
    vu: __VU,
    iter: __ITER,
    status,
    code: jsonrpcError && jsonrpcError.code !== undefined ? jsonrpcError.code : null,
    message:
      jsonrpcError && typeof jsonrpcError.message === 'string'
        ? jsonrpcError.message
        : null,
    superbankSources: getHeaderValue(response?.headers, 'X-Superbank-Sources'),
    superbankMetrics: getHeaderValue(response?.headers, 'X-Superbank-Metrics'),
  };

  console.warn(`STRESS_GET_BLOCK_FAILURE ${JSON.stringify(entry)}`);
}

export default function () {
  const slot = randomSlot();
  const { response, body } = getBlock(slot, buildBlockOptions());
  maybeLogFailure(slot, response, body);
}

export function handleSummary(data) {
  const jsonrpcCodes = collectJsonrpcErrorCodeCounts(data);
  const summary = {
    testType: 'stress-get-block',
    timestamp: new Date().toISOString(),
    config: {
      rpcUrl: config.rpcUrl,
      slotPoolSize: slotPool.length,
      encoding: config.blockEncoding,
      transactionDetails: config.blockTransactionDetails,
      rewards: config.blockRewards,
      commitment: config.blockCommitment,
      maxSupportedTransactionVersion: config.blockMaxSupportedTransactionVersion,
    },
    metrics: {
      requests: {
        total: data.metrics.rpc_requests_total?.values?.count || 0,
        successful: data.metrics.rpc_requests_success?.values?.count || 0,
        failed: data.metrics.http_req_failed?.values?.passes || 0,
      },
      latency: {
        avg: data.metrics.rpc_getBlock_latency?.values?.avg || 0,
        p95: data.metrics.rpc_getBlock_latency?.values['p(95)'] || 0,
        p99: data.metrics.rpc_getBlock_latency?.values['p(99)'] || 0,
        max: data.metrics.rpc_getBlock_latency?.values?.max || 0,
      },
      errors: {
        http: data.metrics.rpc_errors_http?.values?.count || 0,
        rpc: data.metrics.rpc_errors_rpc?.values?.count || 0,
        timeout: data.metrics.rpc_errors_timeout?.values?.count || 0,
        jsonrpcTotal: jsonrpcCodes.total,
        jsonrpcUntracked: jsonrpcCodes.untracked,
        jsonrpcByCode: jsonrpcCodes.byCode,
      },
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
