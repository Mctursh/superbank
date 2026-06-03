// SPDX-License-Identifier: AGPL-3.0-only
/*
 * Copyright 2025-2026 Triton One Limited. All rights reserved.
 */

use anyhow::{Result, anyhow};
use solana_commitment_config::CommitmentConfig;
use yellowstone_grpc_proto::prelude::CommitmentLevel;

pub(crate) fn parse_commitment_level(value: &str) -> Result<CommitmentLevel> {
    let normalized = value.trim().to_lowercase();
    let level = match normalized.as_str() {
        "processed" => CommitmentLevel::Processed,
        "confirmed" => CommitmentLevel::Confirmed,
        "finalized" => CommitmentLevel::Finalized,
        _ => return Err(anyhow!("invalid commitment '{value}'")),
    };

    Ok(level)
}

pub(crate) fn parse_commitment_config(value: &str) -> Result<CommitmentConfig> {
    let normalized = value.trim().to_lowercase();
    let config = match normalized.as_str() {
        "processed" => CommitmentConfig::processed(),
        "confirmed" => CommitmentConfig::confirmed(),
        "finalized" => CommitmentConfig::finalized(),
        _ => return Err(anyhow!("invalid commitment '{value}'")),
    };

    Ok(config)
}
