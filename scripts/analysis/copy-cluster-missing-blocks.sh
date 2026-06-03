#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# Copyright 2025-2026 Triton One Limited. All rights reserved.
#

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/analysis/copy-cluster-missing-blocks.sh

Copies transactions and block metadata rows for a CSV of missing slots from a
source ClickHouse cluster to a target ClickHouse cluster.

The intended input is:
  ${OUT_DIR}/blocks_metadata_local/missing-keys-epoch-${epoch}.csv
from scripts/analysis/check-cluster-table-missing-keys.sh.

The script copies transactions first, then block metadata. Inserts go through
the target Distributed tables so ClickHouse routes rows to the correct shard.

Required environment:
  MISSING_SLOTS_FILE  CSVWithNames file with one UInt64 column named slot
  SOURCE_CH_HOST      Source ClickHouse control host
  SOURCE_CLUSTER      Source cluster name used by cluster()
  TARGET_CH_HOST      Target ClickHouse control host
  TARGET_CLUSTER      Target cluster name used for validation

Optional environment:
  SOURCE_CH_PORT      Source ClickHouse TCP port (default: 9000)
  TARGET_CH_PORT      Target ClickHouse TCP port (default: 9000)
  SOURCE_CH_USER      Source ClickHouse user (default: default)
  TARGET_CH_USER      Target ClickHouse user (default: default)
  SOURCE_CH_PASS      Source ClickHouse password (optional)
  TARGET_CH_PASS      Target ClickHouse password (optional)

  SOURCE_DATABASE     Source database (default: default)
  TARGET_DATABASE     Target database (default: default)

  SOURCE_TRANSACTIONS_LOCAL_TABLE       Source local transactions table
                                        (default: transactions_local)
  SOURCE_BLOCKS_METADATA_LOCAL_TABLE    Source local block metadata table
                                        (default: blocks_metadata_local)
  TARGET_TRANSACTIONS_TABLE             Target Distributed transactions table
                                        (default: transactions)
  TARGET_BLOCKS_METADATA_TABLE          Target Distributed block metadata table
                                        (default: blocks_metadata)

  COPY_TRANSACTIONS       Copy transaction rows for the listed slots (default: 1)
  COPY_BLOCKS_METADATA    Copy block metadata rows for the listed slots (default: 1)
  SKIP_EXISTING_TARGET_ROWS
                          Skip target rows that already exist by table key
                          (default: 0)
  ALLOW_EXISTING_TARGET_ROWS
                          Allow listed slots that already have target rows and
                          copy source rows without filtering existing target keys
                          (default: 0)
  INSERT_DISTRIBUTED_SYNC ClickHouse insert_distributed_sync setting (default: 1)
  DRY_RUN                 Validate and count, but do not insert (default: 0)

Notes:
  - By default it refuses to insert when the target already has rows for the
    same listed slots, to avoid accidental duplicate raw rows on reruns.
  - With SKIP_EXISTING_TARGET_ROWS=1, existing target rows are skipped by
    exact table key: slot for block metadata, and slot/slot_idx/signature for
    transactions.
EOF
}

die() {
  echo "error: $*" >&2
  exit 1
}

warn() {
  echo "warn: $*" >&2
}

