#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# Copyright 2025-2026 Triton One Limited. All rights reserved.
#

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/analysis/check-cluster-table-missing-keys.sh

Compares source-cluster rows against a target cluster and emits CSVs for keys
that exist on the source cluster but are missing from the target cluster.

Modes:
  - counts: fast per-epoch row-count comparison across both clusters
  - missing-keys: slower source -> target key diff with backfill-oriented CSVs

Supported tables:
  - transactions_local
  - blocks_metadata_local

Environment:
  SOURCE_CH_HOST    Source ClickHouse control host (required)
  SOURCE_CLUSTER    Source cluster name used by cluster() (required)
  TARGET_CH_HOST    Target ClickHouse control host (required)
  TARGET_CLUSTER    Target cluster name used by cluster() (required)

  SOURCE_CH_PORT    Source ClickHouse TCP port (default: 9000)
  TARGET_CH_PORT    Target ClickHouse TCP port (default: 9000)
  SOURCE_CH_USER    Source ClickHouse user (default: default)
  TARGET_CH_USER    Target ClickHouse user (default: default)
  SOURCE_CH_PASS    Source ClickHouse password (optional)
  TARGET_CH_PASS    Target ClickHouse password (optional)

  SOURCE_DATABASE   Source database (default: default)
  TARGET_DATABASE   Target database (default: default)
  TABLES            Comma-separated supported tables
                    (default: transactions_local,blocks_metadata_local)
  MODE              counts or missing-keys (default: counts)
  EPOCH_START       Inclusive epoch start (optional; must be paired with EPOCH_END)
  EPOCH_END         Inclusive epoch end (optional; must be paired with EPOCH_START)
  OUT_DIR           Output directory (default: ./cluster-missing-keys)
  KEEP_INTERMEDIATE Keep sorted/intermediate TSV files (default: 0)

Outputs:
  - ${OUT_DIR}/summary.csv
  - ${OUT_DIR}/${table}/missing-keys-epoch-${epoch}.csv when MODE=missing-keys

Notes:
  - MODE=counts compares row counts per epoch, but equal counts do not prove identical rows.
  - MODE=missing-keys is a source -> target audit. Extra rows on the target are ignored.
  - transactions_local CSVs use slot,slot_idx,signature where signature is base58.
EOF
}

die() {
  echo "error: $*" >&2
  exit 1
}

warn() {
  echo "warn: $*" >&2
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

require_safe_sql_string() {
  local name="$1"
  local value="$2"
  [[ "$value" != *"'"* ]] || die "$name must not contain single quotes"
  [[ "$value" != *'\'* ]] || die "$name must not contain backslashes"
  [[ "$value" != *$'\t'* ]] || die "$name must not contain tabs"
  [[ "$value" != *$'\n'* ]] || die "$name must not contain newlines"
  [[ "$value" != *$'\r'* ]] || die "$name must not contain carriage returns"
}

csv_escape() {
  local value="$1"
  value="${value//\"/\"\"}"
  printf '"%s"' "$value"
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

validate_supported_table() {
  local table="$1"
  case "$table" in
    transactions_local|blocks_metadata_local)
      ;;
    *)
      die "unsupported table '${table}' (supported: transactions_local, blocks_metadata_local)"
      ;;
  esac
}

validate_mode() {
  local mode="$1"
  case "$mode" in
    counts|missing-keys)
      ;;
    *)
      die "unsupported MODE '${mode}' (supported: counts, missing-keys)"
      ;;
  esac
}

table_header_csv() {
  local table="$1"
  case "$table" in
    transactions_local)
      printf 'slot,slot_idx,signature'
      ;;
    blocks_metadata_local)
      printf 'slot'
      ;;
  esac
}

table_select_list() {
  local table="$1"
  case "$table" in
    transactions_local)
      printf 'slot, slot_idx, base58Encode(signature) AS signature'
      ;;
    blocks_metadata_local)
      printf 'slot'
      ;;
  esac
}

table_epoch_bounds() {
  local host="$1"
  local port="$2"
  local user="$3"
  local pass="$4"
  local database="$5"
  local cluster="$6"
  local table="$7"

  clickhouse_query \
    "$host" "$port" "$user" "$pass" "$database" \
    "SELECT
       min(intDiv(slot, 432000)) AS min_epoch,
       max(intDiv(slot, 432000)) AS max_epoch
     FROM cluster('${cluster}', '${database}', '${table}')
     SETTINGS
       skip_unavailable_shards = 0,
       max_execution_time = 0,
       max_execution_time_leaf = 0
     FORMAT TabSeparated"
}

