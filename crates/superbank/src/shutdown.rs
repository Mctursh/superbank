// SPDX-License-Identifier: AGPL-3.0-only
/*
 * Copyright 2025-2026 Triton One Limited. All rights reserved.
 */

use tokio::sync::watch;

pub(crate) fn spawn_shutdown_watch() -> watch::Receiver<u64> {
    let (shutdown_tx, shutdown_rx) = watch::channel(0u64);
    tokio::spawn(async move {
        let mut count = 0u64;
        loop {
            if tokio::signal::ctrl_c().await.is_err() {
                break;
            }
            count += 1;
            let _ = shutdown_tx.send(count);
        }
    });
    shutdown_rx
}
