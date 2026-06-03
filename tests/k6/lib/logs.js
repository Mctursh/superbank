// SPDX-License-Identifier: AGPL-3.0-only
/*
 * Copyright 2025-2026 Triton One Limited. All rights reserved.
 */

// Log file parsing utilities for k6 load tests
// Parses HAProxy CSV logs to extract request data for replay
// Uses SharedArray to load data once and share across all VUs

import { SharedArray } from 'k6/data';
import { resolveOpenPath } from './path.js';

/**
 * Parse a CSV line handling quoted fields with embedded commas
 * @param {string} line - CSV line
 * @returns {string[]} Array of field values
 */
function parseCSVLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];

    if (inQuotes) {
      if (char === '"' && nextChar === '"') {
        current += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        current += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ',') {
        fields.push(current);
        current = '';
      } else {
        current += char;
      }
    }
  }
  fields.push(current);
  return fields;
}

/**
 * Internal: Parse CSV content and extract request data
 * @param {string} filePath - Path to CSV log file
 * @returns {Array<{timestamp: number, address: string, options: object}>} Parsed requests
 */
function parseCSVInternal(filePath) {
  const resolvedPath = resolveOpenPath(filePath);
  const content = open(resolvedPath);
  const lines = content.split('\n').filter((l) => l.trim());

  if (lines.length === 0) {
    return [];
  }

  const header = parseCSVLine(lines[0]);
  const timeIdx = header.indexOf('Time');
  const bodyIdx = header.indexOf('body');

  if (timeIdx === -1 || bodyIdx === -1) {
    throw new Error(`CSV must have 'Time' and 'body' columns. Found: ${header.join(', ')}`);
  }

  const requests = [];

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    if (fields.length <= Math.max(timeIdx, bodyIdx)) {
      continue;
    }

    const timestamp = parseInt(fields[timeIdx], 10);
    const bodyStr = fields[bodyIdx];

    if (!bodyStr) {
      continue;
    }

    try {
      const body = JSON.parse(bodyStr);
      if (body.params && body.params[0]) {
        requests.push({
          timestamp,
          address: body.params[0],
          options: body.params[1] || {},
        });
      }
    } catch (e) {
      continue;
    }
  }

  requests.sort((a, b) => a.timestamp - b.timestamp);
  return requests;
}

// Cache for shared arrays to avoid recreating them
const sharedArrayCache = {};

/**
 * Get shared array of addresses from log file (loaded once, shared across VUs)
 * @param {string} filePath - Path to CSV log file
 * @returns {SharedArray} Shared array of unique addresses
 */
export function getSharedAddresses(filePath) {
  const resolvedPath = resolveOpenPath(filePath);
  const cacheKey = `addresses:${resolvedPath}`;
  if (!sharedArrayCache[cacheKey]) {
    sharedArrayCache[cacheKey] = new SharedArray(cacheKey, function () {
      const requests = parseCSVInternal(resolvedPath);
      const addresses = [...new Set(requests.map((r) => r.address))];
      console.log(`Loaded ${addresses.length} unique addresses from: ${resolvedPath}`);
      return addresses;
    });
  }
  return sharedArrayCache[cacheKey];
}

/**
 * Get shared array of replay requests (loaded once, shared across VUs)
 * @param {string} filePath - Path to CSV log file
 * @returns {{requests: SharedArray, totalDuration: number, startTime: number, endTime: number}}
 */
export function getSharedReplayData(filePath) {
  const resolvedPath = resolveOpenPath(filePath);
  const cacheKey = `replay:${resolvedPath}`;
  if (!sharedArrayCache[cacheKey]) {
    // We need to compute metadata outside SharedArray since it only returns arrays
    const requests = parseCSVInternal(resolvedPath);

    if (requests.length === 0) {
      sharedArrayCache[cacheKey] = {
        requests: new SharedArray(cacheKey, () => []),
        totalDuration: 0,
        startTime: 0,
        endTime: 0,
      };
    } else {
      const startTime = requests[0].timestamp;
      const endTime = requests[requests.length - 1].timestamp;

      const replayRequests = requests.map((req, idx) => ({
        ...req,
        delay: idx === 0 ? 0 : req.timestamp - requests[idx - 1].timestamp,
        offsetFromStart: req.timestamp - startTime,
      }));

      console.log(`Loaded ${replayRequests.length} requests from: ${resolvedPath}`);
      console.log(`  Duration: ${((endTime - startTime) / 1000).toFixed(2)}s`);

      sharedArrayCache[cacheKey] = {
        requests: new SharedArray(cacheKey, () => replayRequests),
        totalDuration: endTime - startTime,
        startTime,
        endTime,
      };
    }
  }
  return sharedArrayCache[cacheKey];
}

// Legacy exports for backward compatibility
export function parseCSV(filePath) {
  return parseCSVInternal(filePath);
}

export function getReplayData(filePath) {
  const data = getSharedReplayData(filePath);
  return {
    requests: Array.from(data.requests),
    totalDuration: data.totalDuration,
    startTime: data.startTime,
    endTime: data.endTime,
  };
}
