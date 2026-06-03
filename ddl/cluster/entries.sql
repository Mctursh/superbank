-- SPDX-License-Identifier: AGPL-3.0-only
--
-- Copyright 2025-2026 Triton One Limited. All rights reserved.
--

-- Solana PoH entries emitted by Old Faithful / Jetstreamer.
CREATE TABLE IF NOT EXISTS default.entries_local ON CLUSTER '{cluster}'
(
    slot                        UInt64 CODEC(Delta, ZSTD(1)),
    entry_index                 UInt32 CODEC(Delta, ZSTD(1)),
    block_time                  Nullable(Int64) CODEC(Delta, ZSTD(1)),
    starting_transaction_index  UInt32 CODEC(Delta, ZSTD(1)),
    transaction_count           UInt32 CODEC(Delta, ZSTD(1)),
    num_hashes                  UInt64 CODEC(ZSTD(1)),
    hash                        FixedString(32),
    INDEX bf_hash hash TYPE bloom_filter(0.01) GRANULARITY 64
)
ENGINE = ReplacingMergeTree(slot)
PARTITION BY intDiv(slot, 432000) -- Solana epoch (432k slots)
ORDER BY (slot, entry_index);

CREATE TABLE IF NOT EXISTS default.entries ON CLUSTER '{cluster}'
(
    slot                        UInt64 CODEC(Delta, ZSTD(1)),
    entry_index                 UInt32 CODEC(Delta, ZSTD(1)),
    block_time                  Nullable(Int64) CODEC(Delta, ZSTD(1)),
    starting_transaction_index  UInt32 CODEC(Delta, ZSTD(1)),
    transaction_count           UInt32 CODEC(Delta, ZSTD(1)),
    num_hashes                  UInt64 CODEC(ZSTD(1)),
    hash                        FixedString(32)
)
ENGINE = Distributed('{cluster}', 'default', 'entries_local', intDiv(slot, 432000));
