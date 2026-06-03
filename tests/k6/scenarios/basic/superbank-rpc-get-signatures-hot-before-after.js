// SPDX-License-Identifier: AGPL-3.0-only
/*
 * Copyright 2025-2026 Triton One Limited. All rights reserved.
 */

// Hot address before/after test for superbank-rpc getSignaturesForAddress
//
// Purpose: Measure performance of a specific before/after query shape.
//
// Usage:
//   k6 run tests/k6/scenarios/basic/superbank-rpc-get-signatures-hot-before-after.js \
//     -e RPC_URL=http://localhost:8899 \
//     -e HOT_ADDRESS=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v \
//     -e HOT_BEFORE=<signature> \
//     -e HOT_AFTER=<signature> \
//     -e HOT_LIMIT=1000 \
//     -e HOT_TIMEOUT=180s \
//     -e HOT_BEFORE_AFTER_VUS=1 \
//     -e HOT_BEFORE_AFTER_ITERATIONS=1
//
// Notes:
// - HOT_AFTER maps to the Solana "until" parameter.
// - Both HOT_BEFORE and HOT_AFTER are required to enforce the before/after shape.
// - The scenario caps VUs to iterations so a suite-level VUS does not make
//   this one-shot query invalid.

import { config } from '../../lib/config.js';
import { executeRequest, runChecks } from '../../lib/rpc.js';
import { addDownstreamMetrics } from '../../lib/summary.js';

const hotAddress = __ENV.HOT_ADDRESS || __ENV.ADDRESS ||
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const before = __ENV.HOT_BEFORE || __ENV.BEFORE || '';
const after = __ENV.HOT_AFTER || __ENV.HOT_UNTIL || __ENV.AFTER || __ENV.UNTIL || '';
const hotLimit = Number(__ENV.HOT_LIMIT || __ENV.LIMIT || 1000);
const commitment = __ENV.HOT_COMMITMENT || __ENV.COMMITMENT || '';
const hotTimeout = __ENV.HOT_TIMEOUT || __ENV.RPC_TIMEOUT || '180s';
const iterations = parsePositiveInt(
  __ENV.HOT_BEFORE_AFTER_ITERATIONS || __ENV.HOT_ITERATIONS || __ENV.ITERATIONS,
  1
);
const requestedVus = parsePositiveInt(
  __ENV.HOT_BEFORE_AFTER_VUS || __ENV.HOT_VUS || __ENV.VUS,
  1
);
const vus = Math.min(requestedVus, iterations);
const hotP95 = Number(__ENV.HOT_P95_MS || __ENV.P95_MS || 0);

if (!before || !after) {
  throw new Error('HOT_BEFORE and HOT_AFTER (or HOT_UNTIL) are required.');
}

if (!Number.isFinite(hotLimit) || hotLimit <= 0) {
  throw new Error('HOT_LIMIT must be a positive number.');
}

export const options = {
  vus,
  iterations,
  thresholds: {
    http_req_failed: ['rate==0.0'],
    checks: ['rate==1.0'],
    ...(Number.isFinite(hotP95) && hotP95 > 0
      ? { rpc_getSignatures_latency: [`p(95)<${hotP95}`] }
      : {}),
  },
};

function parsePositiveInt(value, defaultValue) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, got: ${value}`);
  }

  return parsed;
}

function makePayload(address, opts) {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: Math.floor(Math.random() * 1_000_000_000),
    method: 'getSignaturesForAddress',
    params: [address, opts],
  });
}

export default function () {
  if (requestedVus > iterations && __VU === 1 && __ITER === 0) {
    console.log(
      `Capping hot-before-after VUs from ${requestedVus} to ${iterations} because k6 requires VUs <= iterations.`
    );
  }

  const opts = {
    limit: hotLimit,
    before,
    until: after,
  };

  if (commitment) {
    opts.commitment = commitment;
  }

  const payload = makePayload(hotAddress, opts);
  const { response, body, success } = executeRequest(payload, {
    requestOptions: { timeout: hotTimeout },
  });
  const checksPass = runChecks(response, body);

  if (!success || !checksPass) {
    return;
  }
}

export function handleSummary(data) {
  const summary = {
    testType: 'hot-before-after',
    timestamp: new Date().toISOString(),
    config: {
      rpcUrl: config.rpcUrl,
      address: hotAddress,
      before,
      after,
      limit: hotLimit,
      commitment: commitment || null,
      vus,
      iterations,
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
    },
  };

  addDownstreamMetrics(data, summary.metrics);

  return {
    stdout: JSON.stringify(summary, null, 2) + '\n',
  };
}
