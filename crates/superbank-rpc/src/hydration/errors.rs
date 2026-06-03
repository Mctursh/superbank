// SPDX-License-Identifier: AGPL-3.0-only
/*
 * Copyright 2025-2026 Triton One Limited. All rights reserved.
 */

use solana_transaction_status::EncodeError;
use thiserror::Error;

#[derive(Debug, Error)]
pub(crate) enum TransactionHydrationError {
    #[error("invalid stored transaction: {0}")]
    InvalidStoredTransaction(String),
    #[error("invalid stored metadata: {0}")]
    InvalidStoredMetadata(String),
    #[error("failed to parse transaction error: {0}")]
    TransactionErrorParse(String),
    #[error(transparent)]
    Encode(#[from] EncodeError),
}

#[derive(Debug, Error)]
pub(crate) enum BlockHydrationError {
    #[error(transparent)]
    Transaction(#[from] TransactionHydrationError),
    #[error("invalid stored block metadata: {0}")]
    InvalidBlockMetadata(String),
    #[error(transparent)]
    Encode(#[from] EncodeError),
}
