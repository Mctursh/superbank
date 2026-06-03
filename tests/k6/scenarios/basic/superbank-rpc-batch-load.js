// SPDX-License-Identifier: AGPL-3.0-only
/*
 * Copyright 2025-2026 Triton One Limited. All rights reserved.
 */

// Basic load test for JSON-RPC batch envelopes.
//
// Purpose: exercise steady-state throughput and ordering for valid
// multi-method JSON-RPC batches.
//
// Usage:
//   k6 run tests/k6/scenarios/basic/superbank-rpc-batch-load.js -e RPC_URL=http://localhost:8899
//   k6 run tests/k6/scenarios/basic/superbank-rpc-batch-load.js -e RPC_URL=http://localhost:8899 -e VUS=10 -e DURATION=60s -e BATCH_SIZE=3

import http from 'k6/http';
import { check } from 'k6';
import { config, scenarios } from '../../lib/config.js';

const batchSize = Math.max(1, Number(__ENV.BATCH_SIZE || 3));

export const options = {
  vus: scenarios.basic.vus,
  duration: scenarios.basic.duration,
  thresholds: {
    http_req_failed: [`rate<${config.thresholds.httpFailRate}`],
    checks: ['rate==1'],
  },
};

function buildPayload() {
  const requests = [];
  for (let i = 0; i < batchSize; i += 1) {
    const id = i + 1;
    // Rotate methods with no required chain data.
    const method =
      i % 3 === 0
        ? 'getSlot'
        : i % 3 === 1
          ? 'getBlockHeight'
          : 'getFirstAvailableBlock';
    requests.push({
      jsonrpc: '2.0',
      id,
      method,
      params: [],
    });
  }
  return JSON.stringify(requests);
}

const payload = buildPayload();

export default function () {
  const response = http.post(config.rpcUrl, payload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: '15s',
  });

  let body = null;
  try {
    body = JSON.parse(response.body);
  } catch (_) {
    body = null;
  }

  check(response, {
    'batch load: status is 200': (r) => r.status === 200,
  });
  check(body, {
    'batch load: response is array': (b) => Array.isArray(b),
    'batch load: response length matches': (b) =>
      Array.isArray(b) && b.length === batchSize,
    'batch load: ids are preserved in order': (b) =>
      Array.isArray(b) &&
      b.length === batchSize &&
      b.every((item, idx) => item && item.id === idx + 1),
    'batch load: all responses contain result': (b) =>
      Array.isArray(b) &&
      b.length === batchSize &&
      b.every((item) => item && item.result !== undefined && item.error === undefined),
  });
}
