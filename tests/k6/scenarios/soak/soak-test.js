// SPDX-License-Identifier: AGPL-3.0-only
/*
 * Copyright 2025-2026 Triton One Limited. All rights reserved.
 */

// Soak/Endurance Test for superbank-rpc getSignaturesForAddress
//
// Purpose: Run extended duration tests to find memory leaks or performance degradation.
// This test maintains a constant load over a long period to identify issues that
// only manifest after sustained usage.
//
// Usage:
//   k6 run tests/k6/scenarios/soak/soak-test.js -e RPC_URL=http://localhost:8899
//   k6 run tests/k6/scenarios/soak/soak-test.js -e RPC_URL=http://localhost:8899 -e DURATION=1h
//   k6 run tests/k6/scenarios/soak/soak-test.js -e RPC_URL=http://localhost:8899 -e SOAK_VUS=30 -e DURATION=2h

import { config, scenarios } from '../../lib/config.js';
import { initAddressPool, randomAddress } from '../../lib/addresses.js';
import { getSignaturesForAddress } from '../../lib/rpc.js';
import { addDownstreamMetrics } from '../../lib/summary.js';

// Initialize address pool at module load
const addressPool = initAddressPool();

export const options = {
  scenarios: {
    soak: {
      executor: 'constant-vus',
      vus: scenarios.soak.vus,
      duration: scenarios.soak.duration,
    },
  },
  thresholds: {
    // Strict thresholds for soak testing - system should be stable
    http_req_failed: [`rate<${config.thresholds.httpFailRate}`],
    rpc_getSignatures_latency: [
      `p(95)<${config.thresholds.p95Latency}`,
      `p(99)<${config.thresholds.p99Latency}`,
    ],
    rpc_error_rate: ['rate<0.01'], // Allow only 1% RPC errors
  },
};

export default function () {
  const address = randomAddress();
  getSignaturesForAddress(address);
}

export function handleSummary(data) {
  const summary = {
    testType: 'soak',
    timestamp: new Date().toISOString(),
    config: {
      rpcUrl: config.rpcUrl,
      limit: config.limit,
      vus: scenarios.soak.vus,
      duration: scenarios.soak.duration,
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
        min: data.metrics.rpc_getSignatures_latency?.values?.min || 0,
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
