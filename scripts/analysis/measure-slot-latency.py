#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
#
# Copyright 2025-2026 Triton One Limited. All rights reserved.
#

"""
Measure how long it takes for the latest Solana slot to appear in ClickHouse.

Example:
  scripts/analysis/measure-slot-latency.py \
    --clickhouse-url http://localhost:8123 \
    --clickhouse-database default \
    --clickhouse-table blocks_metadata

Defaults can be provided via env vars:
  SOLANA_RPC_URL, SOLANA_COMMITMENT,
  CLICKHOUSE_URL, CLICKHOUSE_DATABASE, CLICKHOUSE_TABLE,
  CLICKHOUSE_USER, CLICKHOUSE_PASSWORD,
  POLL_INTERVAL_MS, MAX_WAIT_SECONDS, REQUEST_TIMEOUT_SECONDS,
  RPC_RETRIES, RPC_BACKOFF_SECONDS
"""

from __future__ import annotations

import argparse
import json
import os
import re
import socket
import sys
import time
import urllib.error
import urllib.request
from typing import Any, Dict, Optional

IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _env(name: str, default: Optional[str] = None) -> Optional[str]:
    value = os.getenv(name)
    if value is None or value == "":
        return default
    return value


def _parse_int(value: str, name: str) -> int:
    try:
        return int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be an integer, got {value!r}") from exc


def _validate_ident(label: str, value: str) -> str:
    if not IDENT_RE.match(value):
        raise ValueError(
            f"{label} must be a simple identifier (letters, numbers, underscore): {value!r}"
        )
    return value


def _resolve_table(database: str, table: str) -> str:
    if "." in table:
        parts = table.split(".")
        if len(parts) != 2:
            raise ValueError(f"clickhouse table must be db.table or table: {table!r}")
        db_part = _validate_ident("clickhouse database", parts[0])
        table_part = _validate_ident("clickhouse table", parts[1])
        return f"{db_part}.{table_part}"
    db_part = _validate_ident("clickhouse database", database)
    table_part = _validate_ident("clickhouse table", table)
    return f"{db_part}.{table_part}"


def rpc_call(
    url: str,
    method: str,
    params: list[object],
    *,
    request_id: int,
    timeout_s: float,
    retries: int,
    backoff_s: float,
) -> object:
    payload = json.dumps(
        {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}
    ).encode("utf-8")
    headers = {"Content-Type": "application/json"}

    last_err: Optional[Exception] = None
    for attempt in range(retries + 1):
        if attempt > 0:
            time.sleep(backoff_s * attempt)
        try:
            req = urllib.request.Request(url, data=payload, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout_s) as resp:
                raw = resp.read()
            body = json.loads(raw.decode("utf-8"))
            if isinstance(body, dict) and body.get("error"):
                raise RuntimeError(f"RPC error: {body['error']}")
            return body.get("result")
        except (
            urllib.error.HTTPError,
            urllib.error.URLError,
            socket.timeout,
            json.JSONDecodeError,
            RuntimeError,
        ) as exc:
            last_err = exc
            continue

    raise RuntimeError(f"RPC call failed after {retries + 1} attempts: {last_err}")


def clickhouse_query(
    url: str,
    query: str,
    *,
    user: Optional[str],
    password: Optional[str],
    timeout_s: float,
) -> str:
    headers: Dict[str, str] = {"Content-Type": "text/plain; charset=utf-8"}
    if user:
        headers["X-ClickHouse-User"] = user
    if password:
        headers["X-ClickHouse-Key"] = password

    data = query.encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout_s) as resp:
        raw = resp.read()
    return raw.decode("utf-8").strip()


def fetch_latest_slot(
    rpc_url: str,
    commitment: Optional[str],
    *,
    timeout_s: float,
    retries: int,
    backoff_s: float,
) -> int:
    params: list[object] = []
    if commitment:
        params.append({"commitment": commitment})
    result = rpc_call(
        rpc_url,
        "getSlot",
        params,
        request_id=1,
        timeout_s=timeout_s,
        retries=retries,
        backoff_s=backoff_s,
    )
    if not isinstance(result, (int, float, str)):
        raise RuntimeError(f"Unexpected getSlot result: {result!r}")
    slot = int(result)
    if slot < 0:
        raise RuntimeError(f"Unexpected getSlot result: {slot}")
    return slot


