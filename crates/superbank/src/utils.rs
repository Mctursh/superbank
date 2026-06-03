// SPDX-License-Identifier: AGPL-3.0-only
/*
 * Copyright 2025-2026 Triton One Limited. All rights reserved.
 */

use anyhow::{Context, Result, anyhow};
use serde_big_array::Array;

pub(crate) fn decode_base58_32(value: &str) -> Result<Array<u8, 32>> {
    let bytes = bs58::decode(value)
        .into_vec()
        .with_context(|| format!("invalid base58 value '{value}'"))?;
    bytes_to_array::<32>(&bytes)
}

pub(crate) fn bytes_to_array<const N: usize>(value: &[u8]) -> Result<Array<u8, N>> {
    let arr: [u8; N] = value
        .try_into()
        .map_err(|_| anyhow!("expected {N} bytes, got {}", value.len()))?;
    Ok(Array(arr))
}
