// SPDX-License-Identifier: AGPL-3.0-only
/*
 * Copyright 2025-2026 Triton One Limited. All rights reserved.
 */

// Validation + latency comparison test for superbank-rpc getTransactionsForAddress
//
// Purpose: Compare two endpoints that both implement getTransactionsForAddress,
// validate response parity, and report which one is faster.
//
// Usage:
//   k6 run tests/k6/scenarios/validation/superbank-rpc-validate-get-transactions-for-address.js \
//     -e RPC_URL=http://localhost:8899 \
//     -e REFERENCE_RPC_URL=http://localhost:8898 \
//     -e ADDRESS_FILE=./tests/k6/data/pools/addresses.txt

import { check } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import {
  config,
  scenarios,
  transactionsForAddressOptions,
} from '../../lib/config.js';
import { initAddressPool, randomAddress } from '../../lib/addresses.js';
import {
  deepEqualWithLogSuperset,
  normalizeGetTransactionsForAddressResponse,
  summarizeJson,
} from '../../lib/compare.js';
import {
  executeRequest,
  makeGetTransactionsForAddressRequest,
} from '../../lib/rpc.js';

if (!config.referenceRpcUrl) {
  throw new Error('REFERENCE_RPC_URL is required for validation tests.');
}

const addressPool = initAddressPool();
const logMismatches = __ENV.VALIDATION_LOG_MISMATCHES !== '0';

const primaryLatency = new Trend('tfa_compare_primary_latency_ms', true);
const referenceLatency = new Trend('tfa_compare_reference_latency_ms', true);
const latencyDelta = new Trend('tfa_compare_latency_delta_ms', true);

const primaryRequests = new Counter('tfa_compare_primary_requests_total');
const primarySuccessful = new Counter('tfa_compare_primary_success_total');
const primaryHttpErrors = new Counter('tfa_compare_primary_http_errors_total');
const primaryNonJson = new Counter('tfa_compare_primary_non_json_total');
const primaryRpcErrors = new Counter('tfa_compare_primary_rpc_errors_total');
const primaryUnsupportedMethod = new Counter(
  'tfa_compare_primary_unsupported_method_total'
);
const primarySlow = new Counter('tfa_compare_primary_slow_total');

const referenceRequests = new Counter('tfa_compare_reference_requests_total');
const referenceSuccessful = new Counter('tfa_compare_reference_success_total');
const referenceHttpErrors = new Counter('tfa_compare_reference_http_errors_total');
const referenceNonJson = new Counter('tfa_compare_reference_non_json_total');
const referenceRpcErrors = new Counter('tfa_compare_reference_rpc_errors_total');
const referenceUnsupportedMethod = new Counter(
  'tfa_compare_reference_unsupported_method_total'
);
const referenceSlow = new Counter('tfa_compare_reference_slow_total');

const comparisonsCompared = new Counter('tfa_compare_compared_total');
const comparisonsSkipped = new Counter('tfa_compare_skipped_total');
const comparisonsMatched = new Counter('tfa_compare_matches_total');
const comparisonsMismatched = new Counter('tfa_compare_mismatches_total');
const comparisonMatchRate = new Rate('tfa_compare_match_rate');
const primaryFaster = new Counter('tfa_compare_primary_faster_total');
const referenceFaster = new Counter('tfa_compare_reference_faster_total');
const comparisonTies = new Counter('tfa_compare_ties_total');

let unsupportedLogged = false;

export const options = {
  vus: scenarios.basic.vus,
  duration: scenarios.basic.duration,
  thresholds: {
    http_req_failed: ['rate==0.0'],
    checks: ['rate==1.0'],
  },
};

function endpointMetrics(kind) {
  if (kind === 'primary') {
    return {
      latency: primaryLatency,
      requests: primaryRequests,
      successful: primarySuccessful,
      httpErrors: primaryHttpErrors,
      nonJson: primaryNonJson,
      rpcErrors: primaryRpcErrors,
      unsupportedMethod: primaryUnsupportedMethod,
      slow: primarySlow,
    };
  }

  return {
    latency: referenceLatency,
    requests: referenceRequests,
    successful: referenceSuccessful,
    httpErrors: referenceHttpErrors,
    nonJson: referenceNonJson,
    rpcErrors: referenceRpcErrors,
    unsupportedMethod: referenceUnsupportedMethod,
    slow: referenceSlow,
  };
}

function recordEndpointMetrics(kind, result) {
  const metrics = endpointMetrics(kind);
  metrics.requests.add(1);

  const duration = result?.response?.timings?.duration;
  if (typeof duration === 'number' && Number.isFinite(duration)) {
    metrics.latency.add(duration);
    if (duration > config.slowRequestThreshold) {
      metrics.slow.add(1);
    }
  }

  const status = result?.response?.status;
  if (status !== 200) {
    metrics.httpErrors.add(1);
    return;
  }

  if (result.body === null) {
    metrics.nonJson.add(1);
    return;
  }

  if (result.body.error) {
    metrics.rpcErrors.add(1);
    if (result.body.error.code === -32601) {
      metrics.unsupportedMethod.add(1);
    }
    return;
  }

  metrics.successful.add(1);
}

