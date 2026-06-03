#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# Copyright 2025-2026 Triton One Limited. All rights reserved.
#

set -euo pipefail

# Verify that each shard's local table only contains rows that map to that shard
# according to the Distributed table sharding key expression.

die() {
  echo "error: $*" >&2
  exit 1
}

warn() {
  echo "warn: $*" >&2
}

trim_whitespace() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}


# Required/optional settings
CLICKHOUSE_HOST=${CLICKHOUSE_HOST:-localhost}
CLICKHOUSE_PORT=${CLICKHOUSE_PORT:-9000}
CLICKHOUSE_USER=${CLICKHOUSE_USER:-default}
CLICKHOUSE_PASSWORD=${CLICKHOUSE_PASSWORD:-}
CLICKHOUSE_DATABASE=${CLICKHOUSE_DATABASE:-default}
CLICKHOUSE_CLUSTER=${CLICKHOUSE_CLUSTER:-default}

# Target distributed table (used to discover sharding key + local table).
CLICKHOUSE_DISTRIBUTED_TABLE=${CLICKHOUSE_DISTRIBUTED_TABLE:-transactions}
# Optional override of local table (db.table or table).
CLICKHOUSE_LOCAL_TABLE=${CLICKHOUSE_LOCAL_TABLE:-}
# Optional override of sharding key expression.
CLICKHOUSE_SHARDING_KEY_EXPR=${CLICKHOUSE_SHARDING_KEY_EXPR:-}

CH_ARGS=(--host "$CLICKHOUSE_HOST" --port "$CLICKHOUSE_PORT" --user "$CLICKHOUSE_USER" --database "$CLICKHOUSE_DATABASE")
if [[ -n "$CLICKHOUSE_PASSWORD" ]]; then
  CH_ARGS+=(--password "$CLICKHOUSE_PASSWORD")
fi

clickhouse_query() {
  local query="$1"
  clickhouse client "${CH_ARGS[@]}" --query "$query"
}

clickhouse_query_host() {
  local host="$1"
  local query="$2"
  local args=(--host "$host" --port "$CLICKHOUSE_PORT" --user "$CLICKHOUSE_USER" --database "$CLICKHOUSE_DATABASE")
  if [[ -n "$CLICKHOUSE_PASSWORD" ]]; then
    args+=(--password "$CLICKHOUSE_PASSWORD")
  fi
  clickhouse client "${args[@]}" --query "$query"
}

if [[ -z "$CLICKHOUSE_SHARDING_KEY_EXPR" ]]; then
  shard_expr="$(clickhouse_query "SELECT nullIf(replaceRegexpOne(engine_full, '^Distributed\\([^,]+,\\s*[^,]+,\\s*[^,]+,\\s*(.*)\\)$', '\\\\1'), engine_full) FROM system.tables WHERE database='${CLICKHOUSE_DATABASE}' AND name='${CLICKHOUSE_DISTRIBUTED_TABLE}' FORMAT TabSeparated")" || die "unable to query sharding key expression"
  shard_expr="$(trim_whitespace "$shard_expr")"
  if [[ -z "$shard_expr" || "$shard_expr" == "\\N" ]]; then
    die "unable to resolve sharding key expression for ${CLICKHOUSE_DATABASE}.${CLICKHOUSE_DISTRIBUTED_TABLE}"
  fi
  CLICKHOUSE_SHARDING_KEY_EXPR="$shard_expr"
fi

if [[ -z "$CLICKHOUSE_LOCAL_TABLE" ]]; then
  local_tuple="$(clickhouse_query "SELECT
      extract(engine_full, 'Distributed\\\\([^,]+,\\\\s*''([^'']+)''') AS local_db,
      extract(engine_full, 'Distributed\\\\([^,]+,\\\\s*''[^'']+''\\\\s*,\\\\s*''([^'']+)''') AS local_table
    FROM system.tables
    WHERE database='${CLICKHOUSE_DATABASE}' AND name='${CLICKHOUSE_DISTRIBUTED_TABLE}'
    FORMAT TabSeparated")" || die "unable to query local table for ${CLICKHOUSE_DATABASE}.${CLICKHOUSE_DISTRIBUTED_TABLE}"
  local_db="$(trim_whitespace "${local_tuple%%$'\t'*}")"
  local_tbl="$(trim_whitespace "${local_tuple#*$'\t'}")"
  if [[ -z "$local_db" || -z "$local_tbl" ]]; then
    die "failed to parse local table from engine_full for ${CLICKHOUSE_DATABASE}.${CLICKHOUSE_DISTRIBUTED_TABLE}"
  fi
  CLICKHOUSE_LOCAL_TABLE="${local_db}.${local_tbl}"
fi

cluster_rows="$(clickhouse_query "SELECT shard_num, shard_weight, if(host_address = '', host_name, host_address) AS host FROM system.clusters WHERE cluster='${CLICKHOUSE_CLUSTER}' AND replica_num=1 ORDER BY shard_num FORMAT TabSeparated")" \
  || die "unable to query system.clusters for cluster '${CLICKHOUSE_CLUSTER}'"

declare -a shard_nums shard_weights shard_hosts
total_weight=0
while IFS=$'\t' read -r shard_num shard_weight host; do
  if [[ -z "$shard_num" || -z "$shard_weight" || -z "$host" ]]; then
    continue
  fi
  shard_nums+=("$shard_num")
  shard_weights+=("$shard_weight")
  shard_hosts+=("$host")
  total_weight=$((total_weight + shard_weight))
done <<<"$cluster_rows"

if (( total_weight == 0 )); then
  die "cluster '${CLICKHOUSE_CLUSTER}' has no shards or weights are zero"
fi

echo "checking ${CLICKHOUSE_LOCAL_TABLE} against sharding key: ${CLICKHOUSE_SHARDING_KEY_EXPR}"
echo "cluster=${CLICKHOUSE_CLUSTER} total_weight=${total_weight}"

prev_cum=0
for idx in "${!shard_nums[@]}"; do
  shard_num="${shard_nums[$idx]}"
  shard_weight="${shard_weights[$idx]}"
  shard_host="${shard_hosts[$idx]}"
  lower=$prev_cum
  upper=$((prev_cum + shard_weight))

  mismatch_query="WITH
    ${CLICKHOUSE_SHARDING_KEY_EXPR} AS shard_key,
    toUInt64(${total_weight}) AS total_weight,
    toUInt64(${lower}) AS lower,
    toUInt64(${upper}) AS upper
  SELECT count()
  FROM ${CLICKHOUSE_LOCAL_TABLE}
  WHERE (shard_key % total_weight) < lower
     OR (shard_key % total_weight) >= upper
  FORMAT TabSeparated"

  mismatch_count="$(clickhouse_query_host "$shard_host" "$mismatch_query" || echo "ERROR")"
  if [[ "$mismatch_count" == "ERROR" ]]; then
    warn "shard ${shard_num} (${shard_host}) query failed"
  else
    mismatch_count="$(trim_whitespace "$mismatch_count")"
    echo "shard ${shard_num} (${shard_host}) mismatched_rows=${mismatch_count}"
  fi

  prev_cum=$upper
done
