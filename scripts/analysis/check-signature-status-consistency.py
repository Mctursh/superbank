#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
#
# Copyright 2025-2026 Triton One Limited. All rights reserved.
#

"""
Probe recent signatures and check whether getSignatureStatuses returns Solana-consistent
confirmation fields.

The script samples signatures from recent blocks, polls getSignatureStatuses for those
signatures, and reports:
  - exact_bug_count: confirmations is null while confirmationStatus is processed/confirmed
  - inferred_mismatch_count: confirmationStatus disagrees with the status implied by confirmations
  - invalid_transition_count: observed status timelines move backward or regress unexpectedly
  - finalized_signatures_count: sampled signatures that reached finalized during the probe

This is useful when you cannot submit your own transaction and want to sanity-check an RPC
endpoint against live traffic.

Example:
  python3 scripts/analysis/check-signature-status-consistency.py \
    --rpc-url http://localhost:8899 \
    --sample-size 100 \
    --poll-rounds 3 \
    --poll-interval-ms 250
"""

from __future__ import annotations

import argparse
import json
import os
import random
import socket
import sys
import time
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional, Sequence, Tuple


def _env(name: str, default: Optional[str] = None) -> Optional[str]:
    value = os.getenv(name)
    if value is None or value == "":
        return default
    return value


