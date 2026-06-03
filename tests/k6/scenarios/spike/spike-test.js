// SPDX-License-Identifier: AGPL-3.0-only
/*
 * Copyright 2025-2026 Triton One Limited. All rights reserved.
 */

// Spike Test for superbank-rpc getSignaturesForAddress
//
// Purpose: Test system behavior under sudden traffic spikes.
// This test simulates sudden bursts of traffic to verify the system can
// handle spikes and recover gracefully.
//
// Usage:
//   k6 run tests/k6/scenarios/spike/spike-test.js -e RPC_URL=http://localhost:8899
//   k6 run tests/k6/scenarios/spike/spike-test.js -e RPC_URL=http://localhost:8899 -e ADDRESS_FILE=./tests/k6/data/pools/addresses.txt

import { config, scenarios } from '../../lib/config.js';
import { initAddressPool, randomAddress } from '../../lib/addresses.js';
import { getSignaturesForAddress } from '../../lib/rpc.js';
import { addDownstreamMetrics } from '../../lib/summary.js';

// Initialize address pool at module load
const addressPool = initAddressPool();

export const options = {
  scenarios: {
    spike: {
      executor: 'ramping-vus',
      startVUs: 5,
      stages: scenarios.spike.stages,
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    // Moderate thresholds for spike testing
    http_req_failed: [`rate<${config.thresholds.spikeHttpFailRate}`],
    rpc_getSignatures_latency: [`p(95)<${config.thresholds.spikeP95Latency}`],
    rpc_error_rate: ['rate<0.05'], // Allow up to 5% RPC errors during spikes
  },
};

export default function () {
  const address = randomAddress();
  getSignaturesForAddress(address);
}

export function handleSummary(data) {
  const summary = {
    testType: 'spike',
    timestamp: new Date().toISOString(),
    config: {
      rpcUrl: config.rpcUrl,
      limit: config.limit,
      addressPoolSize: addressPool.length,
    },
    metrics: {
      requests: {
        total: data.metrics.rpc_requests_total?.values?.count || 0,
        successful: data.metrics.rpc_requests_success?.values?.count || 0,
        failed: data.metrics.http_req_failed?.values?.passes || 0,
      },
      latency: {
        avg: data.metrics.rpc_getSignatures_latency?.values?.avg || 0,
        p95: data.metrics.rpc_getSignatures_latency?.values['p(95)'] || 0,
        p99: data.metrics.rpc_getSignatures_latency?.values['p(99)'] || 0,
        max: data.metrics.rpc_getSignatures_latency?.values?.max || 0,
      },
      errors: {
        http: data.metrics.rpc_errors_http?.values?.count || 0,
        rpc: data.metrics.rpc_errors_rpc?.values?.count || 0,
        timeout: data.metrics.rpc_errors_timeout?.values?.count || 0,
      },
      signatures: {
        avg: data.metrics.rpc_signatures_count?.values?.avg || 0,
        max: data.metrics.rpc_signatures_count?.values?.max || 0,
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
