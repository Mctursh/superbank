#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
#
# Copyright 2025-2026 Triton One Limited. All rights reserved.
#

"""
Stream Solana slots via slotSubscribe and measure ClickHouse ingestion latency.

Requires: pip install websockets

Env defaults:
  SOLANA_RPC_URL, SOLANA_WS_URL, SOLANA_COMMITMENT,
  CLICKHOUSE_URL, CLICKHOUSE_DATABASE, CLICKHOUSE_TABLE,
  CLICKHOUSE_USER, CLICKHOUSE_PASSWORD,
  POLL_INTERVAL_MS, MAX_WAIT_SECONDS, REQUEST_TIMEOUT_SECONDS,
  SUMMARY_INTERVAL_SECONDS, MAX_IN_FLIGHT, LATENCY_WINDOW, LOG_EACH
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import os
import re
import socket
import sys
import time
import urllib.error
import urllib.request
from collections import deque
from typing import Optional

try:
    import websockets
except ImportError as exc:  # pragma: no cover - runtime dependency
    print(
        "error: missing dependency 'websockets' (install with: pip install websockets)",
        file=sys.stderr,
    )
    raise SystemExit(1) from exc

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


def _derive_ws_url(rpc_url: str) -> str:
    if rpc_url.startswith("https://"):
        return "wss://" + rpc_url[len("https://") :]
    if rpc_url.startswith("http://"):
        return "ws://" + rpc_url[len("http://") :]
    return rpc_url


def clickhouse_query(
    url: str,
    query: str,
    *,
    user: Optional[str],
    password: Optional[str],
    timeout_s: float,
) -> str:
    headers = {"Content-Type": "text/plain; charset=utf-8"}
    if user:
        headers["X-ClickHouse-User"] = user
    if password:
        headers["X-ClickHouse-Key"] = password

    data = query.encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout_s) as resp:
        raw = resp.read()
    return raw.decode("utf-8").strip()


async def clickhouse_has_slot(
    *,
    clickhouse_url: str,
    clickhouse_table: str,
    slot: int,
    user: Optional[str],
    password: Optional[str],
    timeout_s: float,
) -> bool:
    query = f"SELECT count() FROM {clickhouse_table} WHERE slot = {slot}"

    def _run_query() -> bool:
        raw = clickhouse_query(
            clickhouse_url,
            query,
            user=user,
            password=password,
            timeout_s=timeout_s,
        )
        try:
            count = int(raw)
        except ValueError as exc:
            raise RuntimeError(f"Unexpected ClickHouse response: {raw!r}") from exc
        return count > 0

    return await asyncio.to_thread(_run_query)


def _percentile(values: list[float], pct: float) -> Optional[float]:
    if not values:
        return None
    ordered = sorted(values)
    idx = int(round((pct / 100.0) * (len(ordered) - 1)))
    idx = max(0, min(len(ordered) - 1, idx))
    return ordered[idx]


async def main() -> int:
    parser = argparse.ArgumentParser(
        description="Stream slotSubscribe and measure ClickHouse slot ingestion latency."
    )
    parser.add_argument(
        "--solana-rpc-url",
        default=_env("SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com"),
        help="Solana JSON-RPC URL (env: SOLANA_RPC_URL)",
    )
    parser.add_argument(
        "--solana-ws-url",
        default=_env("SOLANA_WS_URL", None),
        help="Solana WebSocket URL (env: SOLANA_WS_URL). Defaults to WS derived from RPC URL.",
    )
    parser.add_argument(
        "--solana-commitment",
        default=_env("SOLANA_COMMITMENT", "finalized"),
        help="RPC commitment for slotSubscribe (env: SOLANA_COMMITMENT)",
    )
    parser.add_argument(
        "--ws-method",
        default=_env("WS_METHOD", "rootSubscribe"),
        choices=("slotSubscribe", "rootSubscribe"),
        help="WebSocket subscription method (env: WS_METHOD)",
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
        default=_env("POLL_INTERVAL_MS", "100"),
        help="Polling interval in ms (env: POLL_INTERVAL_MS)",
    )
    parser.add_argument(
        "--max-wait-seconds",
        default=_env("MAX_WAIT_SECONDS", "120"),
        help="Max time to wait for a slot (env: MAX_WAIT_SECONDS)",
    )
    parser.add_argument(
        "--request-timeout-seconds",
        default=_env("REQUEST_TIMEOUT_SECONDS", "10"),
        help="Timeout per ClickHouse request in seconds (env: REQUEST_TIMEOUT_SECONDS)",
    )
    parser.add_argument(
        "--summary-interval-seconds",
        default=_env("SUMMARY_INTERVAL_SECONDS", "10"),
        help="How often to print summary stats (env: SUMMARY_INTERVAL_SECONDS)",
    )
    parser.add_argument(
        "--max-in-flight",
        default=_env("MAX_IN_FLIGHT", "200"),
        help="Max concurrent slot checks (env: MAX_IN_FLIGHT)",
    )
    parser.add_argument(
        "--latency-window",
        default=_env("LATENCY_WINDOW", "1000"),
        help="Number of samples kept for percentiles (env: LATENCY_WINDOW)",
    )
    parser.add_argument(
        "--log-each",
        action="store_true",
        default=_env("LOG_EACH", "0") in ("1", "true", "TRUE", "yes", "YES"),
        help="Log each slot latency as it arrives (env: LOG_EACH=1)",
    )

    args = parser.parse_args()

    poll_interval_ms = _parse_int(str(args.poll_interval_ms), "poll-interval-ms")
    max_wait_s = float(_parse_int(str(args.max_wait_seconds), "max-wait-seconds"))
    timeout_s = float(_parse_int(str(args.request_timeout_seconds), "request-timeout-seconds"))
    summary_interval_s = float(
        _parse_int(str(args.summary_interval_seconds), "summary-interval-seconds")
    )
    max_in_flight = _parse_int(str(args.max_in_flight), "max-in-flight")
    latency_window = _parse_int(str(args.latency_window), "latency-window")

    if poll_interval_ms <= 0:
        raise ValueError("poll-interval-ms must be > 0")
    if max_wait_s <= 0:
        raise ValueError("max-wait-seconds must be > 0")
    if timeout_s <= 0:
        raise ValueError("request-timeout-seconds must be > 0")
    if summary_interval_s <= 0:
        raise ValueError("summary-interval-seconds must be > 0")
    if max_in_flight <= 0:
        raise ValueError("max-in-flight must be > 0")
    if latency_window <= 0:
        raise ValueError("latency-window must be > 0")

    clickhouse_table = _resolve_table(args.clickhouse_database, args.clickhouse_table)
    commitment = args.solana_commitment or None
    ws_url = args.solana_ws_url or _derive_ws_url(args.solana_rpc_url)

    if args.ws_method == "rootSubscribe" and commitment:
        print("note: rootSubscribe does not accept commitment; ignoring", flush=True)
        commitment = None

    print(
        f"Starting {args.ws_method} latency stream",
        f"ws={ws_url}",
        f"commitment={commitment or 'default'}",
        f"table={clickhouse_table}",
        flush=True,
    )

    latencies = deque(maxlen=latency_window)
    seen_slots = set()
    seen_order = deque()
    seen_limit = 50000
    stats = {
        "measured": 0,
        "timeouts": 0,
        "dropped": 0,
        "errors": 0,
    }
    semaphore = asyncio.Semaphore(max_in_flight)

    async def track_slot(slot: int, received_at: float) -> None:
        if semaphore._value <= 0:  # pylint: disable=protected-access
            stats["dropped"] += 1
            return
        await semaphore.acquire()

        try:
            deadline = received_at + max_wait_s
            while True:
                found = await clickhouse_has_slot(
                    clickhouse_url=args.clickhouse_url,
                    clickhouse_table=clickhouse_table,
                    slot=slot,
                    user=args.clickhouse_user or None,
                    password=args.clickhouse_password or None,
                    timeout_s=timeout_s,
                )
                if found:
                    elapsed = time.perf_counter() - received_at
                    latencies.append(elapsed)
                    stats["measured"] += 1
                    if args.log_each:
                        print(f"slot {slot} -> {elapsed * 1000:.1f}ms", flush=True)
                    return

                now = time.perf_counter()
                if now >= deadline:
                    stats["timeouts"] += 1
                    return

                await asyncio.sleep(poll_interval_ms / 1000.0)
        except (urllib.error.URLError, socket.timeout, RuntimeError) as exc:
            stats["errors"] += 1
            print(f"warning: clickhouse error for slot {slot}: {exc}", file=sys.stderr)
        finally:
            semaphore.release()

    async def summary_loop() -> None:
        while True:
            await asyncio.sleep(summary_interval_s)
            values = list(latencies)
            avg = (sum(values) / len(values)) if values else None
            p50 = _percentile(values, 50.0)
            p95 = _percentile(values, 95.0)
            p99 = _percentile(values, 99.0)
            in_flight = max_in_flight - semaphore._value  # pylint: disable=protected-access
            summary = (
                f"measured={stats['measured']} "
                f"timeouts={stats['timeouts']} "
                f"dropped={stats['dropped']} "
                f"errors={stats['errors']} "
                f"in_flight={in_flight}"
            )
            if avg is not None:
                summary += (
                    f" avg={avg * 1000:.1f}ms"
                    f" p50={p50 * 1000:.1f}ms"
                    f" p95={p95 * 1000:.1f}ms"
                    f" p99={p99 * 1000:.1f}ms"
                )
            print(summary, flush=True)

    summary_task = asyncio.create_task(summary_loop())

    try:
        async with websockets.connect(ws_url, ping_interval=20, ping_timeout=20) as ws:
            params = []
            if commitment and args.ws_method == "slotSubscribe":
                params.append({"commitment": commitment})
            sub_id = 1
            payload = {"jsonrpc": "2.0", "id": sub_id, "method": args.ws_method}
            if params:
                payload["params"] = params
            await ws.send(json.dumps(payload))

            subscribed = False
            while True:
                raw = await ws.recv()
                msg = json.loads(raw)

                if not subscribed and isinstance(msg, dict) and msg.get("id") == sub_id:
                    if msg.get("error"):
                        error = msg["error"]
                        # Some providers reject slotSubscribe params entirely.
                        if (
                            params
                            and isinstance(error, dict)
                            and error.get("code") == -32602
                            and "No parameters were expected" in str(error.get("message", ""))
                        ):
                            print(
                                "slotSubscribe rejected params; retrying without commitment",
                                flush=True,
                            )
                            params = []
                            sub_id = 2
                            await ws.send(
                                json.dumps({"jsonrpc": "2.0", "id": sub_id, "method": "slotSubscribe"})
                            )
                            continue
                        raise RuntimeError(f"slotSubscribe error: {error}")
                    print(f"Subscribed: id={msg.get('result')}", flush=True)
                    subscribed = True
                    continue

                params = msg.get("params") if isinstance(msg, dict) else None
                result = params.get("result") if isinstance(params, dict) else None
                slot = None
                if isinstance(result, int):
                    slot = result
                elif isinstance(result, dict):
                    if "slot" in result:
                        slot = result.get("slot")
                    elif "root" in result:
                        slot = result.get("root")
                if slot is None:
                    continue

                if slot in seen_slots:
                    continue
                seen_slots.add(slot)
                if len(seen_order) >= seen_limit:
                    old = seen_order.popleft()
                    seen_slots.discard(old)
                seen_order.append(slot)

                received_at = time.perf_counter()
                asyncio.create_task(track_slot(int(slot), received_at))
    finally:
        summary_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await summary_task

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(asyncio.run(main()))
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1)