def rpc_request(
    url: str,
    method: str,
    params: Sequence[object],
    *,
    request_id: int,
    timeout_s: float,
    retries: int,
    backoff_s: float,
) -> Dict[str, Any]:
    payload = json.dumps(
        {"jsonrpc": "2.0", "id": request_id, "method": method, "params": list(params)}
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
            if not isinstance(body, dict):
                raise RuntimeError(f"Unexpected RPC response shape: {type(body)}")
            return body
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


def rpc_call(
    url: str,
    method: str,
    params: Sequence[object],
    *,
    request_id: int,
    timeout_s: float,
    retries: int,
    backoff_s: float,
) -> object:
    body = rpc_request(
        url,
        method,
        params,
        request_id=request_id,
        timeout_s=timeout_s,
        retries=retries,
        backoff_s=backoff_s,
    )
    return body.get("result")


def fetch_latest_slot(
    rpc_url: str,
    commitment: str,
    *,
    timeout_s: float,
    retries: int,
    backoff_s: float,
) -> int:
    result = rpc_call(
        rpc_url,
        "getSlot",
        [{"commitment": commitment}],
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


def fetch_block_signatures(
    rpc_url: str,
    slot: int,
    *,
    commitment: str,
    timeout_s: float,
    retries: int,
    backoff_s: float,
    request_id: int,
) -> List[str]:
    result = rpc_call(
        rpc_url,
        "getBlock",
        [
            slot,
            {
                "commitment": commitment,
                "transactionDetails": "signatures",
                "rewards": False,
                "maxSupportedTransactionVersion": 0,
            },
        ],
        request_id=request_id,
        timeout_s=timeout_s,
        retries=retries,
        backoff_s=backoff_s,
    )

    if result is None:
        return []
    if not isinstance(result, dict):
        raise RuntimeError(f"Unexpected getBlock result for slot {slot}: {result!r}")

    signatures = result.get("signatures")
    if signatures is None:
        return []
    if not isinstance(signatures, list):
        raise RuntimeError(f"Unexpected signatures field for slot {slot}: {signatures!r}")

    out: List[str] = []
    for value in signatures:
        if isinstance(value, str) and value:
            out.append(value)
    return out


def collect_recent_signatures(
    rpc_url: str,
    *,
    block_commitment: str,
    max_slots_back: int,
    sample_size: int,
    timeout_s: float,
    retries: int,
    backoff_s: float,
    slot_sleep_ms: int,
) -> Tuple[int, List[str], int]:
    latest_slot = fetch_latest_slot(
        rpc_url,
        block_commitment,
        timeout_s=timeout_s,
        retries=retries,
        backoff_s=backoff_s,
    )

    collected: List[str] = []
    seen = set()
    scanned_slots = 0

    for offset in range(max_slots_back + 1):
        slot = latest_slot - offset
        try:
            block_signatures = fetch_block_signatures(
                rpc_url,
                slot,
                commitment=block_commitment,
                timeout_s=timeout_s,
                retries=retries,
                backoff_s=backoff_s,
                request_id=10_000 + offset,
            )
        except RuntimeError:
            continue

        scanned_slots += 1
        for signature in block_signatures:
            if signature in seen:
                continue
            seen.add(signature)
            collected.append(signature)

        if len(collected) >= sample_size:
            break

        if slot_sleep_ms > 0:
            time.sleep(slot_sleep_ms / 1000.0)

    if len(collected) > sample_size:
        random.shuffle(collected)
        collected = collected[:sample_size]

    return latest_slot, collected, scanned_slots


def chunked(values: Sequence[str], size: int) -> List[List[str]]:
    return [list(values[i : i + size]) for i in range(0, len(values), size)]


def inferred_status(confirmations: object) -> str:
    if confirmations is None:
        return "finalized"
    try:
        count = int(confirmations)
    except (TypeError, ValueError):
        return "unknown"
    return "confirmed" if count > 0 else "processed"


def analyze_status_entry(signature: str, entry: Dict[str, Any]) -> Dict[str, Any]:
    confirmation_status = entry.get("confirmationStatus")
    confirmations = entry.get("confirmations")
    inferred = inferred_status(confirmations)

    exact_bug = confirmations is None and confirmation_status in ("processed", "confirmed")
    inferred_mismatch = (
        isinstance(confirmation_status, str)
        and confirmation_status in ("processed", "confirmed", "finalized")
        and confirmation_status != inferred
    )

    return {
        "signature": signature,
        "slot": entry.get("slot"),
        "confirmations": confirmations,
        "confirmationStatus": confirmation_status,
        "inferredStatus": inferred,
        "exactBug": exact_bug,
        "inferredMismatch": inferred_mismatch,
    }


def summarize_timeline(signature: str, timeline: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    finalized_age_slots: Optional[int] = None
    confirmed_ages: List[int] = []
    statuses: List[object] = []

    for item in timeline:
        statuses.append(item.get("confirmationStatus"))
        age_slots = item.get("ageSlots")
        if item.get("confirmationStatus") == "confirmed" and isinstance(age_slots, int):
            confirmed_ages.append(age_slots)
        if item.get("confirmationStatus") == "finalized" and isinstance(age_slots, int):
            finalized_age_slots = age_slots if finalized_age_slots is None else min(finalized_age_slots, age_slots)

    summary: Dict[str, Any] = {
        "signature": signature,
        "observations": len(timeline),
        "statusesSeen": statuses,
        "finalizedObserved": finalized_age_slots is not None,
        "finalizedAgeSlots": finalized_age_slots,
    }
    if confirmed_ages:
        summary["confirmedAgeMin"] = min(confirmed_ages)
        summary["confirmedAgeMax"] = max(confirmed_ages)
    return summary


def state_rank(status: object) -> int:
    if status == "processed":
        return 0
    if status == "confirmed":
        return 1
    if status == "finalized":
        return 2
    return -1


def detect_invalid_timeline_transition(
    previous: Optional[Dict[str, Any]], current: Dict[str, Any]
) -> Optional[str]:
    if previous is None:
        return None

    previous_status = previous.get("confirmationStatus")
    current_status = current.get("confirmationStatus")
    previous_rank = state_rank(previous_status)
    current_rank = state_rank(current_status)

    if previous_rank >= 0 and current_rank >= 0 and current_rank < previous_rank:
        return f"status regressed from {previous_status} to {current_status}"

    previous_confirmations = previous.get("confirmations")
    current_confirmations = current.get("confirmations")

    if previous_status == "finalized" and current_status != "finalized":
        return f"status regressed from finalized to {current_status}"

    if previous_confirmations is None and current_confirmations is not None:
        return "confirmations regressed from null to non-null"

    try:
        if previous_confirmations is not None and current_confirmations is not None:
            prev_count = int(previous_confirmations)
            curr_count = int(current_confirmations)
            if curr_count < prev_count:
                return f"confirmations regressed from {prev_count} to {curr_count}"
    except (TypeError, ValueError):
        return None

    return None


def poll_signature_statuses(
    rpc_url: str,
    signatures: Sequence[str],
    *,
    timeout_s: float,
    retries: int,
    backoff_s: float,
    poll_rounds: int,
    poll_interval_ms: int,
    persist_until_finalized: bool,
) -> Tuple[int, int, int, int, int, List[Dict[str, Any]], Dict[str, List[Dict[str, Any]]]]:
    exact_bug_count = 0
    inferred_mismatch_count = 0
    invalid_transition_count = 0
    finalized_signatures_count = 0
    samples_checked = 0
    examples: List[Dict[str, Any]] = []
    timelines: Dict[str, List[Dict[str, Any]]] = {signature: [] for signature in signatures}
    finalized_seen = set()

    for round_idx in range(poll_rounds):
        for batch_idx, batch in enumerate(chunked(list(signatures), 256)):
            response = rpc_request(
                rpc_url,
                "getSignatureStatuses",
                [batch],
                request_id=20_000 + round_idx * 1000 + batch_idx,
                timeout_s=timeout_s,
                retries=retries,
                backoff_s=backoff_s,
            )
            result = response.get("result")
            if not isinstance(result, dict):
                raise RuntimeError(f"Unexpected getSignatureStatuses result: {result!r}")

            context = result.get("context")
            context_slot = None
            if isinstance(context, dict):
                raw_context_slot = context.get("slot")
                if isinstance(raw_context_slot, (int, float, str)):
                    context_slot = int(raw_context_slot)

            values = result.get("value")
            if not isinstance(values, list):
                raise RuntimeError(f"Unexpected getSignatureStatuses value: {values!r}")

            for signature, entry in zip(batch, values):
                if not isinstance(entry, dict):
                    continue
                samples_checked += 1
                analyzed = analyze_status_entry(signature, entry)
                analyzed["round"] = round_idx + 1
                analyzed["contextSlot"] = context_slot
                slot_value = analyzed.get("slot")
                if isinstance(context_slot, int) and isinstance(slot_value, int):
                    analyzed["ageSlots"] = max(0, context_slot - slot_value)
                previous = timelines[signature][-1] if timelines[signature] else None
                transition_error = detect_invalid_timeline_transition(previous, analyzed)
                if transition_error is not None:
                    analyzed["invalidTransition"] = transition_error
                    invalid_transition_count += 1
                if analyzed["exactBug"]:
                    exact_bug_count += 1
                if analyzed["inferredMismatch"]:
                    inferred_mismatch_count += 1
                timelines[signature].append(analyzed)
                if analyzed.get("confirmationStatus") == "finalized" and signature not in finalized_seen:
                    finalized_seen.add(signature)
                    finalized_signatures_count += 1
                if (
                    analyzed["exactBug"]
                    or analyzed["inferredMismatch"]
                    or "invalidTransition" in analyzed
                ) and len(examples) < 10:
                    examples.append(analyzed)

        if persist_until_finalized and len(finalized_seen) == len(signatures):
            break

        if round_idx + 1 < poll_rounds and poll_interval_ms > 0:
            time.sleep(poll_interval_ms / 1000.0)

    return (
        samples_checked,
        exact_bug_count,
        inferred_mismatch_count,
        invalid_transition_count,
        finalized_signatures_count,
        examples,
        timelines,
    )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Check getSignatureStatuses confirmation-field consistency on a live RPC."
    )
    parser.add_argument(
        "--rpc-url",
        default=_env("RPC_URL", "https://api.mainnet-beta.solana.com"),
        help="RPC endpoint to probe (env: RPC_URL)",
    )
    parser.add_argument(
        "--block-commitment",
        default=_env("BLOCK_COMMITMENT", "processed"),
        help="Commitment to use when sampling blocks (env: BLOCK_COMMITMENT)",
    )
    parser.add_argument(
        "--sample-size",
        type=int,
        default=int(_env("SAMPLE_SIZE", "100")),
        help="Maximum number of unique signatures to sample (env: SAMPLE_SIZE)",
    )
    parser.add_argument(
        "--max-slots-back",
        type=int,
        default=int(_env("MAX_SLOTS_BACK", "32")),
        help="How far back from the latest slot to search for signatures (env: MAX_SLOTS_BACK)",
    )
    parser.add_argument(
        "--poll-rounds",
        type=int,
        default=int(_env("POLL_ROUNDS", "3")),
        help="How many times to poll getSignatureStatuses for the sample (env: POLL_ROUNDS)",
    )
    parser.add_argument(
        "--poll-interval-ms",
        type=int,
        default=int(_env("POLL_INTERVAL_MS", "250")),
        help="Sleep between polling rounds in ms (env: POLL_INTERVAL_MS)",
    )
    parser.add_argument(
        "--slot-sleep-ms",
        type=int,
        default=int(_env("SLOT_SLEEP_MS", "0")),
        help="Sleep between getBlock requests in ms (env: SLOT_SLEEP_MS)",
    )
    parser.add_argument(
        "--timeout-s",
        type=float,
        default=float(_env("TIMEOUT_S", "10")),
        help="Per-request timeout in seconds (env: TIMEOUT_S)",
    )
    parser.add_argument(
        "--retries",
        type=int,
        default=int(_env("RETRIES", "1")),
        help="RPC retries per request (env: RETRIES)",
    )
    parser.add_argument(
        "--backoff-s",
        type=float,
        default=float(_env("BACKOFF_S", "0.25")),
        help="Linear retry backoff in seconds (env: BACKOFF_S)",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=int(_env("SEED", "0")),
        help="Random seed for sampling order (env: SEED)",
    )
    parser.add_argument(
        "--show-timelines",
        action="store_true",
        help="Print per-signature observed state timelines",
    )
    parser.add_argument(
        "--max-timelines",
        type=int,
        default=int(_env("MAX_TIMELINES", "10")),
        help="Maximum timelines to print when --show-timelines is set (env: MAX_TIMELINES)",
    )
    parser.add_argument(
        "--persist-until-finalized",
        action="store_true",
        help="Keep polling the same sampled signatures until they finalize or poll-rounds is exhausted",
    )
    args = parser.parse_args()

    if args.sample_size <= 0:
        raise SystemExit("--sample-size must be > 0")
    if args.max_slots_back < 0:
        raise SystemExit("--max-slots-back must be >= 0")
    if args.poll_rounds <= 0:
        raise SystemExit("--poll-rounds must be > 0")
    if args.poll_interval_ms < 0:
        raise SystemExit("--poll-interval-ms must be >= 0")
    if args.slot_sleep_ms < 0:
        raise SystemExit("--slot-sleep-ms must be >= 0")
    if args.timeout_s <= 0:
        raise SystemExit("--timeout-s must be > 0")
    if args.retries < 0:
        raise SystemExit("--retries must be >= 0")
    if args.backoff_s < 0:
        raise SystemExit("--backoff-s must be >= 0")
    if args.max_timelines < 0:
        raise SystemExit("--max-timelines must be >= 0")

    random.seed(args.seed)

    latest_slot, signatures, scanned_slots = collect_recent_signatures(
        args.rpc_url,
        block_commitment=args.block_commitment,
        max_slots_back=args.max_slots_back,
        sample_size=args.sample_size,
        timeout_s=args.timeout_s,
        retries=args.retries,
        backoff_s=args.backoff_s,
        slot_sleep_ms=args.slot_sleep_ms,
    )

    if not signatures:
        print("No signatures collected from recent blocks.", file=sys.stderr)
        return 2

    (
        samples_checked,
        exact_bug_count,
        inferred_mismatch_count,
        invalid_transition_count,
        finalized_signatures_count,
        examples,
        timelines,
    ) = poll_signature_statuses(
        args.rpc_url,
        signatures,
        timeout_s=args.timeout_s,
        retries=args.retries,
        backoff_s=args.backoff_s,
        poll_rounds=args.poll_rounds,
        poll_interval_ms=args.poll_interval_ms,
        persist_until_finalized=args.persist_until_finalized,
    )

    print(f"rpc_url={args.rpc_url}")
    print(f"latest_slot={latest_slot}")
    print(f"block_commitment={args.block_commitment}")
    print(f"scanned_slots={scanned_slots}")
    print(f"sampled_signatures={len(signatures)}")
    print(f"poll_rounds={args.poll_rounds}")
    print(f"samples_checked={samples_checked}")
    print(f"exact_bug_count={exact_bug_count}")
    print(f"inferred_mismatch_count={inferred_mismatch_count}")
    print(f"invalid_transition_count={invalid_transition_count}")
    print(f"finalized_signatures_count={finalized_signatures_count}")
    print(f"still_unfinalized_count={len(signatures) - finalized_signatures_count}")

    if examples:
        print("examples:")
        for example in examples:
            print(json.dumps(example, sort_keys=True))

    summaries = [summarize_timeline(signature, timeline) for signature, timeline in timelines.items() if timeline]
    finalized_summaries = [summary for summary in summaries if summary.get("finalizedObserved")]
    if finalized_summaries:
        finalized_ages = [
            summary["finalizedAgeSlots"]
            for summary in finalized_summaries
            if isinstance(summary.get("finalizedAgeSlots"), int)
        ]
        if finalized_ages:
            print(f"finalized_age_min={min(finalized_ages)}")
            print(f"finalized_age_max={max(finalized_ages)}")

    if args.show_timelines:
        print("timelines:")
        printed = 0
        for signature, timeline in timelines.items():
            if printed >= args.max_timelines:
                break
            if not timeline:
                continue
            printed += 1
            print(json.dumps({"signature": signature, "timeline": timeline}, sort_keys=True))

        print("timeline_summaries:")
        printed = 0
        for summary in summaries:
            if printed >= args.max_timelines:
                break
            printed += 1
            print(json.dumps(summary, sort_keys=True))

    return (
        1
        if exact_bug_count > 0
        or inferred_mismatch_count > 0
        or invalid_transition_count > 0
        else 0
    )


if __name__ == "__main__":
    raise SystemExit(main())
