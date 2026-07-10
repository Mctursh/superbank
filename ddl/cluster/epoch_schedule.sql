-- SPDX-License-Identifier: AGPL-3.0-only
--
-- Copyright 2025-2026 Triton One Limited. All rights reserved.
--

-- Cluster epoch schedule table.
-- Singleton: the schedule is immutable per cluster, so keying on slots_per_epoch
-- collapses every re-ingest to one row (ReplacingMergeTree needs a non-empty key).
CREATE TABLE IF NOT EXISTS default.epoch_schedule_local ON CLUSTER '{cluster}'
(
    slots_per_epoch              UInt64,
    leader_schedule_slot_offset  UInt64,
    warmup                       UInt8,
    first_normal_epoch           UInt64,
    first_normal_slot            UInt64
)
ENGINE = ReplacingMergeTree
ORDER BY slots_per_epoch;

CREATE TABLE IF NOT EXISTS default.epoch_schedule ON CLUSTER '{cluster}'
(
    slots_per_epoch              UInt64,
    leader_schedule_slot_offset  UInt64,
    warmup                       UInt8,
    first_normal_epoch           UInt64,
    first_normal_slot            UInt64
)
ENGINE = Distributed('{cluster}', 'default', 'epoch_schedule_local', 0);
