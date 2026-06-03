// SPDX-License-Identifier: AGPL-3.0-only
/*
 * Copyright 2025-2026 Triton One Limited. All rights reserved.
 */

export function addDownstreamMetrics(data, target) {
  const elapsed = data.metrics.downstream_clickhouse_elapsed_ms?.values;
  const received = data.metrics.downstream_received_bytes?.values;
  const decoded = data.metrics.downstream_decoded_bytes?.values;
  const rowsRead = data.metrics.downstream_rows_read?.values;
  const rowsReturned = data.metrics.downstream_rows_returned?.values;
  const dataReadBytes = data.metrics.downstream_data_read_bytes?.values;

  if (!elapsed && !received && !decoded && !rowsRead && !rowsReturned && !dataReadBytes) {
    return;
  }

  target.downstream = {};

  if (elapsed) {
    target.downstream.clickhouseElapsedMs = {
      avg: elapsed.avg || 0,
      p95: elapsed['p(95)'] || 0,
      p99: elapsed['p(99)'] || 0,
      max: elapsed.max || 0,
    };
  }

  if (received) {
    target.downstream.receivedBytes = {
      avg: received.avg || 0,
      p95: received['p(95)'] || 0,
      p99: received['p(99)'] || 0,
      max: received.max || 0,
    };
  }

  if (decoded) {
    target.downstream.decodedBytes = {
      avg: decoded.avg || 0,
      p95: decoded['p(95)'] || 0,
      p99: decoded['p(99)'] || 0,
      max: decoded.max || 0,
    };
  }

  if (rowsRead) {
    target.downstream.rowsRead = {
      avg: rowsRead.avg || 0,
      p95: rowsRead['p(95)'] || 0,
      p99: rowsRead['p(99)'] || 0,
      max: rowsRead.max || 0,
    };
  }

  if (rowsReturned) {
    target.downstream.rowsReturned = {
      avg: rowsReturned.avg || 0,
      p95: rowsReturned['p(95)'] || 0,
      p99: rowsReturned['p(99)'] || 0,
      max: rowsReturned.max || 0,
    };
  }

  if (dataReadBytes) {
    target.downstream.dataReadBytes = {
      avg: dataReadBytes.avg || 0,
      p95: dataReadBytes['p(95)'] || 0,
      p99: dataReadBytes['p(99)'] || 0,
      max: dataReadBytes.max || 0,
    };
  }
}

function sumCounts(pairs) {
  let total = 0;
  for (const [, count] of pairs) {
    total += count;
  }
  return total;
}

function compareCodeEntries([leftCode], [rightCode]) {
  const leftNum = Number(leftCode);
  const rightNum = Number(rightCode);
  const leftIsNum = Number.isFinite(leftNum);
  const rightIsNum = Number.isFinite(rightNum);

  if (leftIsNum && rightIsNum) {
    return leftNum - rightNum;
  }
  if (leftIsNum) {
    return -1;
  }
  if (rightIsNum) {
    return 1;
  }
  return String(leftCode).localeCompare(String(rightCode));
}

/**
 * k6 only includes per-tag submetrics in the handleSummary `data` when a threshold references them.
 * This helper generates no-op thresholds to make sure `rpc_errors_jsonrpc_code{code:<...>}` appears
 * in the summary output, so validation scripts can report per-code counts.
 */
export function makeJsonrpcErrorCodeThresholds(
  metricName = 'rpc_errors_jsonrpc_code',
  options = {},
) {
  const thresholds = {};

  // JSON-RPC 2.0 standard codes
  const standard = [-32700, -32600, -32601, -32602, -32603];

  // Include common server-side codes by default (e.g. timeouts).
  const extraCodes = options.extraCodes || [-32000];

  const codes = new Set([...standard, ...extraCodes]);
  for (const code of codes) {
    thresholds[`${metricName}{code:${code}}`] = ['count>=0'];
  }

  const envIncludeReserved =
    typeof __ENV !== 'undefined' &&
    __ENV.K6_JSONRPC_INCLUDE_RESERVED_SERVER_CODES !== undefined &&
    (__ENV.K6_JSONRPC_INCLUDE_RESERVED_SERVER_CODES === 'true' ||
      __ENV.K6_JSONRPC_INCLUDE_RESERVED_SERVER_CODES === '1');

  const includeReservedRange =
    options.includeReservedRange !== undefined
      ? options.includeReservedRange
      : envIncludeReserved;

  // Reserved server error range (JSON-RPC 2.0): -32000 to -32099 (inclusive)
  if (includeReservedRange) {
    for (let code = -32099; code <= -32000; code += 1) {
      thresholds[`${metricName}{code:${code}}`] = ['count>=0'];
    }
  }

  // Fallback buckets for malformed error objects.
  thresholds[`${metricName}{code:missing}`] = ['count>=0'];

  return thresholds;
}

export function collectJsonrpcErrorCodeCounts(data, metricName = 'rpc_errors_jsonrpc_code') {
  const total = data.metrics?.[metricName]?.values?.count || 0;

  const prefix = `${metricName}{code:`;
  const entries = [];

  for (const [key, metric] of Object.entries(data.metrics || {})) {
    if (!key.startsWith(prefix) || !key.endsWith('}')) {
      continue;
    }
    const code = key.slice(prefix.length, -1);
    const count = metric?.values?.count || 0;
    if (count <= 0) {
      continue;
    }
    entries.push([code, count]);
  }

  entries.sort(compareCodeEntries);

  const byCode = {};
  for (const [code, count] of entries) {
    byCode[code] = count;
  }

  const trackedTotal = sumCounts(entries);
  const untracked = Math.max(0, total - trackedTotal);

  return {
    total,
    untracked,
    byCode,
  };
}