export_table_epoch_keys() {
  local host="$1"
  local port="$2"
  local user="$3"
  local pass="$4"
  local database="$5"
  local cluster="$6"
  local table="$7"
  local epoch="$8"
  local outfile="$9"
  local select_list

  select_list="$(table_select_list "$table")"
  clickhouse_query \
    "$host" "$port" "$user" "$pass" "$database" \
    "SELECT ${select_list}
     FROM cluster('${cluster}', '${database}', '${table}')
     WHERE intDiv(slot, 432000) = ${epoch}
     SETTINGS
       skip_unavailable_shards = 0,
       max_execution_time = 0,
       max_execution_time_leaf = 0
     FORMAT TabSeparated" > "$outfile"
}

export_table_epoch_counts() {
  local host="$1"
  local port="$2"
  local user="$3"
  local pass="$4"
  local database="$5"
  local cluster="$6"
  local table="$7"
  local epoch_start="$8"
  local epoch_end="$9"
  local outfile="${10}"
  local epoch_filter=""

  if [[ -n "$epoch_start" && -n "$epoch_end" ]]; then
    epoch_filter="WHERE intDiv(slot, 432000) BETWEEN ${epoch_start} AND ${epoch_end}"
  fi
  clickhouse_query \
    "$host" "$port" "$user" "$pass" "$database" \
    "SELECT
       intDiv(slot, 432000) AS epoch,
       count() AS row_count
     FROM cluster('${cluster}', '${database}', '${table}') FINAL
     ${epoch_filter}
     GROUP BY epoch
     ORDER BY epoch
     SETTINGS
       skip_unavailable_shards = 0,
       max_execution_time = 0,
       max_execution_time_leaf = 0
     FORMAT TabSeparated" > "$outfile"
}

append_summary_row() {
  local mode="$1"
  local table="$2"
  local epoch="$3"
  local source_count="$4"
  local target_count="$5"
  local delta="$6"
  local status="$7"
  local missing_path="$8"

  printf '%s,%s,%s,%s,%s,%s,%s,%s\n' \
    "$(csv_escape "$mode")" \
    "$(csv_escape "$table")" \
    "$(csv_escape "$epoch")" \
    "$(csv_escape "$source_count")" \
    "$(csv_escape "$target_count")" \
    "$(csv_escape "$delta")" \
    "$(csv_escape "$status")" \
    "$(csv_escape "$missing_path")" >> "$SUMMARY_FILE"
}

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
TABLES="${TABLES:-transactions_local,blocks_metadata_local}"
MODE="${MODE:-counts}"
EPOCH_START="${EPOCH_START:-}"
EPOCH_END="${EPOCH_END:-}"
OUT_DIR="${OUT_DIR:-./cluster-missing-keys}"
KEEP_INTERMEDIATE="${KEEP_INTERMEDIATE:-0}"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

