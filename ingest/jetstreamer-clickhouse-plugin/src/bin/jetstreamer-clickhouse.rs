// SPDX-License-Identifier: AGPL-3.0-only
/*
 * Copyright 2025-2026 Triton One Limited. All rights reserved.
 */

use jetstreamer::JetstreamerRunner;
use jetstreamer_clickhouse_plugin::{ClickhouseIngestConfig, ClickhouseIngestPlugin};
use jetstreamer_firehose::epochs;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() || args.len() > 1 || args[0] == "-h" || args[0] == "--help" {
        eprintln!("usage: jetstreamer-clickhouse <epoch|start:end>");
        std::process::exit(1);
    }

    let (start_slot, end_exclusive) = if let Some((start, end)) = args[0].split_once(':') {
        let start_slot: u64 = start.parse().map_err(|_| "invalid start slot")?;
        let end_slot: u64 = end.parse().map_err(|_| "invalid end slot")?;
        if start_slot > end_slot {
            return Err("start slot must be <= end slot".into());
        }
        (start_slot, end_slot + 1)
    } else {
        let epoch: u64 = args[0].parse().map_err(|_| "invalid epoch")?;
        let (start, end_inclusive) = epochs::epoch_to_slot_range(epoch);
        (start, end_inclusive + 1)
    };

    let threads = std::env::var("JETSTREAMER_THREADS")
        .ok()
        .and_then(|raw| raw.parse::<usize>().ok())
        .unwrap_or_else(jetstreamer_firehose::system::optimal_firehose_thread_count);

    let plugin = ClickhouseIngestPlugin::new(ClickhouseIngestConfig::default(), threads);

    JetstreamerRunner::default()
        .with_log_level("info")
        .with_threads(threads)
        .with_slot_range(start_slot..end_exclusive)
        .with_plugin(Box::new(plugin))
        .run()
        .map_err(|err| -> Box<dyn std::error::Error> { Box::new(err) })
}
