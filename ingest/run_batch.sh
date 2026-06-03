#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# Copyright 2025-2026 Triton One Limited. All rights reserved.
#

set -euo pipefail

# Assumptions:
# - epoch is a non-negative integer or an inclusive range start-end of non-negative integers.
# - ranges run sequentially, counting up or down based on start/end.
# - a writable log file path is available (defaults to SCRIPT_DIR/run_epoch_local.log).
# - the ingest ClickHouse DSN is a URL we can swap the host on (scheme://[user:pass@]host[:port][/...]).
# - the jetstreamer-clickhouse wrapper binary is available or buildable via cargo.
# - empty env vars are acceptable where k8s would have omitted them.
# - DSNs and endpoints are valid.

# Print usage text to stderr.
usage() {
  cat <<'USAGE'
Usage: run_batch.sh <epoch|start-end>

Overrides:
  JETSTREAMER_WRAPPER_DIR    path to jetstreamer-clickhouse-plugin directory
  JETSTREAMER_WRAPPER_BIN    path to jetstreamer-clickhouse binary
  JETSTREAMER_WRAPPER_ARGS   extra args for the wrapper binary
  RUN_EPOCH_LOG_FILE         log file path for epoch start times
  CLICKHOUSE_CLUSTER         cluster name for distributed table (default default)
  CLICKHOUSE_DATABASE        distributed table database (default default)
  CLICKHOUSE_TABLE           distributed table name (default transactions)
  CLICKHOUSE_SHARDING_KEY_EXPR override sharding key expression (optional)
  CLICKHOUSE_HOST_BASE       base for the host range (default 127.0.0)
  CLICKHOUSE_HOST_START      starting host octet (default 1)
  CLICKHOUSE_HOST_END        ending host octet (default 1)
  Any JETSTREAMER_* env var
USAGE
}

# Print an error message and exit non-zero.
die() {
  echo "error: $*" >&2
  exit 1
}

# Print a warning message to stderr.
warn() {
  echo "warn: $*" >&2
}

# Set a variable to a default if it is unset or empty.
set_default() {
  local name="$1"
  local value="$2"
  if [[ -z "${!name+x}" || -z "${!name}" ]]; then
    printf -v "$name" '%s' "$value"
  fi
}

# Set a default value and export the variable.
export_default() {
  local name="$1"
  local value="$2"
  set_default "$name" "$value"
  export "$name"
}

