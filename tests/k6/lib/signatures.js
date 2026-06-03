// SPDX-License-Identifier: AGPL-3.0-only
/*
 * Copyright 2025-2026 Triton One Limited. All rights reserved.
 */

// Signature generation and management utilities for k6 getTransaction tests

import { randomBytes } from 'k6/crypto';
import { config } from './config.js';
import { encodeBase58 } from './addresses.js';
import { resolveOpenPath } from './path.js';

// Signature pool - initialized once at startup
let signaturePool = null;

/**
 * Generate a random syntactically valid Solana signature (64 bytes)
 * @returns {string} Base58 encoded 64-byte signature
 */
export function generateRandomSignature() {
  const seed = new Uint8Array(randomBytes(64));
  return encodeBase58(seed);
}

/**
 * Build the signature pool from a signature file or random generation
 * @returns {string[]} Array of signatures
 */
export function buildSignaturePool() {
  if (config.signatureFile) {
    const signatureFile = resolveOpenPath(config.signatureFile);
    const fromFile = open(signatureFile)
      .split(/\s+/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (fromFile.length === 0) {
      throw new Error(`SIGNATURE_FILE (${config.signatureFile}) was provided but contained no signatures`);
    }

    console.log(`Loaded ${fromFile.length} signatures from file: ${signatureFile}`);
    return fromFile;
  }

  const pool = [];
  for (let i = 0; i < config.signaturePoolSize; i += 1) {
    pool.push(generateRandomSignature());
  }
  console.log(`Generated ${pool.length} random signatures`);
  return pool;
}

/**
 * Initialize the signature pool (call once at module load)
 */
export function initSignaturePool() {
  if (signaturePool === null) {
    signaturePool = buildSignaturePool();
  }
  return signaturePool;
}

/**
 * Get a random signature from the pool
 * @returns {string} A random signature
 */
export function randomSignature() {
  if (signaturePool === null) {
    signaturePool = buildSignaturePool();
  }
  return signaturePool[Math.floor(Math.random() * signaturePool.length)];
}

/**
 * Get an array of random signatures from the pool (may include duplicates)
 * @param {number} count
 * @returns {string[]} Random signatures
 */
export function randomSignatures(count) {
  if (signaturePool === null) {
    signaturePool = buildSignaturePool();
  }
  const total = Math.max(0, count || 0);
  const results = [];
  for (let i = 0; i < total; i += 1) {
    results.push(signaturePool[Math.floor(Math.random() * signaturePool.length)]);
  }
  return results;
}

/**
 * Get the signature pool
 * @returns {string[]} The signature pool
 */
export function getSignaturePool() {
  if (signaturePool === null) {
    signaturePool = buildSignaturePool();
  }
  return signaturePool;
}
