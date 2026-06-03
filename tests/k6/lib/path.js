// SPDX-License-Identifier: AGPL-3.0-only
/*
 * Copyright 2025-2026 Triton One Limited. All rights reserved.
 */

const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/;

export function isAbsolutePath(filePath) {
  return (
    filePath.startsWith('file://') ||
    filePath.startsWith('/') ||
    WINDOWS_ABSOLUTE_PATH.test(filePath)
  );
}

export function resolveOpenPath(filePath) {
  if (!filePath || isAbsolutePath(filePath)) {
    return filePath;
  }

  const cwd = __ENV.PWD || __ENV.INIT_CWD;
  if (cwd) {
    const normalized = filePath.replace(/^[.][\\/]/, '');
    return `${cwd.replace(/[\\/]$/, '')}/${normalized}`;
  }

  if (typeof import.meta.resolve === 'function') {
    return import.meta.resolve(filePath);
  }

  try {
    return new URL(filePath, import.meta.url).pathname;
  } catch {
    return filePath;
  }
}