log() {
  printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

trim_whitespace() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

require_uint() {
  local name="$1"
  local value="$2"
  [[ "$value" =~ ^[0-9]+$ ]] || die "$name must be a non-negative integer"
}

require_bool() {
  local name="$1"
  local value="$2"
  [[ "$value" == "0" || "$value" == "1" ]] || die "$name must be 0 or 1"
}

require_safe_sql_string() {
  local name="$1"
  local value="$2"
  [[ "$value" != *"'"* ]] || die "$name must not contain single quotes"
  [[ "$value" != *\\* ]] || die "$name must not contain backslashes"
  [[ "$value" != *$'\t'* ]] || die "$name must not contain tabs"
  [[ "$value" != *$'\n'* ]] || die "$name must not contain newlines"
  [[ "$value" != *$'\r'* ]] || die "$name must not contain carriage returns"
}

require_identifier() {
  local name="$1"
  local value="$2"
  [[ "$value" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || {
    die "$name must be an unqualified ClickHouse identifier"
  }
}

clickhouse_query() {
  local host="$1"
  local port="$2"
  local user="$3"
  local pass="$4"
  local database="$5"
  local query="$6"
  local -a args=(--host "$host" --port "$port" --user "$user" --database "$database")
  if [[ -n "$pass" ]]; then
    args+=(--password "$pass")
  fi
  clickhouse client "${args[@]}" --query "$query"
}

clickhouse_query_with_slots() {
  local host="$1"
  local port="$2"
  local user="$3"
  local pass="$4"
  local database="$5"
  local query="$6"
  local -a args=(--host "$host" --port "$port" --user "$user" --database "$database")
  if [[ -n "$pass" ]]; then
    args+=(--password "$pass")
  fi
  clickhouse client "${args[@]}" \
    --external \
    --file "$MISSING_SLOTS_FILE" \
    --name missing_slots \
    --format CSVWithNames \
    --structure 'slot UInt64' \
    --query "$query"
}

clickhouse_query_with_source_externals() {
  local existing_keys_file="$1"
  local label="$2"
  local query="$3"
  local -a args=(--host "$SOURCE_CH_HOST" --port "$SOURCE_CH_PORT" --user "$SOURCE_CH_USER" --database "$SOURCE_DATABASE")
  if [[ -n "$SOURCE_CH_PASS" ]]; then
    args+=(--password "$SOURCE_CH_PASS")
  fi

  local -a external_args=(
    --external
    --file "$MISSING_SLOTS_FILE"
    --name missing_slots
    --format CSVWithNames
    --structure 'slot UInt64'
  )
  if [[ -n "$existing_keys_file" ]]; then
    case "$label" in
      transactions)
        external_args+=(
          --external
          --file "$existing_keys_file"
          --name existing_target_rows
          --format TabSeparated
          --structure 'slot UInt64, slot_idx UInt32, signature_hex String'
        )
        ;;
      blocks_metadata)
        external_args+=(
          --external
          --file "$existing_keys_file"
          --name existing_target_rows
          --format TabSeparated
          --structure 'slot UInt64'
        )
        ;;
      *)
        die "unsupported label '${label}'"
        ;;
    esac
  fi

  clickhouse client "${args[@]}" "${external_args[@]}" --query "$query"
}

validate_cluster() {
  local host="$1"
  local port="$2"
  local user="$3"
  local pass="$4"
  local database="$5"
  local cluster="$6"
  local count

  count="$(clickhouse_query \
    "$host" "$port" "$user" "$pass" "$database" \
    "SELECT count() FROM system.clusters WHERE cluster='${cluster}' FORMAT TabSeparated")" \
    || die "unable to query system.clusters on ${host} for cluster '${cluster}'"
  count="$(trim_whitespace "$count")"
  [[ "$count" =~ ^[0-9]+$ ]] || die "unexpected cluster count for '${cluster}' on ${host}: ${count}"
  (( count > 0 )) || die "cluster '${cluster}' was not found on ${host}"
}

validate_table_exists() {
  local host="$1"
  local port="$2"
  local user="$3"
  local pass="$4"
  local database="$5"
  local table="$6"
  local count

  count="$(clickhouse_query \
    "$host" "$port" "$user" "$pass" "$database" \
    "SELECT count()
     FROM system.tables
     WHERE database='${database}' AND name='${table}'
     FORMAT TabSeparated")" \
    || die "unable to verify table ${database}.${table} on ${host}"
  count="$(trim_whitespace "$count")"
  [[ "$count" =~ ^[0-9]+$ ]] || die "unexpected table count for ${database}.${table} on ${host}: ${count}"
  (( count > 0 )) || die "table ${database}.${table} was not found on ${host}"
}

validate_distributed_table() {
  local host="$1"
  local port="$2"
  local user="$3"
  local pass="$4"
  local database="$5"
  local table="$6"
  local engine

  engine="$(clickhouse_query \
    "$host" "$port" "$user" "$pass" "$database" \
    "SELECT engine
     FROM system.tables
     WHERE database='${database}' AND name='${table}'
     FORMAT TabSeparated")" \
    || die "unable to query engine for ${database}.${table} on ${host}"
  engine="$(trim_whitespace "$engine")"
  [[ "$engine" == "Distributed" ]] || {
    die "target table ${database}.${table} must be Distributed, got '${engine}'"
  }
}

