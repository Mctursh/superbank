// SPDX-License-Identifier: AGPL-3.0-only
/*
 * Copyright 2025-2026 Triton One Limited. All rights reserved.
 */

fn main() {
    println!("cargo:rerun-if-env-changed=SUPERBANK_GIT_SHA");
    println!("cargo:rerun-if-env-changed=GITHUB_SHA");

    let sha = std::env::var("SUPERBANK_GIT_SHA")
        .ok()
        .or_else(|| std::env::var("GITHUB_SHA").ok())
        .unwrap_or_default();

    let sha = sha.trim();
    if sha.is_empty() {
        return;
    }

    println!("cargo:rustc-env=SUPERBANK_GIT_SHA={sha}");
}
