// SPDX-License-Identifier: AGPL-3.0-only
/*
 * Copyright 2025-2026 Triton One Limited. All rights reserved.
 */

// Validation test for superbank-rpc getBlock
//
// Purpose: Compare Superbank RPC responses against a reference RPC.
//
// Usage:
//   k6 run tests/k6/scenarios/validation/superbank-rpc-validate-get-block.js \
//     -e RPC_URL=http://localhost:8899 \
//     -e REFERENCE_RPC_URL=https://api.mainnet-beta.solana.com \
//     -e SLOT_FILE=./tests/k6/data/pools/slots.txt

import { check } from 'k6';
import { config, scenarios } from '../../lib/config.js';
import { initSlotPool, randomSlot } from '../../lib/slots.js';
import { summarizeJson } from '../../lib/compare.js';
import { executeRequest, makeGetBlockRequest } from '../../lib/rpc.js';
import {
  addDownstreamMetrics,
  collectJsonrpcErrorCodeCounts,
  makeJsonrpcErrorCodeThresholds,
} from '../../lib/summary.js';

if (!config.referenceRpcUrl) {
  throw new Error('REFERENCE_RPC_URL is required for validation tests.');
}

const slotPool = initSlotPool();
const logMismatches = __ENV.VALIDATION_LOG_MISMATCHES !== '0';

export const options = {
  vus: scenarios.basic.vus,
  duration: scenarios.basic.duration,
  thresholds: {
    http_req_failed: ['rate==0.0'],
    checks: ['rate==1.0'],
    ...makeJsonrpcErrorCodeThresholds(),
  },
};

function buildBlockOptions() {
  const options = {};
  if (config.blockEncoding) {
    options.encoding = config.blockEncoding;
  }
  if (config.blockTransactionDetails) {
    options.transactionDetails = config.blockTransactionDetails;
  }
  if (config.blockRewards !== null) {
    options.rewards = config.blockRewards;
  }
  if (config.blockCommitment) {
    options.commitment = config.blockCommitment;
  }
  if (config.blockMaxSupportedTransactionVersion !== null) {
    options.maxSupportedTransactionVersion = config.blockMaxSupportedTransactionVersion;
  }
  return options;
}

function rewardSortKey(reward) {
  const pubkey = reward?.pubkey ?? '';
  const rewardType = reward?.rewardType ?? '';
  const lamports = reward?.lamports ?? 0;
  const postBalance = reward?.postBalance ?? 0;
  const commission = reward?.commission ?? '';
  return `${pubkey}|${rewardType}|${lamports}|${postBalance}|${commission}`;
}

function normalizeNullArray(value) {
  return value === null ? [] : value;
}

function normalizeTransactionMeta(meta) {
  if (!meta || typeof meta !== 'object') {
    return meta;
  }

  const normalized = { ...meta };

  // Some nodes (and some historical backfills) disagree on whether `costUnits` is present.
  // Superbank may not have it depending on the ingestion source.
  if ('costUnits' in normalized) {
    delete normalized.costUnits;
  }

  // Some nodes return null for absent arrays while others return empty lists.
  normalized.innerInstructions = normalizeNullArray(normalized.innerInstructions);
  normalized.logMessages = normalizeNullArray(normalized.logMessages);
  normalized.preTokenBalances = normalizeNullArray(normalized.preTokenBalances);
  normalized.postTokenBalances = normalizeNullArray(normalized.postTokenBalances);

  // Some nodes return `rewards: null` while others return `rewards: []` when there are no rewards.
  // Treat the empty cases as equivalent. Only normalize when the key is actually present.
  if ('rewards' in normalized) {
    if (
      normalized.rewards === null ||
      (Array.isArray(normalized.rewards) && normalized.rewards.length === 0)
    ) {
      delete normalized.rewards;
    } else {
      normalized.rewards = normalizeNullArray(normalized.rewards);
    }
  }

  return normalized;
}

function isSubsequence(haystack, needle) {
  if (!Array.isArray(haystack) || !Array.isArray(needle)) {
    return false;
  }
  if (needle.length === 0) {
    return true;
  }
  let idx = 0;
  for (const item of haystack) {
    if (item === needle[idx]) {
      idx += 1;
      if (idx === needle.length) {
        return true;
      }
    }
  }
  return false;
}

function deepEqualWithLogSuperset(left, right, path = '') {
  if (left === right) {
    return true;
  }

  if (left === null || right === null) {
    return left === right;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) {
      return false;
    }
    if (path.endsWith('.logMessages')) {
      return isSubsequence(left, right);
    }
    if (left.length !== right.length) {
      return false;
    }
    for (let i = 0; i < left.length; i += 1) {
      if (!deepEqualWithLogSuperset(left[i], right[i], `${path}[${i}]`)) {
        return false;
      }
    }
    return true;
  }

  if (left && right && typeof left === 'object' && typeof right === 'object') {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (leftKeys.length !== rightKeys.length) {
      return false;
    }
    for (let i = 0; i < leftKeys.length; i += 1) {
      if (leftKeys[i] !== rightKeys[i]) {
        return false;
      }
    }
    for (const key of leftKeys) {
      const nextPath = path ? `${path}.${key}` : key;
      if (!deepEqualWithLogSuperset(left[key], right[key], nextPath)) {
        return false;
      }
    }
    return true;
  }

  return false;
}