validate_slots_file() {
  [[ -f "$MISSING_SLOTS_FILE" ]] || die "MISSING_SLOTS_FILE does not exist: $MISSING_SLOTS_FILE"
  [[ -s "$MISSING_SLOTS_FILE" ]] || die "MISSING_SLOTS_FILE is empty: $MISSING_SLOTS_FILE"

  SLOT_COUNT="$(awk -F',' '
    NR == 1 {
      sub(/\r$/, "", $0)
      if ($0 != "slot") {
        printf("expected CSV header \"slot\", got \"%s\"\n", $0) > "/dev/stderr"
        exit 2
      }
      next
    }
    /^[[:space:]]*$/ {
      next
    }
    {
      sub(/\r$/, "", $1)
      if (NF != 1 || $1 !~ /^[0-9]+$/) {
        printf("invalid slot CSV row %d: %s\n", NR, $0) > "/dev/stderr"
        exit 2
      }
      count++
    }
    END {
      if (NR == 0) {
        exit 3
      }
      print count + 0
    }
  ' "$MISSING_SLOTS_FILE")" || die "invalid MISSING_SLOTS_FILE: $MISSING_SLOTS_FILE"

  require_uint "slot count" "$SLOT_COUNT"
  (( SLOT_COUNT > 0 )) || die "MISSING_SLOTS_FILE contains no slots: $MISSING_SLOTS_FILE"
}

target_rows_for_slots() {
  local target_table="$1"
  clickhouse_query_with_slots \
    "$TARGET_CH_HOST" "$TARGET_CH_PORT" "$TARGET_CH_USER" "$TARGET_CH_PASS" "$TARGET_DATABASE" \
    "SELECT count()
     FROM ${TARGET_DATABASE}.${target_table}
     WHERE slot GLOBAL IN (SELECT slot FROM missing_slots)
     SETTINGS
       skip_unavailable_shards = 0,
       max_execution_time = 0,
       max_execution_time_leaf = 0
     FORMAT TabSeparated"
}

source_filter_for_slots() {
  local label="$1"
  local existing_keys_file="$2"
  local filter="slot GLOBAL IN (SELECT slot FROM missing_slots)"

  if [[ -n "$existing_keys_file" ]]; then
    case "$label" in
      transactions)
        filter="${filter}
     AND (slot, slot_idx, hex(signature)) GLOBAL NOT IN (
       SELECT slot, slot_idx, signature_hex FROM existing_target_rows
     )"
        ;;
      blocks_metadata)
        filter="${filter}
     AND slot GLOBAL NOT IN (SELECT slot FROM existing_target_rows)"
        ;;
      *)
        die "unsupported label '${label}'"
        ;;
    esac
  fi

  printf '%s' "$filter"
}

source_rows_to_copy_for_slots() {
  local label="$1"
  local source_table="$2"
  local existing_keys_file="$3"
  local filter

  filter="$(source_filter_for_slots "$label" "$existing_keys_file")"
  clickhouse_query_with_source_externals \
    "$existing_keys_file" "$label" \
    "SELECT count()
     FROM cluster('${SOURCE_CLUSTER}', '${SOURCE_DATABASE}', '${source_table}')
     WHERE ${filter}
     SETTINGS
       skip_unavailable_shards = 0,
       max_execution_time = 0,
       max_execution_time_leaf = 0
     FORMAT TabSeparated"
}

export_existing_target_keys() {
  local label="$1"
  local target_table="$2"
  local outfile="$3"
  local select_list

  case "$label" in
    transactions)
      select_list="DISTINCT slot, slot_idx, hex(signature) AS signature_hex"
      ;;
    blocks_metadata)
      select_list="DISTINCT slot"
      ;;
    *)
      die "unsupported label '${label}'"
      ;;
  esac

  clickhouse_query_with_slots \
    "$TARGET_CH_HOST" "$TARGET_CH_PORT" "$TARGET_CH_USER" "$TARGET_CH_PASS" "$TARGET_DATABASE" \
    "SELECT ${select_list}
     FROM ${TARGET_DATABASE}.${target_table}
     WHERE slot GLOBAL IN (SELECT slot FROM missing_slots)
     SETTINGS
       skip_unavailable_shards = 0,
       max_execution_time = 0,
       max_execution_time_leaf = 0
     FORMAT TabSeparated" > "$outfile"
}

