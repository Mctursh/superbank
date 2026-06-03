// SPDX-License-Identifier: AGPL-3.0-only
/*
 * Copyright 2025-2026 Triton One Limited. All rights reserved.
 */

use std::collections::HashMap;

use tracing::{info, warn};

use crate::config::{PyroscopeCompression, PyroscopeReportEncoding, RpcConfig};

pub type PyroscopeRunningAgent =
    pyroscope::PyroscopeAgent<pyroscope::pyroscope::PyroscopeAgentRunning>;

pub fn start_pyroscope(cfg: &RpcConfig) -> Option<PyroscopeRunningAgent> {
    if !cfg.pyroscope_enabled {
        return None;
    }

    let url = match cfg
        .pyroscope_url
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        Some(v) => v,
        None => {
            warn!(
                "--pyroscope set but PYROSCOPE_URL/--pyroscope-url is missing; profiling disabled"
            );
            return None;
        }
    };

    let mut pprof_cfg =
        pyroscope_pprofrs::PprofConfig::new().sample_rate(cfg.pyroscope_sample_rate);
    if cfg.pyroscope_report_thread_name {
        pprof_cfg = pprof_cfg.report_thread_name();
    }
    if cfg.pyroscope_report_thread_id {
        pprof_cfg = pprof_cfg.report_thread_id();
    }

    let backend = pyroscope_pprofrs::pprof_backend(pprof_cfg);

    let mut builder =
        pyroscope::PyroscopeAgent::builder(url, cfg.pyroscope_app_name.as_str()).backend(backend);

    builder = builder.report_encoding(match cfg.pyroscope_report_encoding {
        PyroscopeReportEncoding::Pprof => pyroscope::pyroscope::ReportEncoding::PPROF,
        PyroscopeReportEncoding::Folded => pyroscope::pyroscope::ReportEncoding::FOLDED,
    });

    match cfg.pyroscope_compression {
        PyroscopeCompression::Gzip => {
            builder = builder.compression(pyroscope::pyroscope::Compression::GZIP);
        }
        PyroscopeCompression::Off => {}
    }

    let tags = parse_key_value_list(&cfg.pyroscope_tags, "pyroscope tag");
    if !tags.is_empty() {
        let tags_ref: Vec<(&str, &str)> =
            tags.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        builder = builder.tags(tags_ref);
    }

    if let Some(token) = cfg
        .pyroscope_auth_token
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        builder = builder.auth_token(token);
    } else if let Some(user) = cfg
        .pyroscope_basic_auth_user
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        match cfg
            .pyroscope_basic_auth_pass
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            Some(pass) => {
                builder = builder.basic_auth(user, pass);
            }
            None => warn!(
                "PYROSCOPE_BASIC_AUTH_USER is set but PYROSCOPE_BASIC_AUTH_PASS is missing; ignoring basic auth"
            ),
        }
    }

    if let Some(tenant_id) = cfg
        .pyroscope_tenant_id
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        builder = builder.tenant_id(tenant_id.to_string());
    }

    let headers = parse_headers(&cfg.pyroscope_http_headers);
    if !headers.is_empty() {
        builder = builder.http_headers(headers);
    }

    let agent = match builder.build() {
        Ok(agent) => agent,
        Err(err) => {
            warn!("Failed to initialize pyroscope agent: {err}");
            return None;
        }
    };

    match agent.start() {
        Ok(running) => {
            info!(
                "Pyroscope profiling enabled (app={}, sample_rate={})",
                cfg.pyroscope_app_name, cfg.pyroscope_sample_rate
            );
            Some(running)
        }
        Err(err) => {
            warn!("Failed to start pyroscope agent: {err}");
            None
        }
    }
}

fn parse_key_value_list(values: &[String], kind: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for raw in values {
        let value = raw.trim();
        if value.is_empty() {
            continue;
        }

        let Some((k, v)) = value.split_once('=') else {
            warn!("Invalid {kind} '{value}' (expected key=value); ignoring");
            continue;
        };

        let k = k.trim();
        let v = v.trim();
        if k.is_empty() || v.is_empty() {
            warn!("Invalid {kind} '{value}' (empty key/value); ignoring");
            continue;
        }

        out.push((k.to_string(), v.to_string()));
    }
    out
}

fn parse_headers(values: &[String]) -> HashMap<String, String> {
    let mut headers = HashMap::new();
    for (k, v) in parse_key_value_list(values, "pyroscope http header") {
        headers.insert(k, v);
    }
    headers
}
