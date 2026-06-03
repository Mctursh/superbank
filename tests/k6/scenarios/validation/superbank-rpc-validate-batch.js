// SPDX-License-Identifier: AGPL-3.0-only
/*
 * Copyright 2025-2026 Triton One Limited. All rights reserved.
 */

// Validation test for JSON-RPC batch semantics in superbank-rpc.
//
// Purpose: verify protocol behavior for batch envelopes, notifications, and
// malformed payloads without requiring a reference RPC node.
//
// Usage:
//   k6 run tests/k6/scenarios/validation/superbank-rpc-validate-batch.js -e RPC_URL=http://localhost:8899

import http from 'k6/http';
import { check } from 'k6';
import { config } from '../../lib/config.js';

const rpcUrl = config.rpcUrl;
const maxBatchSize = Number(__ENV.RPC_MAX_BATCH_SIZE || 64);

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
  },
};

function postJson(payload) {
  return http.post(rpcUrl, JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json' },
    timeout: '15s',
  });
}

function parseBody(response) {
  if (!response.body || response.body.length === 0) {
    return null;
  }
  try {
    return JSON.parse(response.body);
  } catch (_) {
    return null;
  }
}

export default function () {
  // 1) Valid batch and response ordering.
  let response = postJson([
    { jsonrpc: '2.0', id: 1, method: 'getSlot', params: [] },
    { jsonrpc: '2.0', id: 2, method: 'getBlockHeight', params: [] },
  ]);
  let body = parseBody(response);
  check(response, {
    'batch valid: status is 200': (r) => r.status === 200,
  });
  check(body, {
    'batch valid: response is array': (b) => Array.isArray(b),
    'batch valid: 2 responses': (b) => Array.isArray(b) && b.length === 2,
    'batch valid: response order preserved': (b) =>
      Array.isArray(b) && b.length === 2 && b[0].id === 1 && b[1].id === 2,
    'batch valid: results are present': (b) =>
      Array.isArray(b) && b.length === 2 && b[0].result !== undefined && b[1].result !== undefined,
  });

  // 2) Mixed missing-id + normal request.
  response = postJson([
    { jsonrpc: '2.0', method: 'getSlot', params: [] },
    { jsonrpc: '2.0', id: 'keep', method: 'getSlot', params: [] },
  ]);
  body = parseBody(response);
  check(response, {
    'batch mixed missing-id: status is 200': (r) => r.status === 200,
  });
  check(body, {
    'batch mixed missing-id: two responses returned': (b) =>
      Array.isArray(b) && b.length === 2,
    'batch mixed missing-id: ids preserved': (b) =>
      Array.isArray(b) && b.length === 2 && b[0].id === null && b[1].id === 'keep',
  });

  // 3) Missing-id-only batch should return a normal JSON-RPC array response.
  response = postJson([{ jsonrpc: '2.0', method: 'getSlot', params: [] }]);
  body = parseBody(response);
  check(response, {
    'batch missing-id-only: status is 200': (r) => r.status === 200,
  });
  check(body, {
    'batch missing-id-only: array response': (b) => Array.isArray(b),
    'batch missing-id-only: one response': (b) => Array.isArray(b) && b.length === 1,
    'batch missing-id-only: id is null': (b) =>
      Array.isArray(b) && b.length === 1 && b[0].id === null,
  });

  // 4) Empty batch should return invalid request.
  response = postJson([]);
  body = parseBody(response);
  check(response, {
    'batch empty: status is 200': (r) => r.status === 200,
  });
  check(body, {
    'batch empty: code -32600': (b) => b && b.error && b.error.code === -32600,
    'batch empty: id is null': (b) => b && b.id === null,
  });

  // 5) Invalid batch item should yield per-item invalid request.
  response = postJson([
    { jsonrpc: '2.0', id: 10, method: 'getSlot', params: [] },
    123,
  ]);
  body = parseBody(response);
  check(response, {
    'batch invalid item: status is 200': (r) => r.status === 200,
  });
  check(body, {
    'batch invalid item: array response': (b) => Array.isArray(b),
    'batch invalid item: 2 responses': (b) => Array.isArray(b) && b.length === 2,
    'batch invalid item: valid request succeeded': (b) =>
      Array.isArray(b) && b[0] && b[0].id === 10 && b[0].result !== undefined,
    'batch invalid item: invalid request error': (b) =>
      Array.isArray(b) &&
      b[1] &&
      b[1].id === null &&
      b[1].error &&
      b[1].error.code === -32600,
  });

  // 6) Oversized batch should be rejected at envelope level.
  const oversized = [];
  for (let i = 0; i < maxBatchSize + 1; i += 1) {
    oversized.push({ jsonrpc: '2.0', id: i, method: 'getSlot', params: [] });
  }
  response = postJson(oversized);
  body = parseBody(response);
  check(response, {
    'batch oversized: status is 200': (r) => r.status === 200,
  });
  check(body, {
    'batch oversized: code -32600': (b) => b && b.error && b.error.code === -32600,
    'batch oversized: id is null': (b) => b && b.id === null,
  });

  // 7) Parse error.
  response = http.post(rpcUrl, '{"jsonrpc":"2.0"', {
    headers: { 'Content-Type': 'application/json' },
    timeout: '15s',
  });
  body = parseBody(response);
  check(body, {
    'batch parse error: code -32700': (b) => b && b.error && b.error.code === -32700,
    'batch parse error: id is null': (b) => b && b.id === null,
  });

  // 8) Top-level invalid type.
  response = postJson('not-an-object-or-array');
  body = parseBody(response);
  check(body, {
    'batch top-level invalid: code -32600': (b) => b && b.error && b.error.code === -32600,
    'batch top-level invalid: id is null': (b) => b && b.id === null,
  });
}
