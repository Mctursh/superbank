// SPDX-License-Identifier: AGPL-3.0-only
/*
 * Copyright 2025-2026 Triton One Limited. All rights reserved.
 */

use std::{sync::Arc, time::Duration};

use anyhow::{Context, Result};
use solana_commitment_config::CommitmentConfig;
use solana_rpc_client::{
    http_sender::HttpSender, nonblocking::rpc_client::RpcClient, rpc_client::RpcClientConfig,
};

pub(crate) fn build_rpc_client(
    url: &str,
    commitment: CommitmentConfig,
    timeout_secs: u64,
    max_idle_per_host: usize,
) -> Result<Arc<RpcClient>> {
    let timeout = Duration::from_secs(timeout_secs);
    let client = reqwest::Client::builder()
        .default_headers(HttpSender::default_headers())
        .timeout(timeout)
        .pool_idle_timeout(timeout)
        .pool_max_idle_per_host(max_idle_per_host)
        .build()
        .context("build rpc http client")?;
    let sender = HttpSender::new_with_client(url.to_string(), client);
    let rpc_client = RpcClient::new_sender(sender, RpcClientConfig::with_commitment(commitment));
    Ok(Arc::new(rpc_client))
}
