// SPDX-License-Identifier: AGPL-3.0-only
/*
 * Copyright 2025-2026 Triton One Limited. All rights reserved.
 */

// Address generation and management utilities for k6 load tests

import { randomBytes } from 'k6/crypto';
import { config } from './config.js';
import { getSharedAddresses } from './logs.js';
import { resolveOpenPath } from './path.js';

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

// Address pool - initialized once at startup
let addressPool = null;

/**
 * Encode bytes to Base58 string
 * @param {Uint8Array} bytes - Bytes to encode
 * @returns {string} Base58 encoded string
 */
export function encodeBase58(bytes) {
  let digits = [0];

  for (const byte of bytes) {
    let carry = byte;

    for (let j = 0; j < digits.length; j += 1) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }

    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  // Count leading zeros
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) {
    zeros += 1;
  }

  let result = BASE58_ALPHABET[0].repeat(zeros);
  for (let q = digits.length - 1; q >= 0; q -= 1) {
    result += BASE58_ALPHABET[digits[q]];
  }

  return result;
}

/**
 * Generate a random syntactically valid Solana public key
 * @returns {string} Base58 encoded 32-byte public key
 */
export function generateRandomAddress() {
  const seed = new Uint8Array(randomBytes(32)); // 32 bytes => 256-bit Solana public key
  return encodeBase58(seed);
}

/**
 * Build the address pool from log file, address file, or random generation
 * This should be called once during setup
 * @returns {string[]} Array of addresses
 */
export function buildAddressPool() {
  // Priority: LOG_FILE > ADDRESS_FILE > random generation
  if (config.logFile) {
    const addresses = getSharedAddresses(config.logFile);

    if (addresses.length === 0) {
      throw new Error(`LOG_FILE (${config.logFile}) was provided but contained no addresses`);
    }

    return Array.from(addresses);
  }

  if (config.addressFile) {
    const addressFile = resolveOpenPath(config.addressFile);
    const fromFile = open(addressFile)
      .split(/\s+/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (fromFile.length === 0) {
      throw new Error(`ADDRESS_FILE (${config.addressFile}) was provided but contained no addresses`);
    }

    console.log(`Loaded ${fromFile.length} addresses from file: ${addressFile}`);
    return fromFile;
  }

  const pool = [];
  for (let i = 0; i < config.addressPoolSize; i += 1) {
    pool.push(generateRandomAddress());
  }
  console.log(`Generated ${pool.length} random addresses`);
  return pool;
}

/**
 * Initialize the address pool (call once at module load)
 */
export function initAddressPool() {
  if (addressPool === null) {
    addressPool = buildAddressPool();
  }
  return addressPool;
}

/**
 * Get a random address from the pool
 * @returns {string} A random address
 */
export function randomAddress() {
  if (addressPool === null) {
    addressPool = buildAddressPool();
  }
  return addressPool[Math.floor(Math.random() * addressPool.length)];
}

/**
 * Get the address pool
 * @returns {string[]} The address pool
 */
export function getAddressPool() {
  if (addressPool === null) {
    addressPool = buildAddressPool();
  }
  return addressPool;
}