function normalizeGetBlockResponse(body) {
  if (!body || typeof body !== 'object') {
    return body;
  }

  const result = body.result;
  if (!result || typeof result !== 'object') {
    return body;
  }

  const normalizedTransactions = Array.isArray(result.transactions)
    ? result.transactions.map((transaction) => {
        if (!transaction || typeof transaction !== 'object') {
          return transaction;
        }
        const meta = normalizeTransactionMeta(transaction.meta);
        return meta === transaction.meta ? transaction : { ...transaction, meta };
      })
    : result.transactions;

  const rewards = normalizeNullArray(result.rewards);
  if (!Array.isArray(rewards)) {
    return {
      ...body,
      result: {
        ...result,
        transactions: normalizedTransactions,
        rewards,
      },
    };
  }

  const sortedRewards = rewards
    .slice()
    .sort((left, right) => {
      const leftKey = rewardSortKey(left);
      const rightKey = rewardSortKey(right);
      if (leftKey < rightKey) {
        return -1;
      }
      if (leftKey > rightKey) {
        return 1;
      }
      return 0;
    });

  return {
    ...body,
    result: {
      ...result,
      rewards: sortedRewards,
      transactions: normalizedTransactions,
    },
  };
}

export default function () {
  const slot = randomSlot();
  const requestId = Math.floor(Math.random() * 1_000_000_000);
  const payload = makeGetBlockRequest(slot, buildBlockOptions(), requestId);

  const superbank = executeRequest(payload, { rpcUrl: config.rpcUrl });
  const reference = executeRequest(payload, {
    rpcUrl: config.referenceRpcUrl,
    recordMetrics: false,
  });

  const basicChecks = check(null, {
    'superbank status is 200': () => superbank.response.status === 200,
    'reference status is 200': () => reference.response.status === 200,
    'superbank response is json': () => superbank.body !== null,
    'reference response is json': () => reference.body !== null,
  });

  let match = false;
  if (basicChecks) {
    const normalizedSuperbank = normalizeGetBlockResponse(superbank.body);
    const normalizedReference = normalizeGetBlockResponse(reference.body);
    match = deepEqualWithLogSuperset(normalizedSuperbank, normalizedReference);
  }

  if (!match && basicChecks && logMismatches) {
    console.error(`Response mismatch for slot ${slot} (vu ${__VU}, iter ${__ITER})`);
    console.error(`Superbank: ${summarizeJson(superbank.body)}`);
    console.error(`Reference: ${summarizeJson(reference.body)}`);
  }

  check(null, {
    'responses match': () => match,
  });
}

export function handleSummary(data) {
  const jsonrpcCodes = collectJsonrpcErrorCodeCounts(data);
  const summary = {
    testType: 'validate-get-block',
    timestamp: new Date().toISOString(),
    config: {
      rpcUrl: config.rpcUrl,
      referenceRpcUrl: config.referenceRpcUrl,
      vus: scenarios.basic.vus,
      duration: scenarios.basic.duration,
      slotPoolSize: slotPool.length,
      encoding: config.blockEncoding,
      transactionDetails: config.blockTransactionDetails,
      rewards: config.blockRewards,
      commitment: config.blockCommitment,
      maxSupportedTransactionVersion: config.blockMaxSupportedTransactionVersion,
    },
    metrics: {
      checks: {
        rate: data.metrics.checks?.values?.rate || 0,
        passed: data.metrics.checks?.values?.passes || 0,
        failed: data.metrics.checks?.values?.fails || 0,
      },
      requests: {
        total: data.metrics.rpc_requests_total?.values?.count || 0,
        successful: data.metrics.rpc_requests_success?.values?.count || 0,
        failed: data.metrics.http_req_failed?.values?.passes || 0,
      },
      errors: {
        http: data.metrics.rpc_errors_http?.values?.count || 0,
        rpc: data.metrics.rpc_errors_rpc?.values?.count || 0,
        timeout: data.metrics.rpc_errors_timeout?.values?.count || 0,
        jsonrpcTotal: jsonrpcCodes.total,
        jsonrpcUntracked: jsonrpcCodes.untracked,
        jsonrpcByCode: jsonrpcCodes.byCode,
      },
    },
  };

  addDownstreamMetrics(data, summary.metrics);

  return {
    stdout: JSON.stringify(summary, null, 2) + '\n',
  };
}
