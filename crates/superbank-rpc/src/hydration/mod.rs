// SPDX-License-Identifier: AGPL-3.0-only
/*
 * Copyright 2025-2026 Triton One Limited. All rights reserved.
 */

mod block;
mod errors;
mod meta;
mod transaction;

pub(crate) use block::hydrate_block_payload;
pub(crate) use errors::{BlockHydrationError, TransactionHydrationError};
pub(crate) use meta::parse_transaction_error_display;
pub(crate) use transaction::hydrate_transaction_record;

#[cfg(test)]
pub(crate) use block::hydrate_block_record;
#[cfg(test)]
pub(crate) use meta::{build_transaction_status_meta, parse_instruction_error_display};
#[cfg(test)]
pub(crate) use transaction::build_versioned_transaction;
