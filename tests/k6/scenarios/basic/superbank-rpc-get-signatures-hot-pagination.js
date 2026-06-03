// SPDX-License-Identifier: AGPL-3.0-only
/*
 * Copyright 2025-2026 Triton One Limited. All rights reserved.
 */

// Hot address pagination test for superbank-rpc getSignaturesForAddress
//
// Purpose: Page through a hot address with a fixed LIMIT to measure pagination latency.
//
// Usage:
//   k6 run tests/k6/scenarios/basic/superbank-rpc-get-signatures-hot-pagination.js \
//     -e RPC_URL=http://localhost:8899 \
//     -e HOT_ADDRESS=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v \
//     -e HOT_LIMIT=1000 \
//     -e HOT_MAX_PAGES=50 \
//     -e HOT_TIMEOUT=180s
//
// Notes:
// - For very large accounts (like USDC), consider setting HOT_MAX_PAGES or HOT_MAX_SIGNATURES
//   to keep runtime bounded.
// - HOT_TIMEOUT controls per-request timeout (default 180s).

import { sleep } from 'k6';
import { Counter } from 'k6/metrics';
import { config } from '../../lib/config.js';
import { executeRequest, makeGetSignaturesRequest, runChecks } from '../../lib/rpc.js';
import { addDownstreamMetrics } from '../../lib/summary.js';

const hotAddress = __ENV.HOT_ADDRESS ||
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const hotLimit = Number(__ENV.HOT_LIMIT || __ENV.LIMIT || 1000);
const maxPages = Number(__ENV.HOT_MAX_PAGES || 0);
const maxSignatures = Number(__ENV.HOT_MAX_SIGNATURES || 0);
const sleepMs = Number(__ENV.HOT_SLEEP_MS || 0);
const hotP95 = Number(__ENV.HOT_P95_MS || 0);
const initialBefore = __ENV.HOT_BEFORE || null;
const hotTimeout =
  __ENV.HOT_TIMEOUT || __ENV.RPC_TIMEOUT || '180s';

if (!Number.isFinite(hotLimit) || hotLimit <= 0) {
  throw new Error('HOT_LIMIT must be a positive number.');
}

const pageCounter = new Counter('rpc_hot_pagination_pages');
const signatureCounter = new Counter('rpc_hot_pagination_signatures');

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    http_req_failed: ['rate==0.0'],
    checks: ['rate==1.0'],
    ...(Number.isFinite(hotP95) && hotP95 > 0
      ? { rpc_getSignatures_latency: [`p(95)<${hotP95}`] }
      : {}),
  },
};

export default function () {
  let before = initialBefore;
  let pages = 0;
  let total = 0;
  let lastSignature = null;

  while (true) {
    if (maxPages > 0 && pages >= maxPages) {
      break;
    }
    if (maxSignatures > 0 && total >= maxSignatures) {
      break;
    }

    const options = { limit: hotLimit };
    if (before) {
      options.before = before;
    }

    const payload = makeGetSignaturesRequest(hotAddress, options);
    const { response, body, success } = executeRequest(payload, {
      requestOptions: { timeout: hotTimeout },
    });
    const checksPass = runChecks(response, body);
    if (!success || !checksPass || !body || !Array.isArray(body.result)) {
      break;
    }

    const result = body.result;
    pageCounter.add(1);
    signatureCounter.add(result.length);

    pages += 1;
    total += result.length;

    if (result.length === 0 || result.length < hotLimit) {
      break;
    }

    const tail = result[result.length - 1];
    const signature = typeof tail === 'string' ? tail : tail?.signature;
    if (!signature) {
      break;
    }

    if (signature === lastSignature) {
      console.error('Pagination stalled: repeated last signature.');
      break;
    }

    lastSignature = signature;
    before = signature;

    if (sleepMs > 0) {
      sleep(sleepMs / 1000);
    }
  }
}

export function handleSummary(data) {
  const summary = {
    testType: 'hot-pagination',
    timestamp: new Date().toISOString(),
    config: {
      rpcUrl: config.rpcUrl,
      address: hotAddress,
      limit: hotLimit,
      maxPages,
      maxSignatures,
      sleepMs,
    },
    metrics: {
      requests: {
        total: data.metrics.rpc_requests_total?.values?.count || 0,
        successful: data.metrics.rpc_requests_success?.values?.count || 0,
        failed: data.metrics.http_req_failed?.values?.passes || 0,
      },
      pagination: {
        pages: data.metrics.rpc_hot_pagination_pages?.values?.count || 0,
        signatures: data.metrics.rpc_hot_pagination_signatures?.values?.count || 0,
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
