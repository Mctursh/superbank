// SPDX-License-Identifier: AGPL-3.0-only
/*
 * Copyright 2025-2026 Triton One Limited. All rights reserved.
 */

// JSON comparison helpers for validation tests

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeNullArray(value) {
  return value === null || value === undefined ? [] : value;
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

/**
 * Deep equality check for JSON-compatible values.
 * Object key order is ignored; array order is preserved.
 * @param {any} left
 * @param {any} right
 * @returns {boolean}
 */
export function deepEqual(left, right) {
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
    if (left.length !== right.length) {
      return false;
    }
    for (let i = 0; i < left.length; i += 1) {
      if (!deepEqual(left[i], right[i])) {
        return false;
      }
    }
    return true;
  }

  if (isObject(left) && isObject(right)) {
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
      if (!deepEqual(left[key], right[key])) {
        return false;
      }
    }

    return true;
  }

  return false;
}

/**
 * Deep equality check where Superbank's `logMessages` may be a superset of reference.
 * Object key order is ignored; array order is preserved (except for logMessages).
 * @param {any} left
 * @param {any} right
 * @param {string} [path='']
 * @returns {boolean}
 */
export function deepEqualWithLogSuperset(left, right, path = '') {
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

  if (isObject(left) && isObject(right)) {
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

function rewardSortKey(reward) {
  const pubkey = reward?.pubkey ?? '';
  const rewardType = reward?.rewardType ?? '';
  const lamports = reward?.lamports ?? 0;
  const postBalance = reward?.postBalance ?? 0;
  const commission = reward?.commission ?? '';
  return `${pubkey}|${rewardType}|${lamports}|${postBalance}|${commission}`;
}

function sortRewards(rewards) {
  if (!Array.isArray(rewards)) {
    return rewards;
  }
  return rewards.slice().sort((left, right) => {
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
}

function tokenBalanceSortKey(balance) {
  const accountIndex = balance?.accountIndex ?? '';
  const mint = balance?.mint ?? '';
  const owner = balance?.owner ?? '';
  const programId = balance?.programId ?? '';
  const amount = balance?.uiTokenAmount?.amount ?? '';
  return `${accountIndex}|${mint}|${owner}|${programId}|${amount}`;
}

function sortTokenBalances(balances) {
  if (!Array.isArray(balances)) {
    return balances;
  }
  return balances.slice().sort((left, right) => {
    const leftIdx = Number(left?.accountIndex);
    const rightIdx = Number(right?.accountIndex);
    const leftIsNum = Number.isFinite(leftIdx);
    const rightIsNum = Number.isFinite(rightIdx);
    if (leftIsNum && rightIsNum && leftIdx !== rightIdx) {
      return leftIdx - rightIdx;
    }
    const leftKey = tokenBalanceSortKey(left);
    const rightKey = tokenBalanceSortKey(right);
    if (leftKey < rightKey) {
      return -1;
    }
    if (leftKey > rightKey) {
      return 1;
    }
    return 0;
  });
}

export function normalizeTransactionMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    return meta;
  }

  const normalized = { ...meta };

  normalized.innerInstructions = normalizeNullArray(meta.innerInstructions);
  normalized.logMessages = normalizeNullArray(meta.logMessages);
  normalized.preTokenBalances = sortTokenBalances(normalizeNullArray(meta.preTokenBalances));
  normalized.postTokenBalances = sortTokenBalances(normalizeNullArray(meta.postTokenBalances));
  normalized.rewards = sortRewards(normalizeNullArray(meta.rewards));

  const loaded = meta.loadedAddresses;
  if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) {
    normalized.loadedAddresses = { writable: [], readonly: [] };
  } else {
    normalized.loadedAddresses = {
      writable: normalizeNullArray(loaded.writable),
      readonly: normalizeNullArray(loaded.readonly),
    };
  }

  return normalized;
}

function endsWithArray(source, suffix) {
  if (!Array.isArray(source) || !Array.isArray(suffix)) {
    return false;
  }
  if (suffix.length === 0) {
    return true;
  }
  if (suffix.length > source.length) {
    return false;
  }
  for (let i = 0; i < suffix.length; i += 1) {
    if (source[source.length - suffix.length + i] !== suffix[i]) {
      return false;
    }
  }
  return true;
}

function isUiAccountKey(value) {
  return isObject(value) && typeof value.pubkey === 'string';
}

export function normalizeV0MessageToResolvedAccountKeys(message, meta) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return message;
  }

  const accountKeys = Array.isArray(message.accountKeys) ? message.accountKeys : [];
  const hasUiAccountKeys = accountKeys.some((key) => isUiAccountKey(key));
  const hasStringAccountKeys = accountKeys.some((key) => typeof key === 'string');
  const accountKeysAreUi = hasUiAccountKeys && !hasStringAccountKeys;
  const accountKeysAreStrings = hasStringAccountKeys && !hasUiAccountKeys;

  const loadedAddresses = meta?.loadedAddresses;
  const writable = normalizeNullArray(loadedAddresses?.writable);
  const readonly = normalizeNullArray(loadedAddresses?.readonly);
  const loaded = Array.isArray(writable) && Array.isArray(readonly) ? [...writable, ...readonly] : [];

  let resolvedAccountKeys = accountKeys;

  if (accountKeysAreUi) {
    // Some providers duplicate lookup-table keys: once as `source:"transaction"` and once as
    // `source:"lookupTable"`. Treat those representations as equivalent by dropping the
    // `source:"transaction"` copy when a lookup-table entry exists for the same pubkey.
    const lookupPubkeys = new Set(
      accountKeys
        .filter((key) => isUiAccountKey(key) && key.source === 'lookupTable')
        .map((key) => key.pubkey)
    );

    if (lookupPubkeys.size > 0) {
      resolvedAccountKeys = resolvedAccountKeys.filter((key) => {
        if (!isUiAccountKey(key)) {
          return true;
        }
        return !(key.source === 'transaction' && lookupPubkeys.has(key.pubkey));
      });
    }
  }

  // Some providers return v0 messages with loaded addresses only in `meta.loadedAddresses`.
  // Expand missing loaded addresses into `message.accountKeys`, matching the current `accountKeys`
  // representation (UiAccountKey objects vs pubkey strings).
  if (loaded.length > 0) {
    if (accountKeysAreUi) {
      const existing = new Set(
        resolvedAccountKeys.filter((key) => isUiAccountKey(key)).map((key) => key.pubkey)
      );
      const appended = [];

      for (const pubkey of writable) {
        if (typeof pubkey === 'string' && !existing.has(pubkey)) {
          existing.add(pubkey);
          appended.push({
            pubkey,
            signer: false,
            writable: true,
            source: 'lookupTable',
          });
        }
      }

      for (const pubkey of readonly) {
        if (typeof pubkey === 'string' && !existing.has(pubkey)) {
          existing.add(pubkey);
          appended.push({
            pubkey,
            signer: false,
            writable: false,
            source: 'lookupTable',
          });
        }
      }

      if (appended.length > 0) {
        resolvedAccountKeys = resolvedAccountKeys.concat(appended);
      }
    } else if (accountKeysAreStrings) {
      if (!endsWithArray(resolvedAccountKeys, loaded)) {
        resolvedAccountKeys = resolvedAccountKeys.concat(loaded);
      }
    }
  }

  // Some providers disagree on writability flags for account keys. For validation purposes,
  // compare only stable fields (pubkey/signer/source) and ignore `writable`.
  if (accountKeysAreUi) {
    resolvedAccountKeys = resolvedAccountKeys.map((key) => {
      if (!isUiAccountKey(key)) {
        return key;
      }
      const { writable: _writable, ...rest } = key;
      return rest;
    });
  }

  // Canonicalize away representation differences: expanded accountKeys vs address table lookups.
  return {
    ...message,
    accountKeys: resolvedAccountKeys,
    addressTableLookups: [],
  };
}

