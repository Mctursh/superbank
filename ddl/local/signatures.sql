-- SPDX-License-Identifier: AGPL-3.0-only
--
-- Copyright 2025-2026 Triton One Limited. All rights reserved.
--

-- Local-only signature status materialized view (single-node deployments).
CREATE MATERIALIZED VIEW IF NOT EXISTS default.signatures
(
    sig_bucket UInt8 materialized cityHash64(signature) % 32,
    signature  FixedString(64),
    slot       UInt64,
    slot_idx   UInt32,
    err        Nullable(String),
    INDEX bf_signature signature TYPE bloom_filter(0.01) GRANULARITY 64
)
ENGINE = ReplacingMergeTree(slot)
PARTITION BY sig_bucket
PRIMARY KEY (sig_bucket, signature, slot, slot_idx)
ORDER BY (sig_bucket, signature, slot DESC, slot_idx)
SETTINGS
    allow_experimental_reverse_key = 1,
    index_granularity = 512,
    index_granularity_bytes = 67108864,
    min_bytes_for_wide_part = 10485760,
    compress_primary_key = 1,
    compress_marks = 1
AS
SELECT
    signature,
    slot,
    slot_idx,
    if(meta_status_ok = 1, NULL, meta_err) AS err
FROM default.transactions
ARRAY JOIN tx_signatures AS signature;