copy_rows_for_slots() {
  local label="$1"
  local source_table="$2"
  local target_table="$3"
  local source_count
  local target_count
  local existing_keys_file=""

  if [[ "$SKIP_EXISTING_TARGET_ROWS" == "1" ]]; then
    existing_keys_file="${TMP_DIR}/${label}-existing-target-keys.tsv"
    export_existing_target_keys "$label" "$target_table" "$existing_keys_file" || {
      die "unable to export existing target keys for ${TARGET_DATABASE}.${target_table}"
    }
    target_count="$(wc -l < "$existing_keys_file" | tr -d '[:space:]')"
    require_uint "${label} target key count" "$target_count"
  else
    target_count="$(target_rows_for_slots "$target_table")" || {
      die "unable to count target rows for ${TARGET_DATABASE}.${target_table}"
    }
    target_count="$(trim_whitespace "$target_count")"
    require_uint "${label} target row count" "$target_count"
  fi

  source_count="$(source_rows_to_copy_for_slots "$label" "$source_table" "$existing_keys_file")" || {
    die "unable to count source rows for ${SOURCE_DATABASE}.${source_table}"
  }
  source_count="$(trim_whitespace "$source_count")"
  require_uint "${label} source row count" "$source_count"

  log "table=${label} slots=${SLOT_COUNT} source_rows=${source_count} target_existing_rows=${target_count}"

  if (( target_count > 0 )) && [[ "$ALLOW_EXISTING_TARGET_ROWS" == "0" ]] && [[ "$SKIP_EXISTING_TARGET_ROWS" == "0" ]]; then
    die "target ${TARGET_DATABASE}.${target_table} already has ${target_count} rows for listed slots; set ALLOW_EXISTING_TARGET_ROWS=1 to override"
  fi

  if (( source_count == 0 )); then
    warn "no ${label} rows to copy from ${SOURCE_DATABASE}.${source_table}; skipping"
    return 0
  fi

  if [[ "$DRY_RUN" == "1" ]]; then
    log "dry-run: would copy ${source_count} ${label} rows into ${TARGET_DATABASE}.${target_table}"
    return 0
  fi

  local -a dst_args=(--host "$TARGET_CH_HOST" --port "$TARGET_CH_PORT" --user "$TARGET_CH_USER" --database "$TARGET_DATABASE")
  if [[ -n "$TARGET_CH_PASS" ]]; then
    dst_args+=(--password "$TARGET_CH_PASS")
  fi

  log "copying ${label} rows into ${TARGET_DATABASE}.${target_table}"
  local filter
  filter="$(source_filter_for_slots "$label" "$existing_keys_file")"
  set +e
  clickhouse_query_with_source_externals \
    "$existing_keys_file" "$label" "
SELECT *
FROM cluster('${SOURCE_CLUSTER}', '${SOURCE_DATABASE}', '${source_table}')
WHERE ${filter}
SETTINGS
  skip_unavailable_shards = 0,
  max_execution_time = 0,
  max_execution_time_leaf = 0
FORMAT Native
" | clickhouse client "${dst_args[@]}" \
    --insert_distributed_sync="$INSERT_DISTRIBUTED_SYNC" \
    --query "INSERT INTO ${TARGET_DATABASE}.${target_table} FORMAT Native"
  local -a pipe_status=("${PIPESTATUS[@]}")
  set -e

  if (( pipe_status[0] != 0 || pipe_status[1] != 0 )); then
    die "copy failed for ${label}: source_rc=${pipe_status[0]} target_rc=${pipe_status[1]}"
  fi

  log "copied ${source_count} ${label} rows"
}

MISSING_SLOTS_FILE="${MISSING_SLOTS_FILE:-}"
SOURCE_CH_HOST="${SOURCE_CH_HOST:-}"
SOURCE_CLUSTER="${SOURCE_CLUSTER:-}"
TARGET_CH_HOST="${TARGET_CH_HOST:-}"
TARGET_CLUSTER="${TARGET_CLUSTER:-}"

