// SPDX-License-Identifier: AGPL-3.0-only
/*
 * Copyright 2025-2026 Triton One Limited. All rights reserved.
 */

// Official Solana RPC options used by fuzz tests.
// Keep this in sync with https://solana.com/docs/rpc/http

export const OFFICIAL_RPC_METHODS = [
  'getSignaturesForAddress',
  'getSignatureStatuses',
  'getTransaction',
  'getBlock',
  'getBlockHeight',
  'getSlot',
  'getTransactionCount',
  'getLatestBlockhash',
  'getBlockTime',
  'getBlocks',
  'getBlocksWithLimit',
  'getFirstAvailableBlock',
  'getInflationReward',
];

export const OFFICIAL_OPTION_FIELDS = {
  getSignaturesForAddress: ['limit', 'before', 'until', 'commitment', 'minContextSlot'],
  getSignatureStatuses: ['searchTransactionHistory'],
  getTransaction: ['encoding', 'commitment', 'maxSupportedTransactionVersion'],
  getBlock: [
    'encoding',
    'transactionDetails',
    'rewards',
    'commitment',
    'maxSupportedTransactionVersion',
  ],
  getBlockHeight: ['commitment', 'minContextSlot'],
  getSlot: ['commitment', 'minContextSlot'],
  getTransactionCount: ['commitment', 'minContextSlot'],
  getLatestBlockhash: ['commitment', 'minContextSlot'],
  getBlockTime: [],
  getBlocks: ['commitment'],
  getBlocksWithLimit: ['commitment'],
  getFirstAvailableBlock: [],
  getInflationReward: ['epoch', 'commitment', 'minContextSlot'],
};

export const OFFICIAL_ENUMS = {
  commitment: ['confirmed', 'finalized'],
  encoding: ['json', 'jsonParsed', 'base64', 'base58'],
  transactionDetails: ['full', 'accounts', 'signatures', 'none'],
};

export function isOfficialMethod(method) {
  return OFFICIAL_RPC_METHODS.includes(method);
}

export function assertOfficialOptionKeys(method, options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    return;
  }
  const allowed = OFFICIAL_OPTION_FIELDS[method] || [];
  const invalid = Object.keys(options).filter((key) => !allowed.includes(key));
  if (invalid.length > 0) {
    throw new Error(
      `Non-official option(s) for ${method}: ${invalid.join(', ')}`
    );
  }
}

export function assertOfficialMethods(requested) {
  const invalid = requested.filter((method) => !isOfficialMethod(method));
  if (invalid.length > 0) {
    throw new Error(
      `FUZZ_OPTIONS_METHODS includes non-official method(s): ${invalid.join(', ')}`
    );
  }
}
