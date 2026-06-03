// SPDX-License-Identifier: AGPL-3.0-only
/*
 * Copyright 2025-2026 Triton One Limited. All rights reserved.
 */

// Head-cache WebSocket-driven test for superbank-rpc getTransaction
//
// Purpose:
// - Subscribe to an upstream Solana WebSocket (logsSubscribe) to harvest fresh signatures
// - Query superbank-rpc getTransaction for those signatures at processed/confirmed/finalized
// - Designed to exercise superbank-rpc's optional gRPC head cache (processed commitment support)
//
// Usage:
//   k6 run tests/k6/scenarios/basic/superbank-rpc-head-cache-ws-get-transaction.js \
//     -e RPC_URL=http://localhost:8899 \
//     -e SOLANA_WS_URL=wss://api.mainnet-beta.solana.com \
//     -e WS_MENTION=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v \
//     -e WS_MAX_SIGS_PER_SEC=2 \
//     -e VUS=5 -e DURATION=60s
//
// Optional preflight:
//   -e METRICS_URL=http://localhost:9900/metrics

import ws from 'k6/ws';
import http from 'k6/http';
import { check, fail } from 'k6';

import { config, scenarios } from '../../lib/config.js';
import { getTransaction } from '../../lib/rpc.js';
import { addDownstreamMetrics } from '../../lib/summary.js';
import {
  wsConnectMs,
  wsSubscribeOk,
  wsMessagesTotal,
  wsSignaturesTotal,
  wsQueueDroppedTotal,
  headcacheSigToProcessedRequestMs,
  headcacheGetTransactionProcessedMs,
  headcacheGetTransactionConfirmedMs,
  headcacheGetTransactionFinalizedMs,
  headcacheAvailabilityProcessedMs,
  headcacheAvailabilityConfirmedMs,
  headcacheAvailabilityFinalizedMs,
  headcacheAvailabilityProcessedTimeoutTotal,
  headcacheAvailabilityConfirmedTimeoutTotal,
  headcacheAvailabilityFinalizedTimeoutTotal,
  headcacheProcessedAvailableRate,
  headcacheConfirmedAvailableRate,
  headcacheFinalizedAvailableRate,
  headcacheProcessedBlockTimePresentRate,
  headcacheProcessedBlockTimeMissingTotal,
  headcacheProcessedBlockTimePendingTotal,
  headcacheProcessedBlockTimeFillMs,
  headcacheProcessedBlockTimeTimeoutTotal,
} from '../../lib/metrics.js';

if (!config.solanaWsUrl) {
  throw new Error(
    'SOLANA_WS_URL is required for head-cache WS tests (e.g. wss://api.mainnet-beta.solana.com)'
  );
}

const strictProcessedBlockTime = (() => {
  const raw = String(__ENV.HEADCACHE_STRICT_PROCESSED_BLOCK_TIME || '')
    .trim()
    .toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
})();

export const options = {
  scenarios: {
    head_cache_ws_get_transaction: {
      executor: 'per-vu-iterations',
      vus: scenarios.basic.vus,
      iterations: 1,
      maxDuration: scenarios.basic.duration,
    },
  },
  thresholds: {
    http_req_failed: [`rate<${config.thresholds.httpFailRate}`],
    ws_subscribe_ok: ['rate==1.0'],
    ...(strictProcessedBlockTime
      ? {
          headcache_processed_block_time_present_rate: ['rate==1.0'],
          headcache_processed_block_time_missing_total: ['count==0'],
        }
      : {}),
  },
};

