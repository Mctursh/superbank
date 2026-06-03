// SPDX-License-Identifier: AGPL-3.0-only
/*
 * Copyright 2025-2026 Triton One Limited. All rights reserved.
 */

// Traffic Replay Test for superbank-rpc
//
// Purpose: Replay HAProxy-compatible CSV request data at configurable speed.
// This test preserves the input request distribution and timing patterns.
//
// Usage:
//   k6 run tests/k6/scenarios/replay/replay-test.js -e RPC_URL=http://localhost:8899 -e LOG_FILE=./tests/k6/data/replay/synthetic-gsfa-replay.csv
//   k6 run tests/k6/scenarios/replay/replay-test.js -e LOG_FILE=./tests/k6/data/replay/synthetic-gsfa-replay.csv -e TRAFFIC_MULTIPLIER=2
//   k6 run tests/k6/scenarios/replay/replay-test.js -e LOG_FILE=./tests/k6/data/replay/synthetic-gsfa-replay.csv -e TRAFFIC_MULTIPLIER=0.5

import { sleep } from 'k6';
import { config } from '../../lib/config.js';
import { getSharedReplayData } from '../../lib/logs.js';
import { getSignaturesForAddress } from '../../lib/rpc.js';
import { addDownstreamMetrics } from '../../lib/summary.js';

// Validate LOG_FILE is provided
if (!config.logFile) {
  throw new Error('LOG_FILE environment variable is required for replay test');
}

// Load replay data once, shared across all VUs
const replayData = getSharedReplayData(config.logFile);
const requests = replayData.requests;

if (requests.length === 0) {
  throw new Error(`No requests found in log file: ${config.logFile}`);
}

// Calculate adjusted duration based on traffic multiplier
const adjustedDuration = replayData.totalDuration / config.trafficMultiplier;
const originalRPS = requests.length / (replayData.totalDuration / 1000);

console.log(`Replay: ${requests.length} requests, ${config.trafficMultiplier}x speed, target ${(originalRPS * config.trafficMultiplier).toFixed(0)} req/s`);

export const options = {
  scenarios: {
    replay: {
      executor: 'shared-iterations',
      vus: Number(__ENV.REPLAY_VUS || 10),
      iterations: requests.length,
      maxDuration: `${Math.ceil(adjustedDuration / 1000) + 60}s`, // Add 60s buffer
    },
  },
  thresholds: {
    http_req_failed: [`rate<${config.thresholds.httpFailRate}`],
    rpc_getSignatures_latency: [`p(95)<${config.thresholds.p95Latency}`],
    rpc_error_rate: ['rate<0.05'],
  },
};

export default function () {
  // Get the next request index atomically
  const idx = __ITER;

  if (idx >= requests.length) {
    return;
  }

  const req = requests[idx];

  // Sleep for the delay (adjusted by traffic multiplier)
  // Delay is in milliseconds, sleep takes seconds
  if (req.delay > 0) {
    const adjustedDelay = req.delay / config.trafficMultiplier / 1000;
    if (adjustedDelay > 0.001) {
      // Only sleep if > 1ms
      sleep(adjustedDelay);
    }
  }

  // Execute the request with original options
  getSignaturesForAddress(req.address, {
    limit: req.options.limit,
    before: req.options.before,
    until: req.options.until,
  });
}

export function handleSummary(data) {
  const targetRPS = originalRPS * config.trafficMultiplier;

  const summary = {
    testType: 'replay',
    timestamp: new Date().toISOString(),
    config: {
      rpcUrl: config.rpcUrl,
      logFile: config.logFile,
      trafficMultiplier: config.trafficMultiplier,
      totalRequests: requests.length,
      originalDurationMs: replayData.totalDuration,
      originalRPS: originalRPS.toFixed(2),
      targetRPS: targetRPS.toFixed(2),
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
      actualRPS: data.metrics.http_reqs?.values?.rate || 0,
    },
  };

  addDownstreamMetrics(data, summary.metrics);

  return {
    stdout: JSON.stringify(summary, null, 2) + '\n',
  };
}