SOURCE_CH_PORT="${SOURCE_CH_PORT:-9000}"
TARGET_CH_PORT="${TARGET_CH_PORT:-9000}"
SOURCE_CH_USER="${SOURCE_CH_USER:-default}"
TARGET_CH_USER="${TARGET_CH_USER:-default}"
SOURCE_CH_PASS="${SOURCE_CH_PASS:-}"
TARGET_CH_PASS="${TARGET_CH_PASS:-}"

SOURCE_DATABASE="${SOURCE_DATABASE:-default}"
TARGET_DATABASE="${TARGET_DATABASE:-default}"
SOURCE_TRANSACTIONS_LOCAL_TABLE="${SOURCE_TRANSACTIONS_LOCAL_TABLE:-transactions_local}"
SOURCE_BLOCKS_METADATA_LOCAL_TABLE="${SOURCE_BLOCKS_METADATA_LOCAL_TABLE:-blocks_metadata_local}"
TARGET_TRANSACTIONS_TABLE="${TARGET_TRANSACTIONS_TABLE:-transactions}"
TARGET_BLOCKS_METADATA_TABLE="${TARGET_BLOCKS_METADATA_TABLE:-blocks_metadata}"

COPY_TRANSACTIONS="${COPY_TRANSACTIONS:-1}"
COPY_BLOCKS_METADATA="${COPY_BLOCKS_METADATA:-1}"
SKIP_EXISTING_TARGET_ROWS="${SKIP_EXISTING_TARGET_ROWS:-0}"
ALLOW_EXISTING_TARGET_ROWS="${ALLOW_EXISTING_TARGET_ROWS:-0}"
INSERT_DISTRIBUTED_SYNC="${INSERT_DISTRIBUTED_SYNC:-1}"
DRY_RUN="${DRY_RUN:-0}"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