function parseDurationToMs(value) {
  const raw = String(value || '').trim();
  const str = raw.replace(/\s+/g, '');
  if (!str) {
    throw new Error(`Invalid duration: '${value}'`);
  }

  // Support simple and composite durations: "30s", "1m30s", "250ms", "2h".
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h)/g;
  let total = 0;
  let matched = false;
  let end = 0;
  let m;
  while ((m = re.exec(str)) !== null) {
    if (m.index !== end) {
      // Guard against gaps like "1m-30s" or unknown suffixes.
      throw new Error(
        `Unsupported duration format '${value}'. Use formats like 30s, 1m30s, 250ms, 2h.`
      );
    }
    matched = true;
    const n = Number(m[1]);
    const unit = m[2];
    if (!Number.isFinite(n)) {
      throw new Error(`Invalid duration number in '${value}'`);
    }
    if (unit === 'ms') {
      total += n;
    } else if (unit === 's') {
      total += n * 1000;
    } else if (unit === 'm') {
      total += n * 60_000;
    } else if (unit === 'h') {
      total += n * 3_600_000;
    } else {
      throw new Error(`Invalid duration unit '${unit}' in '${value}'`);
    }
    end = re.lastIndex;
  }

  if (!matched || end !== str.length) {
    throw new Error(
      `Unsupported duration format '${value}'. Use formats like 30s, 1m30s, 250ms, 2h.`
    );
  }

  return Math.max(0, Math.floor(total));
}

function buildTransactionOptions(commitment) {
  return {
    encoding: config.transactionEncoding,
    commitment,
    maxSupportedTransactionVersion: config.maxSupportedTransactionVersion,
  };
}

function isProcessedCommitmentRejected(body) {
  const err = body && body.error;
  if (!err) {
    return false;
  }
  if (err.code !== -32602) {
    return false;
  }
  const msg = String(err.message || '');
  return msg.includes('Only confirmed or finalized commitments are supported');
}

function isTxAvailable(body) {
  return body && !body.error && body.result !== null && body.result !== undefined;
}

function hasNumericBlockTime(body) {
  if (!isTxAvailable(body)) {
    return false;
  }
  const blockTime = body.result?.blockTime;
  return typeof blockTime === 'number' && Number.isFinite(blockTime);
}

function recordGetTransactionLatency(commitment, ms) {
  if (commitment === 'processed') {
    headcacheGetTransactionProcessedMs.add(ms);
  } else if (commitment === 'confirmed') {
    headcacheGetTransactionConfirmedMs.add(ms);
  } else if (commitment === 'finalized') {
    headcacheGetTransactionFinalizedMs.add(ms);
  }
}

function recordAvailability(commitment, elapsedMs) {
  if (commitment === 'processed') {
    headcacheAvailabilityProcessedMs.add(elapsedMs);
    headcacheProcessedAvailableRate.add(1);
  } else if (commitment === 'confirmed') {
    headcacheAvailabilityConfirmedMs.add(elapsedMs);
    headcacheConfirmedAvailableRate.add(1);
  } else if (commitment === 'finalized') {
    headcacheAvailabilityFinalizedMs.add(elapsedMs);
    headcacheFinalizedAvailableRate.add(1);
  }
}

function recordTimeout(commitment) {
  if (commitment === 'processed') {
    headcacheAvailabilityProcessedTimeoutTotal.add(1);
    headcacheProcessedAvailableRate.add(0);
  } else if (commitment === 'confirmed') {
    headcacheAvailabilityConfirmedTimeoutTotal.add(1);
    headcacheConfirmedAvailableRate.add(0);
  } else if (commitment === 'finalized') {
    headcacheAvailabilityFinalizedTimeoutTotal.add(1);
    headcacheFinalizedAvailableRate.add(0);
  }
}

function recordProcessedBlockTimeTimeout(task) {
  if (task.commitment !== 'processed') {
    return;
  }
  if (task.processedBlockTimePendingSinceMs === null) {
    return;
  }

  headcacheProcessedBlockTimeTimeoutTotal.add(1);
  headcacheProcessedBlockTimePresentRate.add(0);
}

