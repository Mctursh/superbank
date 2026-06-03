#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
#
# Copyright 2025-2026 Triton One Limited. All rights reserved.
#

"""
Compare getSignaturesForAddress results across two RPC endpoints.

Fetches pages from both endpoints, compares signatures and slot coverage,
and reports missing signatures plus slot ranges that look absent.

Example:
  scripts/analysis/compare-signatures.py \
    --endpoint-a http://localhost:8899 \
    --endpoint-b https://api.mainnet-beta.solana.com \
    --address Ec3vcxZ6p7qk4eQmDc4LFruYd7fd6hy1ttx14MsXWXxR \
    --limit 1000 \
    --max-pages 1000 \
    --commitment confirmed
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import sys
import time
import urllib.error
import urllib.request
from typing import Dict, Iterable, List, Optional, Tuple


def _env(name: str, default: Optional[str] = None) -> Optional[str]:
    value = os.getenv(name)
    if value is None or value == "":
        return default
    return value


def rpc_call(
    url: str,
    method: str,
    params: List[object],
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


def fetch_signatures(
    url: str,
    address: str,
    *,
    limit: int,
    max_pages: int,
    commitment: Optional[str],
    sleep_ms: int,
    timeout_s: float,
    retries: int,
    backoff_s: float,
    log_every: int,
) -> Tuple[List[Dict[str, object]], int, int]:
    entries: List[Dict[str, object]] = []
    seen = set()
    before: Optional[str] = None
    pages = 0
    duplicates = 0

    for page in range(max_pages):
        opts: Dict[str, object] = {"limit": limit}
        if commitment:
            opts["commitment"] = commitment
        if before:
            opts["before"] = before

        result = rpc_call(
            url,
            "getSignaturesForAddress",
            [address, opts],
            request_id=page + 1,
            timeout_s=timeout_s,
            retries=retries,
            backoff_s=backoff_s,
        )

        if not isinstance(result, list):
            raise RuntimeError(f"Unexpected RPC result type: {type(result)}")

        pages += 1
        if not result:
            break

        added = 0
        for entry in result:
            if not isinstance(entry, dict):
                continue
            signature = entry.get("signature")
            if not signature:
                continue
            if signature in seen:
                duplicates += 1
                continue
            seen.add(signature)
            entries.append(entry)
            added += 1

        new_before = result[-1].get("signature") if isinstance(result[-1], dict) else None
        if not new_before or new_before == before:
            break
        before = new_before

        if log_every > 0 and (page + 1) % log_every == 0:
            print(f"  fetched {pages} pages, {len(entries)} unique signatures", flush=True)

        if len(result) < limit:
            break

        if sleep_ms > 0:
            time.sleep(sleep_ms / 1000.0)

        if added == 0:
            break

    return entries, pages, duplicates


def build_maps(
    entries: Iterable[Dict[str, object]],
) -> Tuple[Dict[str, int], Dict[int, int]]:
    sig_to_slot: Dict[str, int] = {}
    slot_counts: Dict[int, int] = {}
    for entry in entries:
        signature = entry.get("signature")
        slot = entry.get("slot")
        if not signature or slot is None:
            continue
        try:
            slot_int = int(slot)
        except (TypeError, ValueError):
            continue
        sig_to_slot[signature] = slot_int
        slot_counts[slot_int] = slot_counts.get(slot_int, 0) + 1
    return sig_to_slot, slot_counts


def slot_ranges(slots: List[int]) -> List[Tuple[int, int, int]]:
    if not slots:
        return []
    slots.sort()
    ranges: List[Tuple[int, int, int]] = []
    start = slots[0]
    prev = slots[0]
    count = 1
    for slot in slots[1:]:
        if slot == prev + 1:
            prev = slot
            count += 1
            continue
        ranges.append((start, prev, count))
        start = slot
        prev = slot
        count = 1
    ranges.append((start, prev, count))
    return ranges


def print_ranges(label: str, ranges: List[Tuple[int, int, int]], max_output: int) -> None:
    print(f"{label}: {len(ranges)} ranges")
    if not ranges:
        return
    shown = ranges[:max_output]
    for start, end, count in shown:
        if start == end:
            print(f"  slot {start} (count {count})")
        else:
            print(f"  slots {start}-{end} (count {count})")
    if len(ranges) > max_output:
        print(f"  ... {len(ranges) - max_output} more ranges truncated")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Compare getSignaturesForAddress between two RPC endpoints."
    )
    parser.add_argument("--endpoint-a", default=_env("ENDPOINT_A"))
    parser.add_argument("--endpoint-b", default=_env("ENDPOINT_B"))
    parser.add_argument("--address", default=_env("ADDRESS"))
    parser.add_argument("--limit", type=int, default=int(_env("LIMIT", "1000")))
    parser.add_argument("--max-pages", type=int, default=int(_env("MAX_PAGES", "100")))
    parser.add_argument("--commitment", default=_env("COMMITMENT", "confirmed"))
    parser.add_argument("--sleep-ms", type=int, default=int(_env("SLEEP_MS", "0")))
    parser.add_argument("--timeout-s", type=float, default=float(_env("TIMEOUT_S", "30")))
    parser.add_argument("--retries", type=int, default=int(_env("RETRIES", "2")))
    parser.add_argument("--backoff-s", type=float, default=float(_env("BACKOFF_S", "0.5")))
    parser.add_argument("--log-every", type=int, default=int(_env("LOG_EVERY", "10")))
    parser.add_argument(
        "--max-range-output", type=int, default=int(_env("MAX_RANGE_OUTPUT", "50"))
    )
    parser.add_argument(
        "--max-missing-output", type=int, default=int(_env("MAX_MISSING_OUTPUT", "50"))
    )
    args = parser.parse_args()

    if not args.endpoint_a or not args.endpoint_b or not args.address:
        print("endpoint-a, endpoint-b, and address are required.", file=sys.stderr)
        return 2

    print("Comparing getSignaturesForAddress results")
    print(f"  endpoint A: {args.endpoint_a}")
    print(f"  endpoint B: {args.endpoint_b}")
    print(f"  address:    {args.address}")
    print(f"  limit:      {args.limit}")
    print(f"  max pages:  {args.max_pages}")
    print(f"  commitment: {args.commitment}")

    print("\nFetching endpoint A...")
    entries_a, pages_a, dup_a = fetch_signatures(
        args.endpoint_a,
        args.address,
        limit=args.limit,
        max_pages=args.max_pages,
        commitment=args.commitment,
        sleep_ms=args.sleep_ms,
        timeout_s=args.timeout_s,
        retries=args.retries,
        backoff_s=args.backoff_s,
        log_every=args.log_every,
    )
    print(f"  A: {len(entries_a)} unique signatures, {pages_a} pages, {dup_a} dupes")

    print("\nFetching endpoint B...")
    entries_b, pages_b, dup_b = fetch_signatures(
        args.endpoint_b,
        args.address,
        limit=args.limit,
        max_pages=args.max_pages,
        commitment=args.commitment,
        sleep_ms=args.sleep_ms,
        timeout_s=args.timeout_s,
        retries=args.retries,
        backoff_s=args.backoff_s,
        log_every=args.log_every,
    )
    print(f"  B: {len(entries_b)} unique signatures, {pages_b} pages, {dup_b} dupes")

    sig_to_slot_a, slot_counts_a = build_maps(entries_a)
    sig_to_slot_b, slot_counts_b = build_maps(entries_b)

    set_a = set(sig_to_slot_a.keys())
    set_b = set(sig_to_slot_b.keys())

    missing_in_b = sorted(set_a - set_b)
    missing_in_a = sorted(set_b - set_a)

    print("\nSignature comparison")
    print(f"  A unique: {len(set_a)}")
    print(f"  B unique: {len(set_b)}")
    print(f"  missing in B: {len(missing_in_b)}")
    print(f"  missing in A: {len(missing_in_a)}")

    if missing_in_b:
        print(f"\nMissing signatures in B (showing {min(len(missing_in_b), args.max_missing_output)})")
        for sig in missing_in_b[: args.max_missing_output]:
            slot = sig_to_slot_a.get(sig)
            print(f"  {sig} (slot {slot})")
        if len(missing_in_b) > args.max_missing_output:
            print(f"  ... {len(missing_in_b) - args.max_missing_output} more missing signatures")

    slots_missing_entirely = [
        slot for slot, count_a in slot_counts_a.items() if slot_counts_b.get(slot, 0) == 0
    ]
    slots_partial_missing = [
        slot
        for slot, count_a in slot_counts_a.items()
        if 0 < slot_counts_b.get(slot, 0) < count_a
    ]

    print("\nSlot coverage (A vs B)")
    print(f"  slots in A: {len(slot_counts_a)}")
    print(f"  slots in B: {len(slot_counts_b)}")
    print(f"  slots missing entirely in B: {len(slots_missing_entirely)}")
    print(f"  slots with fewer signatures in B: {len(slots_partial_missing)}")

    print("")
    print_ranges("Missing slots in B", slot_ranges(slots_missing_entirely), args.max_range_output)
    print("")
    print_ranges(
        "Partially missing slots in B",
        slot_ranges(slots_partial_missing),
        args.max_range_output,
    )

    missing_in_b_slots = [sig_to_slot_a.get(sig) for sig in missing_in_b]
    missing_in_b_slots = [slot for slot in missing_in_b_slots if slot is not None]
    if missing_in_b_slots:
        min_missing = min(missing_in_b_slots)
        max_missing = max(missing_in_b_slots)
        print(f"\nAll missing slots span (from missing signatures in B): {min_missing}..{max_missing}")
    else:
        print("\nAll missing slots span (from missing signatures in B): none")

    if missing_in_b or missing_in_a or slots_missing_entirely or slots_partial_missing:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