[[ $# -eq 0 ]] || {
  usage >&2
  die "this script is configured via environment variables and does not accept positional arguments"
}

[[ -n "$SOURCE_CH_HOST" ]] || die "SOURCE_CH_HOST is required"
[[ -n "$SOURCE_CLUSTER" ]] || die "SOURCE_CLUSTER is required"
[[ -n "$TARGET_CH_HOST" ]] || die "TARGET_CH_HOST is required"
[[ -n "$TARGET_CLUSTER" ]] || die "TARGET_CLUSTER is required"

require_cmd clickhouse
if [[ "$MODE" == "missing-keys" ]]; then
  require_cmd sort
  require_cmd comm
  require_cmd awk
fi

require_uint "SOURCE_CH_PORT" "$SOURCE_CH_PORT"
require_uint "TARGET_CH_PORT" "$TARGET_CH_PORT"
[[ "$KEEP_INTERMEDIATE" == "0" || "$KEEP_INTERMEDIATE" == "1" ]] || die "KEEP_INTERMEDIATE must be 0 or 1"
validate_mode "$MODE"
require_safe_sql_string "SOURCE_CLUSTER" "$SOURCE_CLUSTER"
require_safe_sql_string "TARGET_CLUSTER" "$TARGET_CLUSTER"
require_safe_sql_string "SOURCE_DATABASE" "$SOURCE_DATABASE"
require_safe_sql_string "TARGET_DATABASE" "$TARGET_DATABASE"

if [[ -n "$EPOCH_START" || -n "$EPOCH_END" ]]; then
  [[ -n "$EPOCH_START" && -n "$EPOCH_END" ]] || die "EPOCH_START and EPOCH_END must be set together"
  require_uint "EPOCH_START" "$EPOCH_START"
  require_uint "EPOCH_END" "$EPOCH_END"
  (( EPOCH_START <= EPOCH_END )) || die "EPOCH_START must be <= EPOCH_END"
fi

mkdir -p "$OUT_DIR"
SUMMARY_FILE="$OUT_DIR/summary.csv"
printf 'mode,table,epoch,source_row_count,target_row_count,row_count_delta,status,missing_csv_path\n' > "$SUMMARY_FILE"

validate_cluster "$SOURCE_CH_HOST" "$SOURCE_CH_PORT" "$SOURCE_CH_USER" "$SOURCE_CH_PASS" "$SOURCE_DATABASE" "$SOURCE_CLUSTER"
validate_cluster "$TARGET_CH_HOST" "$TARGET_CH_PORT" "$TARGET_CH_USER" "$TARGET_CH_PASS" "$TARGET_DATABASE" "$TARGET_CLUSTER"

IFS=',' read -r -a raw_tables <<< "$TABLES"
declare -a requested_tables=()
for raw_table in "${raw_tables[@]}"; do
  table="$(trim_whitespace "$raw_table")"
  [[ -n "$table" ]] || continue
  validate_supported_table "$table"
  requested_tables+=("$table")
done

(( ${#requested_tables[@]} > 0 )) || die "TABLES did not contain any supported table names"

for table in "${requested_tables[@]}"; do
  validate_table_exists "$SOURCE_CH_HOST" "$SOURCE_CH_PORT" "$SOURCE_CH_USER" "$SOURCE_CH_PASS" "$SOURCE_DATABASE" "$table"
  validate_table_exists "$TARGET_CH_HOST" "$TARGET_CH_PORT" "$TARGET_CH_USER" "$TARGET_CH_PASS" "$TARGET_DATABASE" "$table"

  table_dir="$OUT_DIR/$table"
  mkdir -p "$table_dir"

  if [[ "$MODE" == "counts" ]]; then
    source_counts_file="$table_dir/source-counts.tsv"
    target_counts_file="$table_dir/target-counts.tsv"

    echo "checking table=${table} mode=counts"
    export_table_epoch_counts \
      "$SOURCE_CH_HOST" "$SOURCE_CH_PORT" "$SOURCE_CH_USER" "$SOURCE_CH_PASS" \
      "$SOURCE_DATABASE" "$SOURCE_CLUSTER" "$table" "$EPOCH_START" "$EPOCH_END" "$source_counts_file"
    export_table_epoch_counts \
      "$TARGET_CH_HOST" "$TARGET_CH_PORT" "$TARGET_CH_USER" "$TARGET_CH_PASS" \
      "$TARGET_DATABASE" "$TARGET_CLUSTER" "$table" "$EPOCH_START" "$EPOCH_END" "$target_counts_file"

    declare -A source_counts=()
    declare -A target_counts=()
    table_epoch_start=""
    table_epoch_end=""

    while IFS=$'\t' read -r epoch row_count; do
      epoch="$(trim_whitespace "${epoch:-}")"
      row_count="$(trim_whitespace "${row_count:-}")"
      [[ -n "$epoch" && -n "$row_count" ]] || continue
      require_uint "source epoch" "$epoch"
      require_uint "source row_count" "$row_count"
      source_counts["$epoch"]="$row_count"
      if [[ -z "$table_epoch_start" || "$epoch" -lt "$table_epoch_start" ]]; then
        table_epoch_start="$epoch"
      fi
      if [[ -z "$table_epoch_end" || "$epoch" -gt "$table_epoch_end" ]]; then
        table_epoch_end="$epoch"
      fi
    done < "$source_counts_file"

    while IFS=$'\t' read -r epoch row_count; do
      epoch="$(trim_whitespace "${epoch:-}")"
      row_count="$(trim_whitespace "${row_count:-}")"
      [[ -n "$epoch" && -n "$row_count" ]] || continue
      require_uint "target epoch" "$epoch"
      require_uint "target row_count" "$row_count"
      target_counts["$epoch"]="$row_count"
      if [[ -z "$table_epoch_start" || "$epoch" -lt "$table_epoch_start" ]]; then
        table_epoch_start="$epoch"
      fi
      if [[ -z "$table_epoch_end" || "$epoch" -gt "$table_epoch_end" ]]; then
        table_epoch_end="$epoch"
      fi
    done < "$target_counts_file"

    if [[ -n "$EPOCH_START" && -n "$EPOCH_END" ]]; then
      table_epoch_start="$EPOCH_START"
      table_epoch_end="$EPOCH_END"
    fi

    if [[ -z "$table_epoch_start" || -z "$table_epoch_end" ]]; then
      warn "table ${table} is empty on both clusters; skipping"
      if [[ "$KEEP_INTERMEDIATE" == "0" ]]; then
        rm -f "$source_counts_file" "$target_counts_file"
      fi
      unset source_counts
      unset target_counts
      continue
    fi

    echo "  epochs=${table_epoch_start}-${table_epoch_end}"
    for epoch in $(seq "$table_epoch_start" "$table_epoch_end"); do
      source_count="${source_counts[$epoch]:-0}"
      target_count="${target_counts[$epoch]:-0}"
      delta=$((source_count - target_count))
      status="match"
      if (( delta != 0 )); then
        status="count_mismatch"
        echo "  epoch=${epoch} source=${source_count} target=${target_count} delta=${delta}"
      fi
      append_summary_row "$MODE" "$table" "$epoch" "$source_count" "$target_count" "$delta" "$status" ""
    done

    if [[ "$KEEP_INTERMEDIATE" == "0" ]]; then
      rm -f "$source_counts_file" "$target_counts_file"
    fi

    unset source_counts
    unset target_counts
  else
    if [[ -n "$EPOCH_START" && -n "$EPOCH_END" ]]; then
      table_epoch_start="$EPOCH_START"
      table_epoch_end="$EPOCH_END"
    else
      bounds="$(table_epoch_bounds \
        "$SOURCE_CH_HOST" "$SOURCE_CH_PORT" "$SOURCE_CH_USER" "$SOURCE_CH_PASS" \
        "$SOURCE_DATABASE" "$SOURCE_CLUSTER" "$table")" \
        || die "unable to resolve epoch bounds for source ${SOURCE_CLUSTER}.${SOURCE_DATABASE}.${table}"
      table_epoch_start="$(trim_whitespace "${bounds%%$'\t'*}")"
      table_epoch_end="$(trim_whitespace "${bounds#*$'\t'}")"

      if [[ "$table_epoch_start" == "\\N" || "$table_epoch_end" == "\\N" || -z "$table_epoch_start" || -z "$table_epoch_end" ]]; then
        warn "source table ${SOURCE_DATABASE}.${table} is empty on cluster '${SOURCE_CLUSTER}'; skipping"
        continue
      fi
      require_uint "table epoch start" "$table_epoch_start"
      require_uint "table epoch end" "$table_epoch_end"
    fi

    echo "checking table=${table} mode=missing-keys epochs=${table_epoch_start}-${table_epoch_end}"

    for epoch in $(seq "$table_epoch_start" "$table_epoch_end"); do
      source_raw="$table_dir/source-keys-epoch-${epoch}.tsv"
      target_raw="$table_dir/target-keys-epoch-${epoch}.tsv"
      source_sorted="$table_dir/source-keys-epoch-${epoch}.sorted.tsv"
      target_sorted="$table_dir/target-keys-epoch-${epoch}.sorted.tsv"
      missing_tsv="$table_dir/missing-keys-epoch-${epoch}.tsv"
      missing_csv="$table_dir/missing-keys-epoch-${epoch}.csv"

      echo "  epoch=${epoch} exporting source keys"
      export_table_epoch_keys \
        "$SOURCE_CH_HOST" "$SOURCE_CH_PORT" "$SOURCE_CH_USER" "$SOURCE_CH_PASS" \
        "$SOURCE_DATABASE" "$SOURCE_CLUSTER" "$table" "$epoch" "$source_raw"

      echo "  epoch=${epoch} exporting target keys"
      export_table_epoch_keys \
        "$TARGET_CH_HOST" "$TARGET_CH_PORT" "$TARGET_CH_USER" "$TARGET_CH_PASS" \
        "$TARGET_DATABASE" "$TARGET_CLUSTER" "$table" "$epoch" "$target_raw"

      LC_ALL=C sort -u "$source_raw" > "$source_sorted"
      LC_ALL=C sort -u "$target_raw" > "$target_sorted"
      comm -23 "$source_sorted" "$target_sorted" > "$missing_tsv"

      source_count="$(wc -l < "$source_sorted" | tr -d '[:space:]')"
      target_count="$(wc -l < "$target_sorted" | tr -d '[:space:]')"
      missing_count="$(wc -l < "$missing_tsv" | tr -d '[:space:]')"
      delta=$((source_count - target_count))

      if [[ "$missing_count" == "0" ]]; then
        rm -f "$missing_tsv" "$missing_csv"
        append_summary_row "$MODE" "$table" "$epoch" "$source_count" "$target_count" "$delta" "match" ""
        echo "  epoch=${epoch} ok source=${source_count} target=${target_count} missing=0"
      else
        {
          printf '%s\n' "$(table_header_csv "$table")"
          awk 'BEGIN { OFS="," } { gsub(/\t/, ","); print }' "$missing_tsv"
        } > "$missing_csv"
        append_summary_row "$MODE" "$table" "$epoch" "$source_count" "$target_count" "$delta" "missing_keys" "$missing_csv"
        echo "  epoch=${epoch} missing=${missing_count} -> ${missing_csv}"
      fi

      if [[ "$KEEP_INTERMEDIATE" == "0" ]]; then
        rm -f "$source_raw" "$target_raw" "$source_sorted" "$target_sorted" "$missing_tsv"
      fi
    done
  fi
done

echo "summary -> ${SUMMARY_FILE}"