export function setup() {
  if (!config.metricsUrl) {
    return null;
  }

  const res = http.get(config.metricsUrl);
  check(res, {
    'metrics status is 200': (r) => r.status === 200,
  });
  if (res.status !== 200) {
    throw new Error(`METRICS_URL returned non-200: ${res.status}`);
  }

  const body = String(res.body || '');

  // Prometheus exposition format with optional registry namespace prefix:
  // - "head_cache_active 1"
  // - "superbank_head_cache_active 1" (superbank-rpc uses registry namespace "superbank")
  const re = /(^|\n)(?:superbank_)?head_cache_active\s+(\d+)(\s|$)/;
  const m = body.match(re);
  if (!m) {
    throw new Error(
      "Head-cache metric not found in METRICS_URL output (expected 'superbank_head_cache_active' or 'head_cache_active'). Ensure superbank-rpc is compiled with --features grpc-head-cache and metrics are enabled."
    );
  }
  const active = Number(m[2]);
  if (active !== 1) {
    throw new Error(
      `head_cache_active is ${m[2]} (expected 1). Ensure superbank-rpc is running with --features grpc-head-cache, HEAD_CACHE_ENABLED=true, and DRAGONSMOUTH_ENDPOINT is set.`
    );
  }

  return null;
}

export default function () {
  const runDurationMs = parseDurationToMs(scenarios.basic.duration);
  const startMs = Date.now();
  const runUntilMs = startMs + runDurationMs;

  const maxSigsPerSec = Math.max(1, config.wsMaxSigsPerSec);
  const tokenBucketMax = maxSigsPerSec;
  const tokenRefillPerMs = maxSigsPerSec / 1000;

  const sigQueueMax = Math.max(1, config.wsQueueMax);
  const pollIntervalMs = Math.max(25, config.headCachePollIntervalMs);
  const maxPollsPerTick = Math.max(1, config.headCacheMaxPollsPerTick);

  // Queue: { signature, receivedAtMs }
  let sigQueue = [];
  let sigQueueHead = 0;

  // Tasks: { signature, receivedAtMs, commitment, nextAttemptMs, deadlineMs, done, processedBlockTimePendingSinceMs }
  let tasks = [];
  let lastCompactMs = startMs;
  let pollCursor = 0;

  const seen = new Map();

  let fatalError = null;
  let subscribed = false;
  let gotSignature = false;
  let subscribeRequestId = null;

  let tokens = 0;
  let lastRefillMs = startMs;

  function refillTokens(nowMs) {
    if (nowMs <= lastRefillMs) {
      return;
    }
    tokens = Math.min(
      tokenBucketMax,
      tokens + (nowMs - lastRefillMs) * tokenRefillPerMs
    );
    lastRefillMs = nowMs;
  }

  function enqueueSignature(signature, receivedAtMs) {
    if (seen.has(signature)) {
      return;
    }
    seen.set(signature, receivedAtMs);
    if (seen.size > 10_000) {
      // Bound memory; duplicates after a clear are acceptable for this test.
      seen.clear();
      seen.set(signature, receivedAtMs);
    }

    const queued = sigQueue.length - sigQueueHead;
    if (queued >= sigQueueMax) {
      wsQueueDroppedTotal.add(1);
      return;
    }

    sigQueue.push({ signature, receivedAtMs });
    wsSignaturesTotal.add(1);
    gotSignature = true;
  }

  function compactSigQueueIfNeeded() {
    if (sigQueueHead <= 0) {
      return;
    }
    if (sigQueueHead < 1000) {
      return;
    }
    sigQueue = sigQueue.slice(sigQueueHead);
    sigQueueHead = 0;
  }

  function compactTasksIfNeeded(nowMs) {
    // Compact opportunistically so we don't grow unbounded over long runs.
    if (nowMs - lastCompactMs < 5000) {
      return;
    }
    lastCompactMs = nowMs;
    const before = tasks.length;
    if (before <= 0) {
      return;
    }
    tasks = tasks.filter((t) => !t.done);
  }

  function deadlineFor(receivedAtMs, maxWaitMs) {
    const maxWait = Math.max(0, maxWaitMs);
    return Math.min(receivedAtMs + maxWait, runUntilMs);
  }

  function attemptTask(task) {
    const { response, body } = getTransaction(
      task.signature,
      buildTransactionOptions(task.commitment)
    );

    if (response && response.timings) {
      recordGetTransactionLatency(task.commitment, response.timings.duration);
    }

    if (task.commitment === 'processed' && isProcessedCommitmentRejected(body)) {
      fatalError =
        fatalError ||
        'processed commitment was rejected (head cache likely disabled). Enable --features grpc-head-cache and HEAD_CACHE_ENABLED=true.';
      return;
    }

    if (isTxAvailable(body)) {
      if (task.commitment === 'processed') {
        const nowMs = Date.now();
        const blockTimePresent = hasNumericBlockTime(body);
        if (!blockTimePresent) {
          headcacheProcessedBlockTimeMissingTotal.add(1);

          if (task.processedBlockTimePendingSinceMs === null) {
            task.processedBlockTimePendingSinceMs = nowMs;
            headcacheProcessedBlockTimePendingTotal.add(1);
          }

          task.nextAttemptMs = nowMs + pollIntervalMs;
          return;
        }

        if (task.processedBlockTimePendingSinceMs !== null) {
          headcacheProcessedBlockTimeFillMs.add(
            nowMs - task.processedBlockTimePendingSinceMs
          );
        }
        headcacheProcessedBlockTimePresentRate.add(1);
      }

      const nowMs = Date.now();
      recordAvailability(task.commitment, nowMs - task.receivedAtMs);
      task.done = true;
      return;
    }

    task.nextAttemptMs = Date.now() + pollIntervalMs;
  }

  function processSignatureQueue() {
    const nowMs = Date.now();
    if (nowMs >= runUntilMs) {
      return;
    }

    refillTokens(nowMs);
    if (tokens < 1) {
      return;
    }
    if (sigQueueHead >= sigQueue.length) {
      return;
    }

    // Process at most 1 signature per tick; the token bucket enforces the rate.
    const item = sigQueue[sigQueueHead++];
    compactSigQueueIfNeeded();
    tokens -= 1;

    const receivedAtMs = item.receivedAtMs;
    const signature = item.signature;

    const processedTask = {
      signature,
      receivedAtMs,
      commitment: 'processed',
      nextAttemptMs: Date.now(),
      deadlineMs: deadlineFor(receivedAtMs, config.headCacheProcessedMaxWaitMs),
      done: false,
      processedBlockTimePendingSinceMs: null,
    };
    const confirmedTask =
      config.headCacheConfirmedMaxWaitMs > 0
        ? {
            signature,
            receivedAtMs,
            commitment: 'confirmed',
            nextAttemptMs: Date.now(),
            deadlineMs: deadlineFor(receivedAtMs, config.headCacheConfirmedMaxWaitMs),
            done: false,
            processedBlockTimePendingSinceMs: null,
          }
        : null;
    const finalizedTask =
      config.headCacheFinalizedMaxWaitMs > 0
        ? {
            signature,
            receivedAtMs,
            commitment: 'finalized',
            nextAttemptMs: Date.now(),
            deadlineMs: deadlineFor(receivedAtMs, config.headCacheFinalizedMaxWaitMs),
            done: false,
            processedBlockTimePendingSinceMs: null,
          }
        : null;

    tasks.push(processedTask);
    if (confirmedTask) {
      tasks.push(confirmedTask);
    }
    if (finalizedTask) {
      tasks.push(finalizedTask);
    }

    headcacheSigToProcessedRequestMs.add(Date.now() - receivedAtMs);
    attemptTask(processedTask);
  }

  function pollPendingTasks() {
    const nowMs = Date.now();
    if (nowMs >= runUntilMs) {
      return;
    }

    if (tasks.length <= 0) {
      return;
    }

    // Ensure we don't starve later tasks if the array grows.
    const len = tasks.length;
    pollCursor = pollCursor % len;

    let polls = 0;
    for (let scanned = 0; scanned < len; scanned += 1) {
      const idx = (pollCursor + scanned) % len;
      const task = tasks[idx];
      if (task.done) {
        continue;
      }
      if (nowMs >= task.deadlineMs) {
        recordProcessedBlockTimeTimeout(task);
        task.done = true;
        recordTimeout(task.commitment);
        continue;
      }
      if (polls >= maxPollsPerTick) {
        continue;
      }
      if (nowMs < task.nextAttemptMs) {
        continue;
      }

      polls += 1;
      attemptTask(task);

      if (fatalError) {
        return;
      }
    }

    pollCursor = (pollCursor + 1) % len;

    compactTasksIfNeeded(nowMs);
  }

  function finalizeOutstandingTasks() {
    for (const task of tasks) {
      if (task.done) {
        continue;
      }
      recordProcessedBlockTimeTimeout(task);
      task.done = true;
      recordTimeout(task.commitment);
    }
  }

  const connectStartMs = Date.now();
  const res = ws.connect(config.solanaWsUrl, {}, function (socket) {
    socket.on('open', function () {
      wsConnectMs.add(Date.now() - connectStartMs);

      subscribeRequestId = Math.floor(Math.random() * 1_000_000_000);
      socket.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: subscribeRequestId,
          method: 'logsSubscribe',
          params: [
            { mentions: [config.wsMention] },
            { commitment: config.wsCommitment },
          ],
        })
      );

      socket.setTimeout(function () {
        if (subscribed) {
          return;
        }
        wsSubscribeOk.add(0);
        fatalError =
          fatalError ||
          `WebSocket subscribe timed out after ${config.wsSubscribeTimeoutMs}ms`;
        socket.close();
      }, config.wsSubscribeTimeoutMs);
    });

    socket.on('message', function (data) {
      wsMessagesTotal.add(1);

      let msg = null;
      try {
        msg = JSON.parse(data);
      } catch (e) {
        return;
      }

      // Subscribe ack
      if (subscribeRequestId !== null && msg && msg.id === subscribeRequestId) {
        if (msg.error) {
          wsSubscribeOk.add(0);
          fatalError = fatalError || `WebSocket subscribe error: ${JSON.stringify(msg.error)}`;
          socket.close();
          return;
        }
        subscribed = true;
        wsSubscribeOk.add(1);

        socket.setTimeout(function () {
          if (gotSignature) {
            return;
          }
          fatalError =
            fatalError ||
            `No signatures received within ${config.wsNoSignatureTimeoutMs}ms (WS_MENTION=${config.wsMention})`;
          socket.close();
        }, config.wsNoSignatureTimeoutMs);
        return;
      }

      // logsNotification
      if (msg && msg.method === 'logsNotification') {
        const sig =
          msg.params &&
          msg.params.result &&
          msg.params.result.value &&
          msg.params.result.value.signature;
        if (sig && typeof sig === 'string') {
          enqueueSignature(sig, Date.now());
        }
      }
    });

    socket.on('error', function (e) {
      fatalError = fatalError || `WebSocket error: ${e.error()}`;
    });

    // Work loops
    socket.setInterval(function () {
      if (fatalError) {
        socket.close();
        return;
      }
      processSignatureQueue();
    }, 100);

    socket.setInterval(function () {
      if (fatalError) {
        socket.close();
        return;
      }
      pollPendingTasks();
      if (fatalError) {
        socket.close();
      }
    }, pollIntervalMs);

    // End-of-test cleanup
    socket.setTimeout(function () {
      finalizeOutstandingTasks();
      socket.close();
    }, runDurationMs);
  });

  // Validate the handshake response.
  const ok = check(res, {
    'ws status is 101': (r) => r && r.status === 101,
  });
  if (!ok && !fatalError) {
    wsSubscribeOk.add(0);
    fatalError = `WebSocket connect failed (status=${res && res.status})`;
  }

  if (fatalError) {
    fail(fatalError);
  }
}

