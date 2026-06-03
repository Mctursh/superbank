// SPDX-License-Identifier: AGPL-3.0-only
/*
 * Copyright 2025-2026 Triton One Limited. All rights reserved.
 */

// Basic Load Test for superbank-rpc getTransaction
//
// Purpose: Quick baseline performance measurement with configurable load.
//
// Usage:
//   k6 run tests/k6/scenarios/basic/superbank-rpc-get-transaction.js -e RPC_URL=http://localhost:8899 -e SIGNATURE_FILE=./tests/k6/data/pools/signatures.txt
//   k6 run tests/k6/scenarios/basic/superbank-rpc-get-transaction.js -e RPC_URL=http://localhost:8899 -e VUS=10 -e DURATION=60s -e SIGNATURE_FILE=./tests/k6/data/pools/signatures.txt

import { config, scenarios } from '../../lib/config.js';
import { initSignaturePool, randomSignature } from '../../lib/signatures.js';
import { getTransaction } from '../../lib/rpc.js';
import { addDownstreamMetrics } from '../../lib/summary.js';

// Initialize signature pool at module load
const signaturePool = initSignaturePool();

export const options = {
  vus: scenarios.basic.vus,
  duration: scenarios.basic.duration,
  thresholds: {
    http_req_failed: [`rate<${config.thresholds.httpFailRate}`],
    rpc_getTransaction_latency: [`p(95)<${config.thresholds.p95Latency}`],
  },
};

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
  getTransaction(signature, buildTransactionOptions());
}

export function handleSummary(data) {
  const summary = {
    testType: 'basic-get-transaction',
    timestamp: new Date().toISOString(),
    config: {
      rpcUrl: config.rpcUrl,
      vus: scenarios.basic.vus,
      duration: scenarios.basic.duration,
      signaturePoolSize: signaturePool.length,
      encoding: config.transactionEncoding,
      commitment: config.transactionCommitment,
      maxSupportedTransactionVersion: config.maxSupportedTransactionVersion,
    },
    metrics: {
      requests: {
        total: data.metrics.rpc_requests_total?.values?.count || 0,
        successful: data.metrics.rpc_requests_success?.values?.count || 0,
        failed: data.metrics.http_req_failed?.values?.passes || 0,
      },
      latency: {
        avg: data.metrics.rpc_getTransaction_latency?.values?.avg || 0,
        p95: data.metrics.rpc_getTransaction_latency?.values['p(95)'] || 0,
        p99: data.metrics.rpc_getTransaction_latency?.values['p(99)'] || 0,
        max: data.metrics.rpc_getTransaction_latency?.values?.max || 0,
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