export function normalizeGetTransactionResponse(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return body;
  }

  const result = body.result;
  if (result === null || result === undefined) {
    return body;
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return body;
  }

  const meta = normalizeTransactionMeta(result.meta);

  let transaction = result.transaction;
  if (transaction && typeof transaction === 'object' && !Array.isArray(transaction)) {
    const message = transaction.message;
    const normalizedMessage = normalizeV0MessageToResolvedAccountKeys(message, meta);
    if (message !== normalizedMessage) {
      transaction = { ...transaction, message: normalizedMessage };
    }
  }

  return {
    ...body,
    result: {
      ...result,
      meta,
      transaction,
    },
  };
}

function normalizeTransactionsForAddressEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return entry;
  }

  const normalizedEntry = { ...entry };
  const hasMeta = Object.prototype.hasOwnProperty.call(entry, 'meta');
  const normalizedMeta = hasMeta ? normalizeTransactionMeta(entry.meta) : undefined;

  if (hasMeta) {
    normalizedEntry.meta = normalizedMeta;
  }

  if (
    Object.prototype.hasOwnProperty.call(entry, 'transaction') &&
    entry.transaction &&
    typeof entry.transaction === 'object' &&
    !Array.isArray(entry.transaction)
  ) {
    const message = entry.transaction.message;
    const normalizedMessage = normalizeV0MessageToResolvedAccountKeys(
      message,
      normalizedMeta
    );

    if (message !== normalizedMessage) {
      normalizedEntry.transaction = {
        ...entry.transaction,
        message: normalizedMessage,
      };
    }
  }

  return normalizedEntry;
}

export function normalizeGetTransactionsForAddressResponse(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return body;
  }

  const result = body.result;
  if (result === null || result === undefined) {
    return body;
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return body;
  }

  const data = Array.isArray(result.data)
    ? result.data.map(normalizeTransactionsForAddressEntry)
    : result.data;

  return {
    ...body,
    result: {
      ...result,
      data,
    },
  };
}

/**
 * Stringify JSON and truncate for logging.
 * @param {any} value
 * @param {number} [limit=2000]
 * @returns {string}
 */
export function summarizeJson(value, limit = 2000) {
  let serialized = '';
  try {
    serialized = JSON.stringify(value);
  } catch (e) {
    return '[unserializable json]';
  }

  if (serialized === undefined) {
    return '[undefined json]';
  }

  if (serialized.length <= limit) {
    return serialized;
  }

  return `${serialized.slice(0, limit)}...`;
}