function isUnsupportedMethod(result) {
  return result?.body?.error?.code === -32601;
}

function describeResult(label, url, result) {
  const status = result?.response?.status ?? 'n/a';
  const rpcCode = result?.body?.error?.code;
  const rpcMessage = result?.body?.error?.message;
  const parts = [`${label}=${url}`, `status=${status}`];

  if (rpcCode !== undefined) {
    parts.push(`rpc_code=${rpcCode}`);
  }
  if (rpcMessage) {
    parts.push(`rpc_message=${JSON.stringify(rpcMessage)}`);
  }

  return parts.join(' ');
}

function maybeLogUnsupported(primary, reference) {
  if (unsupportedLogged) {
    return;
  }

  const primaryUnsupported = isUnsupportedMethod(primary);
  const referenceUnsupported = isUnsupportedMethod(reference);
  if (!primaryUnsupported && !referenceUnsupported) {
    return;
  }

  unsupportedLogged = true;
  if (primaryUnsupported) {
    console.error(
      `getTransactionsForAddress unsupported on primary endpoint: ${describeResult(
        'primary',
        config.rpcUrl,
        primary
      )}`
    );
  }
  if (referenceUnsupported) {
    console.error(
      `getTransactionsForAddress unsupported on reference endpoint: ${describeResult(
        'reference',
        config.referenceRpcUrl,
        reference
      )}`
    );
  }
}

function maybeLogFailure(address, primary, reference) {
  if (!logMismatches) {
    return;
  }

  console.error(`Request comparison failed for address ${address} (vu ${__VU}, iter ${__ITER})`);
  console.error(describeResult('primary', config.rpcUrl, primary));
  console.error(describeResult('reference', config.referenceRpcUrl, reference));
  console.error(`Primary body: ${summarizeJson(primary.body)}`);
  console.error(`Reference body: ${summarizeJson(reference.body)}`);
}

function maybeLogMismatch(address, primaryBody, referenceBody) {
  if (!logMismatches) {
    return;
  }

  console.error(`Response mismatch for address ${address} (vu ${__VU}, iter ${__ITER})`);
  console.error(`Primary: ${summarizeJson(primaryBody)}`);
  console.error(`Reference: ${summarizeJson(referenceBody)}`);
}

function recordLatencyComparison(primary, reference) {
  const primaryDuration = primary?.response?.timings?.duration;
  const referenceDuration = reference?.response?.timings?.duration;
  if (
    typeof primaryDuration !== 'number' ||
    typeof referenceDuration !== 'number' ||
    !Number.isFinite(primaryDuration) ||
    !Number.isFinite(referenceDuration)
  ) {
    return;
  }

  const delta = primaryDuration - referenceDuration;
  latencyDelta.add(delta);

  if (delta < 0) {
    primaryFaster.add(1);
  } else if (delta > 0) {
    referenceFaster.add(1);
  } else {
    comparisonTies.add(1);
  }
}

function summarizeTrend(data, metricName) {
  const values = data.metrics[metricName]?.values;
  return {
    avg: values?.avg || 0,
    p95: values?.['p(95)'] || 0,
    p99: values?.['p(99)'] || 0,
    min: values?.min || 0,
    max: values?.max || 0,
  };
}

function summarizeCount(data, metricName) {
  return data.metrics[metricName]?.values?.count || 0;
}

function fasterEndpointByAverage(data) {
  const deltaAvg = data.metrics.tfa_compare_latency_delta_ms?.values?.avg;
  if (deltaAvg === undefined || deltaAvg === null) {
    return 'unavailable';
  }
  if (deltaAvg < 0) {
    return 'primary';
  }
  if (deltaAvg > 0) {
    return 'reference';
  }
  return 'tie';
}

export default function () {
  const address = randomAddress();
  const requestId = Math.floor(Math.random() * 1_000_000_000);
  const payload = makeGetTransactionsForAddressRequest(
    address,
    transactionsForAddressOptions(),
    requestId
  );

  const primaryFirst = (__ITER + __VU) % 2 === 0;
  const first = primaryFirst
    ? { kind: 'primary', rpcUrl: config.rpcUrl }
    : { kind: 'reference', rpcUrl: config.referenceRpcUrl };
  const second = primaryFirst
    ? { kind: 'reference', rpcUrl: config.referenceRpcUrl }
    : { kind: 'primary', rpcUrl: config.rpcUrl };

  const firstResult = executeRequest(payload, {
    rpcUrl: first.rpcUrl,
    recordMetrics: false,
  });
  recordEndpointMetrics(first.kind, firstResult);

  const secondResult = executeRequest(payload, {
    rpcUrl: second.rpcUrl,
    recordMetrics: false,
  });
  recordEndpointMetrics(second.kind, secondResult);

  const primary = first.kind === 'primary' ? firstResult : secondResult;
  const reference = first.kind === 'reference' ? firstResult : secondResult;

  maybeLogUnsupported(primary, reference);

  const basicChecks = check(null, {
    'primary status is 200': () => primary.response.status === 200,
    'reference status is 200': () => reference.response.status === 200,
    'primary response is json': () => primary.body !== null,
    'reference response is json': () => reference.body !== null,
    'primary method is supported': () => !isUnsupportedMethod(primary),
    'reference method is supported': () => !isUnsupportedMethod(reference),
    'primary has no rpc error': () => primary.body && !primary.body.error,
    'reference has no rpc error': () => reference.body && !reference.body.error,
  });

  if (!basicChecks) {
    comparisonsSkipped.add(1);
    maybeLogFailure(address, primary, reference);
  }

  let match = false;
  if (basicChecks) {
    recordLatencyComparison(primary, reference);
    comparisonsCompared.add(1);

    const normalizedPrimary = normalizeGetTransactionsForAddressResponse(primary.body);
    const normalizedReference = normalizeGetTransactionsForAddressResponse(reference.body);
    match = deepEqualWithLogSuperset(normalizedPrimary, normalizedReference);
    comparisonMatchRate.add(match);

    if (match) {
      comparisonsMatched.add(1);
    } else {
      comparisonsMismatched.add(1);
      maybeLogMismatch(address, normalizedPrimary, normalizedReference);
    }
  }

  check(null, {
    'responses match': () => basicChecks && match,
  });
}