function trendStats(values) {
  if (!values) {
    return null;
  }
  return {
    avg: values.avg || 0,
    p95: values['p(95)'] || 0,
    p99: values['p(99)'] || 0,
    max: values.max || 0,
  };
}

export function handleSummary(data) {
  const summary = {
    testType: 'head-cache-ws-get-transaction',
    timestamp: new Date().toISOString(),
    config: {
      rpcUrl: config.rpcUrl,
      solanaWsUrl: config.solanaWsUrl,
      wsMention: config.wsMention,
      wsCommitment: config.wsCommitment,
      wsMaxSigsPerSec: config.wsMaxSigsPerSec,
      wsQueueMax: config.wsQueueMax,
      vus: scenarios.basic.vus,
      duration: scenarios.basic.duration,
      encoding: config.transactionEncoding,
      maxSupportedTransactionVersion: config.maxSupportedTransactionVersion,
      pollIntervalMs: config.headCachePollIntervalMs,
      processedMaxWaitMs: config.headCacheProcessedMaxWaitMs,
      confirmedMaxWaitMs: config.headCacheConfirmedMaxWaitMs,
      finalizedMaxWaitMs: config.headCacheFinalizedMaxWaitMs,
      strictProcessedBlockTime,
    },
    metrics: {
      requests: {
        total: data.metrics.rpc_requests_total?.values?.count || 0,
        successful: data.metrics.rpc_requests_success?.values?.count || 0,
        failed: data.metrics.http_req_failed?.values?.passes || 0,
      },
      ws: {
        connectMs: trendStats(data.metrics.ws_connect_ms?.values),
        subscribeOk: {
          rate: data.metrics.ws_subscribe_ok?.values?.rate || 0,
          passes: data.metrics.ws_subscribe_ok?.values?.passes || 0,
          fails: data.metrics.ws_subscribe_ok?.values?.fails || 0,
        },
        messagesTotal: data.metrics.ws_messages_total?.values?.count || 0,
        signaturesTotal: data.metrics.ws_signatures_total?.values?.count || 0,
        queueDroppedTotal: data.metrics.ws_queue_dropped_total?.values?.count || 0,
      },
      headCache: {
        sigToProcessedRequestMs: trendStats(
          data.metrics.headcache_sig_to_processed_request_ms?.values
        ),
        getTransactionMs: {
          processed: trendStats(
            data.metrics.headcache_getTransaction_processed_ms?.values
          ),
          confirmed: trendStats(
            data.metrics.headcache_getTransaction_confirmed_ms?.values
          ),
          finalized: trendStats(
            data.metrics.headcache_getTransaction_finalized_ms?.values
          ),
        },
        availabilityMs: {
          processed: trendStats(data.metrics.headcache_availability_processed_ms?.values),
          confirmed: trendStats(data.metrics.headcache_availability_confirmed_ms?.values),
          finalized: trendStats(data.metrics.headcache_availability_finalized_ms?.values),
        },
        timeouts: {
          processed:
            data.metrics.headcache_availability_processed_timeout_total?.values
              ?.count || 0,
          confirmed:
            data.metrics.headcache_availability_confirmed_timeout_total?.values
              ?.count || 0,
          finalized:
            data.metrics.headcache_availability_finalized_timeout_total?.values
              ?.count || 0,
        },
        availableRate: {
          processed: data.metrics.headcache_processed_available_rate?.values?.rate || 0,
          confirmed: data.metrics.headcache_confirmed_available_rate?.values?.rate || 0,
          finalized: data.metrics.headcache_finalized_available_rate?.values?.rate || 0,
        },
        processedBlockTime: {
          presentRate:
            data.metrics.headcache_processed_block_time_present_rate?.values
              ?.rate || 0,
          missingTotal:
            data.metrics.headcache_processed_block_time_missing_total?.values
              ?.count || 0,
          pendingTotal:
            data.metrics.headcache_processed_block_time_pending_total?.values
              ?.count || 0,
          fillMs: trendStats(
            data.metrics.headcache_processed_block_time_fill_ms?.values
          ),
          timeoutTotal:
            data.metrics.headcache_processed_block_time_timeout_total?.values
              ?.count || 0,
        },
      },
    },
  };

  addDownstreamMetrics(data, summary.metrics);

  return {
    stdout: JSON.stringify(summary, null, 2) + '\n',
  };
}
