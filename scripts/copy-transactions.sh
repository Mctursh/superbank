#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# Copyright 2025-2026 Triton One Limited. All rights reserved.
#

set -u -o pipefail

usage() {
  cat <<'EOF'
Usage: scripts/copy-transactions.sh <start_epoch> <end_epoch>

Environment:
  CH_HOST    ClickHouse host for this node (default: localhost)
  CH_PORT    ClickHouse TCP port (default: 9000)
  CH_USER    ClickHouse user (default: default)
  CH_PASS    ClickHouse password (default: empty)
  CH_CLUSTER Optional override for the transactions cluster used for ownership and source reads
             (default: from default.transactions)
  JOBS       Parallel epoch workers (default: 4)
  LOG_DIR    Directory for per-epoch logs
EOF
}

is_uint() {
  [[ "$1" =~ ^[0-9]+$ ]]
}

log() {
  printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"
}

trim_whitespace() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

if [[ $# -ne 2 ]]; then
  usage
  exit 1
fi

START_EPOCH="$1"
END_EPOCH="$2"

if ! is_uint "$START_EPOCH" || ! is_uint "$END_EPOCH"; then
  echo "error: start_epoch and end_epoch must be non-negative integers" >&2
  exit 1
fi

if (( START_EPOCH > END_EPOCH )); then
  echo "error: start_epoch must be <= end_epoch" >&2
  exit 1
fi

CH_PORT="${CH_PORT:-9000}"
CH_USER="${CH_USER:-default}"
CH_PASS="${CH_PASS:-}"
CH_HOST="${CH_HOST:-localhost}"
CH_CLUSTER="${CH_CLUSTER:-}"
JOBS="${JOBS:-4}"
LOG_DIR="${LOG_DIR:-./copy-transactions-logs-$(date -u +%Y%m%dT%H%M%SZ)}"

if ! is_uint "$JOBS" || (( JOBS < 1 )); then
  echo "error: JOBS must be an integer >= 1" >&2
  exit 1
fi

mkdir -p "$LOG_DIR"
CH_BASE_ARGS=(--host "$CH_HOST" --port "$CH_PORT" --user "$CH_USER")
if [[ -n "$CH_PASS" ]]; then
  CH_BASE_ARGS+=(--password "$CH_PASS")
fi
TARGET_DATABASE="default"
TARGET_DISTRIBUTED_TABLE="transactions"
SHARDING_KEY_EXPR=""

clickhouse_query() {
  local query="$1"
  clickhouse-client "${CH_BASE_ARGS[@]}" -q "$query"
}

build_shard_topology() {
  local rows
  rows="$(clickhouse_query "SELECT shard_num, shard_weight, host_name, host_address FROM system.clusters WHERE cluster='${CH_CLUSTER}' ORDER BY shard_num, replica_num FORMAT TabSeparated")" || {
    echo "error: unable to query system.clusters for cluster '${CH_CLUSTER}'" >&2
    exit 1
  }

  declare -g -a SHARD_NUMS=()
  declare -g -A SHARD_WEIGHTS=()
  declare -g -A MATCHED_SHARDS=()

  local shard_num shard_weight host_name host_address
  while IFS=$'\t' read -r shard_num shard_weight host_name host_address; do
    shard_num="$(trim_whitespace "${shard_num:-}")"
    shard_weight="$(trim_whitespace "${shard_weight:-}")"
    host_name="$(trim_whitespace "${host_name:-}")"
    host_address="$(trim_whitespace "${host_address:-}")"

    if [[ -z "$shard_num" || -z "$shard_weight" ]]; then
      continue
    fi

    if [[ -z "${SHARD_WEIGHTS[$shard_num]+x}" ]]; then
      SHARD_NUMS+=("$shard_num")
      SHARD_WEIGHTS["$shard_num"]="$shard_weight"
    fi

    if [[ "$CH_HOST" == "$host_name" || "$CH_HOST" == "$host_address" ]]; then
      MATCHED_SHARDS["$shard_num"]=1
    fi
  done <<< "$rows"

  if (( ${#SHARD_NUMS[@]} == 0 )); then
    echo "error: cluster '${CH_CLUSTER}' has no shard rows" >&2
    exit 1
  fi

  declare -g -a MATCHED_SHARD_LIST=()
  local s
  for s in "${!MATCHED_SHARDS[@]}"; do
    MATCHED_SHARD_LIST+=("$s")
  done

  if (( ${#MATCHED_SHARD_LIST[@]} == 0 )); then
    echo "error: CH_HOST='${CH_HOST}' did not match any host_name/host_address in cluster '${CH_CLUSTER}'" >&2
    clickhouse_query "SELECT shard_num, replica_num, host_name, host_address FROM system.clusters WHERE cluster='${CH_CLUSTER}' ORDER BY shard_num, replica_num FORMAT PrettyCompact" >&2 || true
    exit 1
  fi

  if (( ${#MATCHED_SHARD_LIST[@]} > 1 )); then
    echo "error: CH_HOST='${CH_HOST}' matched multiple shards (${MATCHED_SHARD_LIST[*]}) in cluster '${CH_CLUSTER}'" >&2
    exit 1
  fi
}

resolve_distributed_table_config() {
  local engine_full engine_full_norm norm_expr cluster_arg shard_expr
  engine_full="$(clickhouse_query "SELECT engine_full FROM system.tables WHERE database='${TARGET_DATABASE}' AND name='${TARGET_DISTRIBUTED_TABLE}' FORMAT TabSeparated")" || {
    echo "error: unable to query engine_full for ${TARGET_DATABASE}.${TARGET_DISTRIBUTED_TABLE}" >&2
    exit 1
  }
  engine_full="$(trim_whitespace "$engine_full")"
  engine_full_norm="${engine_full//\\\'/\'}"

  if [[ ! "$engine_full_norm" =~ ^Distributed\([[:space:]]*\'?([^\'\,\)]+)\'?[[:space:]]*,[[:space:]]*\'?([^\'\,\)]+)\'?[[:space:]]*,[[:space:]]*\'?([^\'\,\)]+)\'?[[:space:]]*,[[:space:]]*(.*)\)$ ]]; then
    echo "error: ${TARGET_DATABASE}.${TARGET_DISTRIBUTED_TABLE} is not a supported Distributed(...) engine expression: ${engine_full}" >&2
    exit 1
  fi

  cluster_arg="${BASH_REMATCH[1]}"
  shard_expr="${BASH_REMATCH[4]}"
  if [[ -z "$CH_CLUSTER" ]]; then
    if [[ "$cluster_arg" == "{cluster}" ]]; then
      if [[ "$CH_HOST" =~ ^[^.]*-([[:alnum:]_-]+)[0-9]+$ ]]; then
        CH_CLUSTER="${BASH_REMATCH[1]}"
      else
        echo "error: CH_CLUSTER is required because table engine uses '{cluster}' and CH_HOST='${CH_HOST}' does not match '<prefix>-<cluster><num>' pattern" >&2
        exit 1
      fi
    else
      CH_CLUSTER="$cluster_arg"
    fi
  fi
  SHARDING_KEY_EXPR="$(trim_whitespace "$shard_expr")"
  if [[ -z "$SHARDING_KEY_EXPR" ]]; then
    echo "error: empty sharding expression for ${TARGET_DATABASE}.${TARGET_DISTRIBUTED_TABLE}" >&2
    exit 1
  fi

  norm_expr="$(printf '%s' "$SHARDING_KEY_EXPR" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"
  if [[ "$norm_expr" != "intdiv(slot,432000)" ]]; then
    echo "error: unsupported sharding key '${SHARDING_KEY_EXPR}' for ${TARGET_DATABASE}.${TARGET_DISTRIBUTED_TABLE}; expected intDiv(slot, 432000)" >&2
    exit 1
  fi
}

resolve_local_shard_bounds() {
  LOCAL_SHARD_NUM="${MATCHED_SHARD_LIST[0]}"
  TOTAL_WEIGHT=0
  LOCAL_LOWER_BOUND=0
  LOCAL_UPPER_BOUND=0

  local shard_num shard_weight
  for shard_num in "${SHARD_NUMS[@]}"; do
    shard_weight="${SHARD_WEIGHTS[$shard_num]}"
    if [[ -z "$shard_weight" || ! "$shard_weight" =~ ^[0-9]+$ ]]; then
      echo "error: invalid shard_weight '${shard_weight}' for shard ${shard_num}" >&2
      exit 1
    fi
    if (( shard_weight == 0 )); then
      echo "error: shard ${shard_num} has zero weight" >&2
      exit 1
    fi

    if [[ "$shard_num" == "$LOCAL_SHARD_NUM" ]]; then
      LOCAL_LOWER_BOUND="$TOTAL_WEIGHT"
      LOCAL_UPPER_BOUND=$((TOTAL_WEIGHT + shard_weight))
    fi
    TOTAL_WEIGHT=$((TOTAL_WEIGHT + shard_weight))
  done

  if (( TOTAL_WEIGHT == 0 )); then
    echo "error: total shard weight is zero for cluster '${CH_CLUSTER}'" >&2
    exit 1
  fi

  if (( LOCAL_UPPER_BOUND <= LOCAL_LOWER_BOUND )); then
    echo "error: failed to compute ownership range for shard ${LOCAL_SHARD_NUM}" >&2
    exit 1
  fi

  log "resolved host=${CH_HOST} cluster=${CH_CLUSTER} shard=${LOCAL_SHARD_NUM} weight_range=[${LOCAL_LOWER_BOUND},${LOCAL_UPPER_BOUND}) total_weight=${TOTAL_WEIGHT}"
}

epoch_owned_by_local_shard() {
  local epoch="$1"
  local epoch_num remainder
  epoch_num=$((10#$epoch))
  remainder=$((epoch_num % TOTAL_WEIGHT))
  if (( remainder >= LOCAL_LOWER_BOUND && remainder < LOCAL_UPPER_BOUND )); then
    return 0
  fi
  return 1
}

resolve_distributed_table_config
build_shard_topology
resolve_local_shard_bounds

run_epoch() {
  local epoch="$1"
  local log_file="$LOG_DIR/epoch-${epoch}.log"
  local t0 t1 rc summary
  t0=$(date +%s)

  log "[epoch=${epoch}] start host=${CH_HOST} shard=${LOCAL_SHARD_NUM}"

  clickhouse-client "${CH_BASE_ARGS[@]}" -q "
INSERT INTO default.transactions_local
SELECT *
FROM cluster('${CH_CLUSTER}', '${TARGET_DATABASE}', 'transactions_local')
WHERE intDiv(slot, 432000) = ${epoch}
SETTINGS
  max_execution_time = 0,
  max_execution_time_leaf = 0,
  max_threads = 96,
  max_insert_threads = 48,
  async_insert = 0
" >"$log_file" 2>&1

  rc=$?
  t1=$(date +%s)

  if (( rc == 0 )); then
    summary="$(grep -m1 'rows in set' "$log_file" || true)"
    log "[epoch=${epoch}] ok host=${CH_HOST} dur=$((t1 - t0))s ${summary:-rows-in-set=unknown}"
    return 0
  fi

  log "[epoch=${epoch}] fail host=${CH_HOST} dur=$((t1 - t0))s rc=${rc} log=${log_file}"
  tail -n 5 "$log_file" | sed 's/^/[tail] /'
  return "$rc"
}

cleanup() {
  log "interrupt received, stopping background jobs"
  jobs -pr | xargs -r kill || true
}
trap cleanup INT TERM

total=0
done_count=0
ok=0
fail=0

for epoch in $(seq "$START_EPOCH" "$END_EPOCH"); do
  if ! epoch_owned_by_local_shard "$epoch"; then
    log "[epoch=${epoch}] skip reason=not-owned host=${CH_HOST} shard=${LOCAL_SHARD_NUM}"
    continue
  fi

  run_epoch "$epoch" &
  (( total += 1 ))

  while (( $(jobs -pr | wc -l) >= JOBS )); do
    if wait -n; then
      (( ok += 1 ))
    else
      (( fail += 1 ))
    fi
    (( done_count += 1 ))
    log "progress done=${done_count}/${total} ok=${ok} fail=${fail} active=$(jobs -pr | wc -l)"
  done
done

if (( total == 0 )); then
  log "no owned epochs in range start=${START_EPOCH} end=${END_EPOCH} host=${CH_HOST} shard=${LOCAL_SHARD_NUM}"
  exit 0
fi

while (( $(jobs -pr | wc -l) > 0 )); do
  if wait -n; then
    (( ok += 1 ))
  else
    (( fail += 1 ))
  fi
  (( done_count += 1 ))
  log "progress done=${done_count}/${total} ok=${ok} fail=${fail} active=$(jobs -pr | wc -l)"
done

log "complete total=${total} ok=${ok} fail=${fail} logs=${LOG_DIR}"
(( fail == 0 ))