export function handleSummary(data) {
  const summary = {
    testType: 'validate-get-transactions-for-address',
    timestamp: new Date().toISOString(),
    config: {
      rpcUrl: config.rpcUrl,
      referenceRpcUrl: config.referenceRpcUrl,
      vus: scenarios.basic.vus,
      duration: scenarios.basic.duration,
      addressPoolSize: addressPool.length,
      requestOrder: 'alternating primary-first and reference-first per iteration',
      transactionDetails: config.transactionsForAddressDetails,
      sortOrder: config.transactionsForAddressSortOrder,
      limit: config.transactionsForAddressLimit,
      commitment: config.transactionsForAddressCommitment,
      encoding: config.transactionsForAddressEncoding,
      maxSupportedTransactionVersion:
        config.transactionsForAddressMaxSupportedTransactionVersion,
      minContextSlot: config.transactionsForAddressMinContextSlot,
      paginationToken: config.transactionsForAddressPaginationToken,
      status: config.transactionsForAddressStatus,
      tokenAccounts: config.transactionsForAddressTokenAccounts,
    },
    metrics: {
      checks: {
        rate: data.metrics.checks?.values?.rate || 0,
        passed: data.metrics.checks?.values?.passes || 0,
        failed: data.metrics.checks?.values?.fails || 0,
      },
      primary: {
        requests: {
          total: summarizeCount(data, 'tfa_compare_primary_requests_total'),
          successful: summarizeCount(data, 'tfa_compare_primary_success_total'),
          httpErrors: summarizeCount(data, 'tfa_compare_primary_http_errors_total'),
          nonJson: summarizeCount(data, 'tfa_compare_primary_non_json_total'),
          rpcErrors: summarizeCount(data, 'tfa_compare_primary_rpc_errors_total'),
          unsupportedMethod: summarizeCount(
            data,
            'tfa_compare_primary_unsupported_method_total'
          ),
          slow: summarizeCount(data, 'tfa_compare_primary_slow_total'),
        },
        latencyMs: summarizeTrend(data, 'tfa_compare_primary_latency_ms'),
      },
      reference: {
        requests: {
          total: summarizeCount(data, 'tfa_compare_reference_requests_total'),
          successful: summarizeCount(data, 'tfa_compare_reference_success_total'),
          httpErrors: summarizeCount(data, 'tfa_compare_reference_http_errors_total'),
          nonJson: summarizeCount(data, 'tfa_compare_reference_non_json_total'),
          rpcErrors: summarizeCount(data, 'tfa_compare_reference_rpc_errors_total'),
          unsupportedMethod: summarizeCount(
            data,
            'tfa_compare_reference_unsupported_method_total'
          ),
          slow: summarizeCount(data, 'tfa_compare_reference_slow_total'),
        },
        latencyMs: summarizeTrend(data, 'tfa_compare_reference_latency_ms'),
      },
      comparison: {
        compared: summarizeCount(data, 'tfa_compare_compared_total'),
        skipped: summarizeCount(data, 'tfa_compare_skipped_total'),
        matches: summarizeCount(data, 'tfa_compare_matches_total'),
        mismatches: summarizeCount(data, 'tfa_compare_mismatches_total'),
        matchRate: data.metrics.tfa_compare_match_rate?.values?.rate || 0,
        fasterEndpointByAvgLatency: fasterEndpointByAverage(data),
        primaryFaster: summarizeCount(data, 'tfa_compare_primary_faster_total'),
        referenceFaster: summarizeCount(data, 'tfa_compare_reference_faster_total'),
        ties: summarizeCount(data, 'tfa_compare_ties_total'),
        latencyDeltaMs: summarizeTrend(data, 'tfa_compare_latency_delta_ms'),
      },
    },
  };

  return {
    stdout: JSON.stringify(summary, null, 2) + '\n',
  };
}