def poll_clickhouse(
    *,
    clickhouse_url: str,
    clickhouse_table: str,
    slot: int,
    user: Optional[str],
    password: Optional[str],
    poll_interval_s: float,
    max_wait_s: float,
    timeout_s: float,
) -> Optional[float]:
    start = time.perf_counter()
    deadline = start + max_wait_s
    query = f"SELECT count() FROM {clickhouse_table} WHERE slot = {slot}"

    while True:
        count_raw = clickhouse_query(
            clickhouse_url,
            query,
            user=user,
            password=password,
            timeout_s=timeout_s,
        )
        try:
            count = int(count_raw)
        except ValueError as exc:
            raise RuntimeError(f"Unexpected ClickHouse response: {count_raw!r}") from exc

        if count > 0:
            return time.perf_counter() - start

        now = time.perf_counter()
        if now >= deadline:
            return None

        sleep_for = min(poll_interval_s, max(0.0, deadline - now))
        time.sleep(sleep_for)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Measure time for latest Solana slot to appear in ClickHouse."
    )
    parser.add_argument(
        "--solana-rpc-url",
        default=_env("SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com"),
        help="Solana JSON-RPC URL (env: SOLANA_RPC_URL)",
    )
    parser.add_argument(
        "--solana-commitment",
        default=_env("SOLANA_COMMITMENT", "finalized"),
        help="RPC commitment for getSlot (env: SOLANA_COMMITMENT)",
    )
    parser.add_argument(
        "--clickhouse-url",
        default=_env("CLICKHOUSE_URL", "http://localhost:8123"),
        help="ClickHouse HTTP URL (env: CLICKHOUSE_URL)",
    )
    parser.add_argument(
        "--clickhouse-database",
        default=_env("CLICKHOUSE_DATABASE", "default"),
        help="ClickHouse database (env: CLICKHOUSE_DATABASE)",
    )
    parser.add_argument(
        "--clickhouse-table",
        default=_env("CLICKHOUSE_TABLE", "blocks_metadata"),
        help="ClickHouse table name or db.table (env: CLICKHOUSE_TABLE)",
    )
    parser.add_argument(
        "--clickhouse-user",
        default=_env("CLICKHOUSE_USER", ""),
        help="ClickHouse user (env: CLICKHOUSE_USER)",
    )
    parser.add_argument(
        "--clickhouse-password",
        default=_env("CLICKHOUSE_PASSWORD", ""),
        help="ClickHouse password (env: CLICKHOUSE_PASSWORD)",
    )
    parser.add_argument(
        "--poll-interval-ms",
        default=_env("POLL_INTERVAL_MS", "1000"),
        help="Polling interval in ms (env: POLL_INTERVAL_MS)",
    )
    parser.add_argument(
        "--max-wait-seconds",
        default=_env("MAX_WAIT_SECONDS", "300"),
        help="Max time to wait for the slot (env: MAX_WAIT_SECONDS)",
    )
    parser.add_argument(
        "--request-timeout-seconds",
        default=_env("REQUEST_TIMEOUT_SECONDS", "10"),
        help="Timeout per request in seconds (env: REQUEST_TIMEOUT_SECONDS)",
    )
    parser.add_argument(
        "--rpc-retries",
        default=_env("RPC_RETRIES", "2"),
        help="Number of RPC retries (env: RPC_RETRIES)",
    )
    parser.add_argument(
        "--rpc-backoff-seconds",
        default=_env("RPC_BACKOFF_SECONDS", "0.5"),
        help="Backoff seconds between RPC retries (env: RPC_BACKOFF_SECONDS)",
    )

    args = parser.parse_args()

    poll_interval_ms = _parse_int(str(args.poll_interval_ms), "poll-interval-ms")
    max_wait_s = float(_parse_int(str(args.max_wait_seconds), "max-wait-seconds"))
    timeout_s = float(_parse_int(str(args.request_timeout_seconds), "request-timeout-seconds"))
    retries = _parse_int(str(args.rpc_retries), "rpc-retries")
    backoff_s = float(args.rpc_backoff_seconds)

    if poll_interval_ms <= 0:
        raise ValueError("poll-interval-ms must be > 0")
    if max_wait_s <= 0:
        raise ValueError("max-wait-seconds must be > 0")
    if timeout_s <= 0:
        raise ValueError("request-timeout-seconds must be > 0")
    if retries < 0:
        raise ValueError("rpc-retries must be >= 0")
    if backoff_s < 0:
        raise ValueError("rpc-backoff-seconds must be >= 0")

    clickhouse_table = _resolve_table(args.clickhouse_database, args.clickhouse_table)

    commitment = args.solana_commitment
    if commitment == "":
        commitment = None

    slot = fetch_latest_slot(
        args.solana_rpc_url,
        commitment,
        timeout_s=timeout_s,
        retries=retries,
        backoff_s=backoff_s,
    )

    if commitment:
        print(f"Latest slot from {args.solana_rpc_url} ({commitment}): {slot}")
    else:
        print(f"Latest slot from {args.solana_rpc_url}: {slot}")
    print(
        "Polling ClickHouse for slot...",
        f"table={clickhouse_table}",
        f"interval={poll_interval_ms}ms",
        f"max_wait={int(max_wait_s)}s",
        flush=True,
    )

    elapsed = poll_clickhouse(
        clickhouse_url=args.clickhouse_url,
        clickhouse_table=clickhouse_table,
        slot=slot,
        user=args.clickhouse_user or None,
        password=args.clickhouse_password or None,
        poll_interval_s=poll_interval_ms / 1000.0,
        max_wait_s=max_wait_s,
        timeout_s=timeout_s,
    )

    if elapsed is None:
        print(
            f"Slot {slot} did not appear in {clickhouse_table} within {int(max_wait_s)}s",
            file=sys.stderr,
        )
        return 2

    print(f"Slot {slot} appeared after {elapsed * 1000:.1f}ms")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1)