[[ $# -eq 0 ]] || {
  usage >&2
  die "this script is configured via environment variables and does not accept positional arguments"
}

[[ -n "$MISSING_SLOTS_FILE" ]] || die "MISSING_SLOTS_FILE is required"
[[ -n "$SOURCE_CH_HOST" ]] || die "SOURCE_CH_HOST is required"
[[ -n "$SOURCE_CLUSTER" ]] || die "SOURCE_CLUSTER is required"
[[ -n "$TARGET_CH_HOST" ]] || die "TARGET_CH_HOST is required"
[[ -n "$TARGET_CLUSTER" ]] || die "TARGET_CLUSTER is required"

require_cmd clickhouse
require_uint "SOURCE_CH_PORT" "$SOURCE_CH_PORT"
require_uint "TARGET_CH_PORT" "$TARGET_CH_PORT"
require_bool "COPY_TRANSACTIONS" "$COPY_TRANSACTIONS"
require_bool "COPY_BLOCKS_METADATA" "$COPY_BLOCKS_METADATA"
require_bool "SKIP_EXISTING_TARGET_ROWS" "$SKIP_EXISTING_TARGET_ROWS"
require_bool "ALLOW_EXISTING_TARGET_ROWS" "$ALLOW_EXISTING_TARGET_ROWS"
require_bool "INSERT_DISTRIBUTED_SYNC" "$INSERT_DISTRIBUTED_SYNC"
require_bool "DRY_RUN" "$DRY_RUN"

(( COPY_TRANSACTIONS == 1 || COPY_BLOCKS_METADATA == 1 )) || {
  die "at least one of COPY_TRANSACTIONS or COPY_BLOCKS_METADATA must be 1"
}

if [[ "$SKIP_EXISTING_TARGET_ROWS" == "1" && "$ALLOW_EXISTING_TARGET_ROWS" == "1" ]]; then
  die "SKIP_EXISTING_TARGET_ROWS and ALLOW_EXISTING_TARGET_ROWS are mutually exclusive"
fi

require_safe_sql_string "SOURCE_CLUSTER" "$SOURCE_CLUSTER"
require_safe_sql_string "TARGET_CLUSTER" "$TARGET_CLUSTER"
require_identifier "SOURCE_DATABASE" "$SOURCE_DATABASE"
require_identifier "TARGET_DATABASE" "$TARGET_DATABASE"
require_identifier "SOURCE_TRANSACTIONS_LOCAL_TABLE" "$SOURCE_TRANSACTIONS_LOCAL_TABLE"
require_identifier "SOURCE_BLOCKS_METADATA_LOCAL_TABLE" "$SOURCE_BLOCKS_METADATA_LOCAL_TABLE"
require_identifier "TARGET_TRANSACTIONS_TABLE" "$TARGET_TRANSACTIONS_TABLE"
require_identifier "TARGET_BLOCKS_METADATA_TABLE" "$TARGET_BLOCKS_METADATA_TABLE"

if [[ "$SOURCE_CH_HOST" == "$TARGET_CH_HOST" && "$SOURCE_CLUSTER" == "$TARGET_CLUSTER" && "$SOURCE_DATABASE" == "$TARGET_DATABASE" ]]; then
  die "source and target resolve to the same host, cluster, and database"
fi

validate_slots_file
TMP_DIR="$(mktemp -d)"
cleanup_tmp() {
  rm -rf "$TMP_DIR"
}
trap cleanup_tmp EXIT

log "copy source=${SOURCE_CH_HOST}/${SOURCE_CLUSTER}/${SOURCE_DATABASE} target=${TARGET_CH_HOST}/${TARGET_CLUSTER}/${TARGET_DATABASE} slots=${SLOT_COUNT} dry_run=${DRY_RUN} skip_existing=${SKIP_EXISTING_TARGET_ROWS}"

validate_cluster "$SOURCE_CH_HOST" "$SOURCE_CH_PORT" "$SOURCE_CH_USER" "$SOURCE_CH_PASS" "$SOURCE_DATABASE" "$SOURCE_CLUSTER"
validate_cluster "$TARGET_CH_HOST" "$TARGET_CH_PORT" "$TARGET_CH_USER" "$TARGET_CH_PASS" "$TARGET_DATABASE" "$TARGET_CLUSTER"

if [[ "$COPY_TRANSACTIONS" == "1" ]]; then
  validate_table_exists "$SOURCE_CH_HOST" "$SOURCE_CH_PORT" "$SOURCE_CH_USER" "$SOURCE_CH_PASS" "$SOURCE_DATABASE" "$SOURCE_TRANSACTIONS_LOCAL_TABLE"
  validate_table_exists "$TARGET_CH_HOST" "$TARGET_CH_PORT" "$TARGET_CH_USER" "$TARGET_CH_PASS" "$TARGET_DATABASE" "$TARGET_TRANSACTIONS_TABLE"
  validate_distributed_table "$TARGET_CH_HOST" "$TARGET_CH_PORT" "$TARGET_CH_USER" "$TARGET_CH_PASS" "$TARGET_DATABASE" "$TARGET_TRANSACTIONS_TABLE"
  copy_rows_for_slots "transactions" "$SOURCE_TRANSACTIONS_LOCAL_TABLE" "$TARGET_TRANSACTIONS_TABLE"
fi

if [[ "$COPY_BLOCKS_METADATA" == "1" ]]; then
  validate_table_exists "$SOURCE_CH_HOST" "$SOURCE_CH_PORT" "$SOURCE_CH_USER" "$SOURCE_CH_PASS" "$SOURCE_DATABASE" "$SOURCE_BLOCKS_METADATA_LOCAL_TABLE"
  validate_table_exists "$TARGET_CH_HOST" "$TARGET_CH_PORT" "$TARGET_CH_USER" "$TARGET_CH_PASS" "$TARGET_DATABASE" "$TARGET_BLOCKS_METADATA_TABLE"
  validate_distributed_table "$TARGET_CH_HOST" "$TARGET_CH_PORT" "$TARGET_CH_USER" "$TARGET_CH_PASS" "$TARGET_DATABASE" "$TARGET_BLOCKS_METADATA_TABLE"
  copy_rows_for_slots "blocks_metadata" "$SOURCE_BLOCKS_METADATA_LOCAL_TABLE" "$TARGET_BLOCKS_METADATA_TABLE"
fi

log "complete"
