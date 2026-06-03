// SPDX-License-Identifier: AGPL-3.0-only
/*
 * Copyright 2025-2026 Triton One Limited. All rights reserved.
 */

// Stress Test for superbank-rpc getSignatureStatuses
//
// Usage:
//   k6 run tests/k6/scenarios/stress/stress-test-get-signature-statuses.js -e RPC_URL=http://localhost:8899 -e SIGNATURE_FILE=./tests/k6/data/pools/signatures.txt

import { config, scenarios } from '../../lib/config.js';
import { initSignaturePool, randomSignatures } from '../../lib/signatures.js';
import { getSignatureStatuses } from '../../lib/rpc.js';
import { addDownstreamMetrics } from '../../lib/summary.js';

const signaturePool = initSignaturePool();

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
    http_req_failed: [`rate<${config.thresholds.stressHttpFailRate}`],
    rpc_getSignatureStatuses_latency: [`p(95)<${config.thresholds.stressP95Latency}`],
    rpc_error_rate: ['rate<0.15'],
  },
};

function buildSignatureStatusesOptions() {
  const options = {};
  if (config.signatureStatusesSearchHistory !== null) {
    options.searchTransactionHistory = config.signatureStatusesSearchHistory;
  }
  return options;
}

export default function () {
  const batchSize = Math.min(256, Math.max(1, config.signatureStatusesBatch));
  const signatures = randomSignatures(batchSize);
  getSignatureStatuses(signatures, buildSignatureStatusesOptions());
}

export function handleSummary(data) {
  const summary = {
    testType: 'stress-get-signature-statuses',
    timestamp: new Date().toISOString(),
    config: {
      rpcUrl: config.rpcUrl,
      signaturePoolSize: signaturePool.length,
      batchSize: Math.min(256, Math.max(1, config.signatureStatusesBatch)),
      searchTransactionHistory: config.signatureStatusesSearchHistory,
    },
    metrics: {
      requests: {
        total: data.metrics.rpc_requests_total?.values?.count || 0,
        successful: data.metrics.rpc_requests_success?.values?.count || 0,
        failed: data.metrics.http_req_failed?.values?.passes || 0,
      },
      latency: {
        avg: data.metrics.rpc_getSignatureStatuses_latency?.values?.avg || 0,
        p95: data.metrics.rpc_getSignatureStatuses_latency?.values['p(95)'] || 0,
        p99: data.metrics.rpc_getSignatureStatuses_latency?.values['p(99)'] || 0,
        max: data.metrics.rpc_getSignatureStatuses_latency?.values?.max || 0,
      },
      errors: {
        http: data.metrics.rpc_errors_http?.values?.count || 0,
        rpc: data.metrics.rpc_errors_rpc?.values?.count || 0,
        timeout: data.metrics.rpc_errors_timeout?.values?.count || 0,
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