if [[ ${1:-} == "-h" || ${1:-} == "--help" || $# -lt 1 ]]; then
  usage
  exit 1
fi

RUST_LOG="info,solana_metrics::metrics=warn,superbank::clickhouse=warn"

EPOCH_ARG="$1"
START_EPOCH=""
END_EPOCH=""
if [[ "$EPOCH_ARG" =~ ^[0-9]+$ ]]; then
  START_EPOCH="$EPOCH_ARG"
  END_EPOCH="$EPOCH_ARG"
elif [[ "$EPOCH_ARG" =~ ^([0-9]+)-([0-9]+)$ ]]; then
  START_EPOCH="${BASH_REMATCH[1]}"
  END_EPOCH="${BASH_REMATCH[2]}"
else
  die "epoch must be a non-negative integer or range start-end"
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
set_default JETSTREAMER_WRAPPER_DIR "$SCRIPT_DIR/jetstreamer-clickhouse-plugin"
set_default JETSTREAMER_WRAPPER_BIN "$JETSTREAMER_WRAPPER_DIR/target/release/jetstreamer-clickhouse"
set_default JETSTREAMER_WRAPPER_ARGS ""
set_default RUN_EPOCH_LOG_FILE "$SCRIPT_DIR/run_epoch_local.log"
set_default CLICKHOUSE_HOST_BASE "127.0.0"
set_default CLICKHOUSE_HOST_START "1"
set_default CLICKHOUSE_HOST_END "1"
set_default CLICKHOUSE_CLUSTER "default"
set_default CLICKHOUSE_DATABASE "default"
set_default CLICKHOUSE_TABLE "transactions"
set_default CLICKHOUSE_SHARDING_KEY_EXPR ""


export JETSTREAMER_HTTP_BASE_URL="${JETSTREAMER_HTTP_BASE_URL:-${JETSTREAMER_ARCHIVE_BASE:-http://localhost:8080}}"
export JETSTREAMER_COMPACT_INDEX_BASE_URL="${JETSTREAMER_COMPACT_INDEX_BASE_URL:-https://files.old-faithful.net}"

for entry in \
  "JETSTREAMER_CLICKHOUSE_MODE=remote" \
  "JETSTREAMER_CLICKHOUSE_DSN=http://localhost:8123" \
  "JETSTREAMER_CLICKHOUSE_FLUSH_MAX_ROWS=1000000" \
  "JETSTREAMER_CLICKHOUSE_FLUSH_MAX_BYTES=52428800" \
  "JETSTREAMER_CLICKHOUSE_FLUSH_INTERVAL_MS=30000" \
  "JETSTREAMER_CLICKHOUSE_MAX_INFLIGHT_BATCHES=8" \
  "JETSTREAMER_CLICKHOUSE_PENDING_TX_CAPACITY=4096" \
  "JETSTREAMER_CLICKHOUSE_RETRY_MAX=5" \
  "JETSTREAMER_CLICKHOUSE_RETRY_BACKOFF_MS=50" \
  "JETSTREAMER_CLICKHOUSE_ASYNC_INSERT=true" \
  "JETSTREAMER_CLICKHOUSE_WAIT_FOR_ASYNC_INSERT=false" \
  "JETSTREAMER_THREADS=48" \
  "RUST_LOG=info"; do
  export_default "${entry%%=*}" "${entry#*=}"
done


INGEST_CLICKHOUSE_DSN_RAW="${JETSTREAMER_INGEST_CLICKHOUSE_DSN:-$JETSTREAMER_CLICKHOUSE_DSN}"

# Ensure the wrapper binary exists, building it if needed.
ensure_wrapper() {
  if [[ -x "$JETSTREAMER_WRAPPER_BIN" ]]; then
    return 0
  fi
  if [[ ! -d "$JETSTREAMER_WRAPPER_DIR" ]]; then
    die "jetstreamer-clickhouse-plugin directory not found at $JETSTREAMER_WRAPPER_DIR"
  fi
  if ! command -v cargo >/dev/null 2>&1; then
    die "cargo is required to build jetstreamer-clickhouse (set JETSTREAMER_WRAPPER_BIN to a prebuilt binary)"
  fi
  (cd "$JETSTREAMER_WRAPPER_DIR" && cargo build --release --bin jetstreamer-clickhouse)
}

# Validate that a numeric argument is within an inclusive range.
require_int_in_range() {
  local name="$1"
  local value="$2"
  local min="$3"
  local max="$4"
  if [[ ! "$value" =~ ^[0-9]+$ ]]; then
    die "$name must be an integer"
  fi
  if (( value < min || value > max )); then
    die "$name must be within ${min}-${max}"
  fi
}

ensure_wrapper
read -r -a WRAPPER_ARGS <<<"$JETSTREAMER_WRAPPER_ARGS"

require_int_in_range "CLICKHOUSE_HOST_START" "$CLICKHOUSE_HOST_START" 0 255
require_int_in_range "CLICKHOUSE_HOST_END" "$CLICKHOUSE_HOST_END" 0 255
if (( CLICKHOUSE_HOST_START > CLICKHOUSE_HOST_END )); then
  die "CLICKHOUSE_HOST_START must be <= CLICKHOUSE_HOST_END"
fi
if [[ ! "$INGEST_CLICKHOUSE_DSN_RAW" =~ ^([^:]+://)([^@/]+@)?([^:/]+)(.*)$ ]]; then
  die "JETSTREAMER_INGEST_CLICKHOUSE_DSN must look like scheme://[user:pass@]host[:port][/...]"
fi
INGEST_DSN_PREFIX="${BASH_REMATCH[1]}${BASH_REMATCH[2]}"
INGEST_DSN_SUFFIX="${BASH_REMATCH[4]}"
CLICKHOUSE_HOST_COUNT=$((CLICKHOUSE_HOST_END - CLICKHOUSE_HOST_START + 1))

# Trim leading and trailing whitespace from a string.
trim_whitespace() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

CLICKHOUSE_QUERY_AVAILABLE="false"
if command -v curl >/dev/null 2>&1 && [[ "$INGEST_CLICKHOUSE_DSN_RAW" =~ ^(https?)://([^@/]+@)?([^:/]+)(:([0-9]+))?(/.*)?$ ]]; then
  CLICKHOUSE_QUERY_AVAILABLE="true"
  CLICKHOUSE_QUERY_SCHEME="${BASH_REMATCH[1]}"
  CLICKHOUSE_QUERY_AUTH_RAW="${BASH_REMATCH[2]}"
  CLICKHOUSE_QUERY_HOST="${BASH_REMATCH[3]}"
  CLICKHOUSE_QUERY_PORT="${BASH_REMATCH[5]:-8123}"
  CLICKHOUSE_QUERY_PATH="${BASH_REMATCH[6]:-}"
fi

if [[ "$CLICKHOUSE_QUERY_AVAILABLE" == "true" ]]; then
  if [[ -n "$CLICKHOUSE_QUERY_AUTH_RAW" ]]; then
    CLICKHOUSE_QUERY_AUTH_RAW="${CLICKHOUSE_QUERY_AUTH_RAW%@}"
    if [[ "$CLICKHOUSE_QUERY_AUTH_RAW" == *:* ]]; then
      CLICKHOUSE_QUERY_USER="${CLICKHOUSE_QUERY_AUTH_RAW%%:*}"
      CLICKHOUSE_QUERY_PASS="${CLICKHOUSE_QUERY_AUTH_RAW#*:}"
    else
      CLICKHOUSE_QUERY_USER="$CLICKHOUSE_QUERY_AUTH_RAW"
      CLICKHOUSE_QUERY_PASS=""
    fi
  else
    CLICKHOUSE_QUERY_USER=""
    CLICKHOUSE_QUERY_PASS=""
  fi
  CLICKHOUSE_QUERY_URL="${CLICKHOUSE_QUERY_SCHEME}://${CLICKHOUSE_QUERY_HOST}:${CLICKHOUSE_QUERY_PORT}${CLICKHOUSE_QUERY_PATH}"
fi

# Execute a ClickHouse query over HTTP, returning output on success.
clickhouse_query() {
  local query="$1"
  if [[ "$CLICKHOUSE_QUERY_AVAILABLE" != "true" ]]; then
    return 1
  fi
  if [[ -n "$CLICKHOUSE_QUERY_USER" || -n "$CLICKHOUSE_QUERY_PASS" ]]; then
    curl -sS --fail -u "${CLICKHOUSE_QUERY_USER}:${CLICKHOUSE_QUERY_PASS}" --data-binary "$query" "$CLICKHOUSE_QUERY_URL"
  else
    curl -sS --fail --data-binary "$query" "$CLICKHOUSE_QUERY_URL"
  fi
}

declare -A CLUSTER_SHARD_HOSTS
CLUSTER_SHARD_COUNT=0
if [[ "$CLICKHOUSE_QUERY_AVAILABLE" == "true" ]]; then
  if cluster_rows="$(clickhouse_query "SELECT shard_num, if(host_address = '', host_name, host_address) AS host FROM system.clusters WHERE cluster='${CLICKHOUSE_CLUSTER}' AND replica_num=1 ORDER BY shard_num FORMAT TabSeparated")"; then
    while IFS=$'\t' read -r shard_num host; do
      if [[ -n "$shard_num" && -n "$host" ]]; then
        CLUSTER_SHARD_HOSTS["$shard_num"]="$host"
        CLUSTER_SHARD_COUNT=$((CLUSTER_SHARD_COUNT + 1))
      fi
    done <<<"$cluster_rows"
  else
    warn "unable to query system.clusters for cluster '${CLICKHOUSE_CLUSTER}', falling back to host range rotation"
  fi
fi

if [[ -z "$CLICKHOUSE_SHARDING_KEY_EXPR" && "$CLICKHOUSE_QUERY_AVAILABLE" == "true" ]]; then
  if shard_expr="$(clickhouse_query "SELECT nullIf(replaceRegexpOne(engine_full, '^Distributed\\([^,]+,\\s*[^,]+,\\s*[^,]+,\\s*(.*)\\)$', '\\1'), engine_full) FROM system.tables WHERE database='${CLICKHOUSE_DATABASE}' AND name='${CLICKHOUSE_TABLE}' FORMAT TabSeparated")"; then
    shard_expr="$(trim_whitespace "$shard_expr")"
    if [[ "$shard_expr" != "\\N" && -n "$shard_expr" ]]; then
      CLICKHOUSE_SHARDING_KEY_EXPR="$shard_expr"
    fi
  else
    warn "unable to query sharding key for ${CLICKHOUSE_DATABASE}.${CLICKHOUSE_TABLE}, falling back to epoch-based routing"
  fi
fi

if [[ -n "$CLICKHOUSE_SHARDING_KEY_EXPR" && "$CLICKHOUSE_SHARDING_KEY_EXPR" =~ rand[[:alnum:]_]*[[:space:]]*\( ]]; then
  warn "sharding key is random (${CLICKHOUSE_SHARDING_KEY_EXPR}); falling back to epoch-based routing"
  CLICKHOUSE_SHARDING_KEY_EXPR=""
fi

# Resolve the shard number for an epoch using a sharding key expression.
get_shard_for_epoch() {
  local epoch="$1"
  local shard_num=""
  if [[ -n "$CLICKHOUSE_SHARDING_KEY_EXPR" && "$CLICKHOUSE_QUERY_AVAILABLE" == "true" ]]; then
    if shard_num="$(clickhouse_query "WITH toUInt64(${epoch}) AS epoch SELECT _shard_num FROM cluster('${CLICKHOUSE_CLUSTER}', system.one, ${CLICKHOUSE_SHARDING_KEY_EXPR}) LIMIT 1")"; then
      shard_num="$(trim_whitespace "$shard_num")"
      if [[ "$shard_num" =~ ^[0-9]+$ ]]; then
        printf '%s' "$shard_num"
        return 0
      fi
    fi
  fi
  return 1
}

# Choose a fallback host using shard list or host range rotation.
fallback_host_for_epoch() {
  local epoch="$1"
  local epoch_num=$((10#$epoch))
  if (( CLUSTER_SHARD_COUNT > 0 )); then
    local shard_index=$((epoch_num % CLUSTER_SHARD_COUNT))
    local shard_num=$((shard_index + 1))
    local host="${CLUSTER_SHARD_HOSTS[$shard_num]}"
    if [[ -n "$host" ]]; then
      printf '%s' "$host"
      return 0
    fi
  fi
  local host_octet=$((CLICKHOUSE_HOST_START + (epoch_num % CLICKHOUSE_HOST_COUNT)))
  printf '%s' "${CLICKHOUSE_HOST_BASE}.${host_octet}"
}

# Compute shard routing for an epoch and run the wrapper once.
run_epoch() {
  local epoch="$1"
  local host=""
  local shard_num=""
  if shard_num="$(get_shard_for_epoch "$epoch")"; then
    host="${CLUSTER_SHARD_HOSTS[$shard_num]}"
  fi
  if [[ -z "$host" ]]; then
    host="$(fallback_host_for_epoch "$epoch")"
  fi
  export JETSTREAMER_INGEST_CLICKHOUSE_DSN="${INGEST_DSN_PREFIX}${host}${INGEST_DSN_SUFFIX}"
  printf '%s epoch=%s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$epoch" >>"$RUN_EPOCH_LOG_FILE"
  "$JETSTREAMER_WRAPPER_BIN" "${WRAPPER_ARGS[@]}" "$epoch"
}

step=1
if (( START_EPOCH > END_EPOCH )); then
  step=-1
fi

for (( epoch=START_EPOCH; ; epoch+=step )); do
  run_epoch "$epoch"
  if (( epoch == END_EPOCH )); then
    break
  fi
done
