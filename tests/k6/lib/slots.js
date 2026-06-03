// SPDX-License-Identifier: AGPL-3.0-only
/*
 * Copyright 2025-2026 Triton One Limited. All rights reserved.
 */

// Slot generation and management utilities for k6 getBlock tests

import { config } from './config.js';
import { resolveOpenPath } from './path.js';

const DEFAULT_SLOT_RANGE = 1_000_000;

// Slot pool - initialized once at startup
let slotPool = null;

/**
 * Generate a random slot within a range
 * @param {number} min - Minimum slot (inclusive)
 * @param {number} max - Maximum slot (inclusive)
 * @returns {number} Random slot
 */
export function generateRandomSlot(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Build the slot pool from a slot file or random generation
 * @returns {number[]} Array of slots
 */
export function buildSlotPool() {
  if (config.slotFile) {
    const slotFile = resolveOpenPath(config.slotFile);
    const tokens = open(slotFile)
      .split(/\s+/)
      .map((entry) => entry.trim())
      .filter(Boolean);

    const slots = [];
    for (const token of tokens) {
      const value = Number(token);
      if (Number.isFinite(value) && value >= 0) {
        slots.push(value);
      }
    }

    if (slots.length === 0) {
      throw new Error(`SLOT_FILE (${config.slotFile}) was provided but contained no slots`);
    }

    if (slots.length !== tokens.length) {
      console.log(
        `Loaded ${slots.length} slots from file (ignored ${tokens.length - slots.length} invalid entries): ${slotFile}`
      );
    } else {
      console.log(`Loaded ${slots.length} slots from file: ${slotFile}`);
    }

    return slots;
  }

  const useEpochRange =
    config.slotEpochMin !== null || config.slotEpochMax !== null;

  if (useEpochRange) {
    const epochMin = config.slotEpochMin === null ? 0 : config.slotEpochMin;
    const epochMax =
      config.slotEpochMax === null ? epochMin : config.slotEpochMax;

    if (!Number.isFinite(epochMin) || epochMin < 0) {
      throw new Error(`SLOT_EPOCH_MIN must be >= 0 (got ${config.slotEpochMin})`);
    }

    if (!Number.isFinite(epochMax) || epochMax < epochMin) {
      throw new Error(`SLOT_EPOCH_MAX must be >= SLOT_EPOCH_MIN (got ${config.slotEpochMax})`);
    }

    if (!Number.isFinite(config.slotSlotsPerEpoch) || config.slotSlotsPerEpoch <= 0) {
      throw new Error(
        `SLOT_SLOTS_PER_EPOCH must be > 0 (got ${config.slotSlotsPerEpoch})`
      );
    }

    const pool = [];
    for (let i = 0; i < config.slotPoolSize; i += 1) {
      const epoch =
        Math.floor(Math.random() * (epochMax - epochMin + 1)) + epochMin;
      const slotOffset = Math.floor(Math.random() * config.slotSlotsPerEpoch);
      pool.push(epoch * config.slotSlotsPerEpoch + slotOffset);
    }

    console.log(
      `Generated ${pool.length} random slots from epochs ${epochMin}-${epochMax} (slots/epoch=${config.slotSlotsPerEpoch})`
    );
    return pool;
  }

  const min = config.slotMin;
  const max = config.slotMax === null ? min + DEFAULT_SLOT_RANGE : config.slotMax;

  if (!Number.isFinite(min) || min < 0) {
    throw new Error(`SLOT_MIN must be a non-negative number (got ${config.slotMin})`);
  }

  if (!Number.isFinite(max) || max < min) {
    throw new Error(`SLOT_MAX must be >= SLOT_MIN (got ${config.slotMax})`);
  }

  if (config.slotMax === null) {
    console.log(
      `SLOT_MAX not set; generating random slots in [${min}, ${max}]. Set SLOT_FILE for real data.`
    );
  }

  const pool = [];
  for (let i = 0; i < config.slotPoolSize; i += 1) {
    pool.push(generateRandomSlot(min, max));
  }
  console.log(`Generated ${pool.length} random slots`);
  return pool;
}

/**
 * Initialize the slot pool (call once at module load)
 */
export function initSlotPool() {
  if (slotPool === null) {
    slotPool = buildSlotPool();
  }
  return slotPool;
}

/**
 * Get a random slot from the pool
 * @returns {number} A random slot
 */
export function randomSlot() {
  if (slotPool === null) {
    slotPool = buildSlotPool();
  }
  return slotPool[Math.floor(Math.random() * slotPool.length)];
}

/**
 * Get the slot pool
 * @returns {number[]} The slot pool
 */
export function getSlotPool() {
  if (slotPool === null) {
    slotPool = buildSlotPool();
  }
  return slotPool;
}
