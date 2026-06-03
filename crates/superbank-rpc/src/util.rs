// SPDX-License-Identifier: AGPL-3.0-only
/*
 * Copyright 2025-2026 Triton One Limited. All rights reserved.
 */

use axum::{http::HeaderValue, response::Response};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::clickhouse::QueryTimings;

const HEADER_X_SUPERBANK_SOURCES_TOUCHED: &str = "X-Superbank-Sources";
const HEADER_X_SUPERBANK_CLICKHOUSE_METRICS: &str = "X-Superbank-Metrics";

#[derive(Clone, Debug)]
struct DownstreamTimingsExtension(QueryTimings);

pub(crate) fn current_time_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_secs(0))
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

pub(crate) fn ttl_millis(ttl: Duration) -> u64 {
    ttl.as_millis().min(u128::from(u64::MAX)) as u64
}

pub(crate) fn add_downstream_header(resp: &mut Response, timings: &QueryTimings) {
    if let Some(existing) = resp
        .extensions_mut()
        .get_mut::<DownstreamTimingsExtension>()
    {
        existing.0.add(timings.clone());
    } else {
        resp.extensions_mut()
            .insert(DownstreamTimingsExtension(timings.clone()));
    }
}

pub(crate) fn extract_downstream_timings(resp: &Response) -> Option<QueryTimings> {
    resp.extensions()
        .get::<DownstreamTimingsExtension>()
        .map(|extension| extension.0.clone())
}

pub(crate) fn format_superbank_clickhouse_metrics_header(
    rows_read: Option<u64>,
    rows_returned: u64,
    data_read_bytes: u64,
) -> String {
    let rows_read = match rows_read {
        Some(value) => value.to_string(),
        None => "unknown".to_string(),
    };
    format!("rows_read={rows_read};rows_returned={rows_returned};data_read_bytes={data_read_bytes}")
}

pub(crate) fn add_superbank_response_metrics_headers(
    resp: &mut Response,
    sources_touched: &str,
    rows_read: Option<u64>,
    rows_returned: u64,
    data_read_bytes: u64,
) {
    if let Ok(value) = HeaderValue::from_str(sources_touched) {
        resp.headers_mut()
            .insert(HEADER_X_SUPERBANK_SOURCES_TOUCHED, value);
    }
    if let Ok(value) = HeaderValue::from_str(&format_superbank_clickhouse_metrics_header(
        rows_read,
        rows_returned,
        data_read_bytes,
    )) {
        resp.headers_mut()
            .insert(HEADER_X_SUPERBANK_CLICKHOUSE_METRICS, value);
    }
}
