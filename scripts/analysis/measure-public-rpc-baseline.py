#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
#
# Copyright 2025-2026 Triton One Limited. All rights reserved.
#

"""Measure valid-only latency baselines for Superbank's official Solana RPC overlap.

This script is intentionally conservative for public RPC endpoints:
- one request at a time
- configurable delay and jitter between requests
- extra backoff when the endpoint rate-limits
- latency percentiles computed from successful, shape-valid responses only

It uses the sample address/signature/slot pools already checked into this repo.
Superbank's custom `getTransactionsForAddress` method is excluded because it is not
available on the public Solana RPC endpoint.
"""

from __future__ import annotations

import argparse
import http.client
import json
import math
import random
import sys
import time
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlsplit


REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_ADDRESS_FILE = REPO_ROOT / "tests/k6/data/pools/addresses.txt"
DEFAULT_SIGNATURE_FILE = REPO_ROOT / "tests/k6/data/pools/signatures.txt"
DEFAULT_SLOT_FILE = REPO_ROOT / "tests/k6/data/pools/slots.txt"

OFFICIAL_METHODS = [
    "getSignaturesForAddress",
    "getSignatureStatuses",
    "getTransaction",
    "getBlock",
    "getBlockHeight",
    "getSlot",
    "getTransactionCount",
    "getLatestBlockhash",
    "getBlockTime",
    "getBlocks",
    "getBlocksWithLimit",
    "getFirstAvailableBlock",
    "getInflationReward",
]

RATE_LIMIT_KEYWORDS = (
    "rate limit",
    "too many requests",
    "too many",
    "exceeded limit",
    "try again later",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Measure p50/p90/p99 for the official Solana RPC methods that Superbank "
            "supports, excluding 429s and other failures from latency percentiles."
        )
    )
    parser.add_argument(
        "--rpc-url",
        default="https://api.mainnet-beta.solana.com",
        help="Public Solana JSON-RPC URL to measure.",
    )
    parser.add_argument(
        "--methods",
        nargs="*",
        default=OFFICIAL_METHODS,
        help=(
            "Subset of methods to measure. Defaults to all official methods Superbank supports. "
            f"Choices: {', '.join(OFFICIAL_METHODS)}"
        ),
    )
    parser.add_argument(
        "--valid-samples-per-method",
        type=int,
        default=25,
        help="Number of successful samples to collect per method before stopping.",
    )
    parser.add_argument(
        "--max-attempt-multiplier",
        type=int,
        default=10,
        help=(
            "Safety cap. Each method may use at most valid_samples_per_method * this many "
            "attempts before the run is marked incomplete."
        ),
    )
    parser.add_argument(
        "--request-interval-ms",
        type=int,
        default=1200,
        help="Delay after every request attempt.",
    )
    parser.add_argument(
        "--request-jitter-ms",
        type=int,
        default=200,
        help="Additional random delay in [0, request_jitter_ms] after every request attempt.",
    )
    parser.add_argument(
        "--rate-limit-backoff-ms",
        type=int,
        default=5000,
        help="Extra delay after HTTP 429 or obvious rate-limit responses.",
    )
    parser.add_argument(
        "--timeout-ms",
        type=int,
        default=20000,
        help="Per-request timeout.",
    )
    parser.add_argument(
        "--address-file",
        default=str(DEFAULT_ADDRESS_FILE),
        help="Address pool file.",
    )
    parser.add_argument(
        "--signature-file",
        default=str(DEFAULT_SIGNATURE_FILE),
        help="Signature pool file.",
    )
    parser.add_argument(
        "--slot-file",
        default=str(DEFAULT_SLOT_FILE),
        help="Slot pool file.",
    )
    parser.add_argument(
        "--commitment",
        default="finalized",
        choices=["confirmed", "finalized"],
        help="Commitment used for methods with an explicit commitment option.",
    )
    parser.add_argument(
        "--signatures-limit",
        type=int,
        default=25,
        help="Limit for getSignaturesForAddress.",
    )
    parser.add_argument(
        "--signature-statuses-batch",
        type=int,
        default=10,
        help="Batch size for getSignatureStatuses.",
    )
    parser.add_argument(
        "--signature-statuses-search-history",
        action="store_true",
        default=True,
        help="Enable searchTransactionHistory for getSignatureStatuses (default: on).",
    )
    parser.add_argument(
        "--no-signature-statuses-search-history",
        dest="signature_statuses_search_history",
        action="store_false",
        help="Disable searchTransactionHistory for getSignatureStatuses.",
    )
    parser.add_argument(
        "--tx-encoding",
        default="json",
        choices=["json", "jsonParsed", "base64", "base58"],
        help="Encoding for getTransaction.",
    )
    parser.add_argument(
        "--block-encoding",
        default="json",
        choices=["json", "jsonParsed", "base64", "base58"],
        help="Encoding for getBlock.",
    )
    parser.add_argument(
        "--block-transaction-details",
        default="signatures",
        choices=["full", "accounts", "signatures", "none"],
        help="transactionDetails for getBlock.",
    )
    parser.add_argument(
        "--block-rewards",
        action="store_true",
        help="Request rewards for getBlock (default: disabled).",
    )
    parser.add_argument(
        "--max-supported-tx-version",
        type=int,
        default=0,
        help="maxSupportedTransactionVersion for getTransaction/getBlock.",
    )
    parser.add_argument(
        "--blocks-range",
        type=int,
        default=25,
        help="Range width for getBlocks (end = start + range).",
    )
    parser.add_argument(
        "--blocks-with-limit",
        type=int,
        default=25,
        help="Limit for getBlocksWithLimit.",
    )
    parser.add_argument(
        "--inflation-reward-epoch",
        type=int,
        default=None,
        help="Epoch for getInflationReward. Defaults to previous epoch based on getSlot.",
    )
    parser.add_argument(
        "--inflation-reward-address-count",
        type=int,
        default=1,
        help="Number of addresses per getInflationReward request.",
    )
    parser.add_argument(
        "--slots-per-epoch",
        type=int,
        default=432000,
        help="Used only when auto-resolving the previous epoch for getInflationReward.",
    )
    parser.add_argument(
        "--json-output",
        default=None,
        help="Optional file path for the full JSON summary.",
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="Suppress periodic progress logs.",
    )
    args = parser.parse_args()

    if args.valid_samples_per_method <= 0:
        parser.error("--valid-samples-per-method must be > 0")
    if args.max_attempt_multiplier <= 0:
        parser.error("--max-attempt-multiplier must be > 0")
    if args.request_interval_ms < 0:
        parser.error("--request-interval-ms must be >= 0")
    if args.request_jitter_ms < 0:
        parser.error("--request-jitter-ms must be >= 0")
    if args.rate_limit_backoff_ms < 0:
        parser.error("--rate-limit-backoff-ms must be >= 0")
    if args.timeout_ms <= 0:
        parser.error("--timeout-ms must be > 0")
    if args.signatures_limit <= 0:
        parser.error("--signatures-limit must be > 0")
    if args.signature_statuses_batch <= 0:
        parser.error("--signature-statuses-batch must be > 0")
    if args.blocks_range < 0:
        parser.error("--blocks-range must be >= 0")
    if args.blocks_with_limit <= 0:
        parser.error("--blocks-with-limit must be > 0")
    if args.inflation_reward_address_count <= 0:
        parser.error("--inflation-reward-address-count must be > 0")
    if args.slots_per_epoch <= 0:
        parser.error("--slots-per-epoch must be > 0")

    invalid_methods = [method for method in args.methods if method not in OFFICIAL_METHODS]
    if invalid_methods:
        parser.error(f"Unsupported method(s): {', '.join(invalid_methods)}")

    return args


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def load_tokens(path: str) -> list[str]:
    tokens = Path(path).read_text(encoding="utf-8").split()
    if not tokens:
        raise ValueError(f"{path} contained no tokens")
    return tokens


def load_slots(path: str) -> list[int]:
    slots = [int(token) for token in load_tokens(path)]
    if any(slot < 0 for slot in slots):
        raise ValueError(f"{path} contained a negative slot")
    return slots


def percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    index = (len(ordered) - 1) * fraction
    lower = math.floor(index)
    upper = math.ceil(index)
    if lower == upper:
        return ordered[lower]
    weight = index - lower
    return ordered[lower] + (ordered[upper] - ordered[lower]) * weight


def format_ms(value: float) -> str:
    return f"{value:.1f}"


def detect_rate_limit(status: int | None, message: str | None) -> bool:
    if status == 429:
        return True
    if not message:
        return False
    lowered = message.lower()
    return any(keyword in lowered for keyword in RATE_LIMIT_KEYWORDS)


class PoolCursor:
    def __init__(self, values: list[Any], label: str) -> None:
        if not values:
            raise ValueError(f"{label} pool was empty")
        self.values = values
        self.label = label
        self.index = 0

    def next(self) -> Any:
        value = self.values[self.index % len(self.values)]
        self.index += 1
        return value

    def next_batch(self, count: int) -> list[Any]:
        return [self.next() for _ in range(count)]


class RpcClient:
    def __init__(self, rpc_url: str, timeout_seconds: float) -> None:
        parsed = urlsplit(rpc_url)
        if parsed.scheme not in {"http", "https"}:
            raise ValueError(f"Unsupported RPC URL scheme: {parsed.scheme}")
        self.rpc_url = rpc_url
        self.scheme = parsed.scheme
        self.host = parsed.hostname
        if not self.host:
            raise ValueError(f"Could not parse host from RPC URL: {rpc_url}")
        self.port = parsed.port
        self.path = parsed.path or "/"
        if parsed.query:
            self.path = f"{self.path}?{parsed.query}"
        self.timeout_seconds = timeout_seconds
        self.connection: http.client.HTTPConnection | None = None

    def close(self) -> None:
        if self.connection is not None:
            try:
                self.connection.close()
            finally:
                self.connection = None

    def _connect(self) -> http.client.HTTPConnection:
        connection_cls = (
            http.client.HTTPSConnection
            if self.scheme == "https"
            else http.client.HTTPConnection
        )
        connection = connection_cls(
            host=self.host,
            port=self.port,
            timeout=self.timeout_seconds,
        )
        return connection

    def request(self, payload: bytes) -> tuple[int, bytes]:
        if self.connection is None:
            self.connection = self._connect()

        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "superbank-public-rpc-baseline/1.0",
        }

        try:
            self.connection.request("POST", self.path, body=payload, headers=headers)
            response = self.connection.getresponse()
            body = response.read()
            status = response.status
            return status, body
        except Exception:
            self.close()
            raise


@dataclass
class AttemptResult:
    kind: str
    elapsed_ms: float | None = None
    status: int | None = None
    jsonrpc_code: int | str | None = None
    error_message: str | None = None
    input_summary: str | None = None


@dataclass
class MethodSpec:
    name: str
    build_params: Callable[[], tuple[list[Any], str]]
    validator: Callable[[Any], bool]


@dataclass
class MethodState:
    name: str
    valid_latencies_ms: list[float] = field(default_factory=list)
    attempts: int = 0
    rate_limited: int = 0
    http_errors: int = 0
    jsonrpc_errors: int = 0
    invalid_results: int = 0
    network_errors: int = 0
    http_status_counts: Counter[str] = field(default_factory=Counter)
    jsonrpc_code_counts: Counter[str] = field(default_factory=Counter)
    last_error: str | None = None
    last_input: str | None = None

    @property
    def valid_count(self) -> int:
        return len(self.valid_latencies_ms)


def make_payload(method: str, params: list[Any], request_id: int) -> bytes:
    return json.dumps(
        {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": params,
        },
        separators=(",", ":"),
    ).encode("utf-8")


def is_non_negative_int(value: Any) -> bool:
    return isinstance(value, int) and value >= 0


def build_method_specs(
    args: argparse.Namespace,
    addresses: list[str],
    signatures: list[str],
    slots: list[int],
    inflation_reward_epoch: int | None,
    inflation_reward_addresses: list[str],
) -> list[MethodSpec]:
    address_cursor = PoolCursor(addresses, "address")
    signature_cursor = PoolCursor(signatures, "signature")
    slot_cursor = PoolCursor(slots, "slot")
    inflation_address_cursor = (
        PoolCursor(inflation_reward_addresses, "inflation-reward-address")
        if inflation_reward_addresses
        else None
    )

    specs: dict[str, MethodSpec] = {
        "getSignaturesForAddress": MethodSpec(
            name="getSignaturesForAddress",
            build_params=lambda: (
                [
                    (address := address_cursor.next()),
                    {
                        "limit": args.signatures_limit,
                        "commitment": args.commitment,
                    },
                ],
                f"address={address}",
            ),
            validator=lambda result: isinstance(result, list) and len(result) > 0,
        ),
        "getSignatureStatuses": MethodSpec(
            name="getSignatureStatuses",
            build_params=lambda: (
                [
                    (batch := signature_cursor.next_batch(args.signature_statuses_batch)),
                    {
                        "searchTransactionHistory": args.signature_statuses_search_history,
                    },
                ],
                f"batchSize={len(batch)} firstSignature={batch[0]}",
            ),
            validator=lambda result: (
                isinstance(result, dict)
                and isinstance(result.get("value"), list)
                and len(result["value"]) == args.signature_statuses_batch
                and any(entry is not None for entry in result["value"])
            ),
        ),
        "getTransaction": MethodSpec(
            name="getTransaction",
            build_params=lambda: (
                [
                    (signature := signature_cursor.next()),
                    {
                        "encoding": args.tx_encoding,
                        "commitment": args.commitment,
                        "maxSupportedTransactionVersion": args.max_supported_tx_version,
                    },
                ],
                f"signature={signature}",
            ),
            validator=lambda result: (
                isinstance(result, dict)
                and isinstance(result.get("transaction"), dict)
                and isinstance(result.get("meta"), dict)
            ),
        ),
        "getBlock": MethodSpec(
            name="getBlock",
            build_params=lambda: (
                [
                    (slot := slot_cursor.next()),
                    {
                        "encoding": args.block_encoding,
                        "transactionDetails": args.block_transaction_details,
                        "rewards": args.block_rewards,
                        "commitment": args.commitment,
                        "maxSupportedTransactionVersion": args.max_supported_tx_version,
                    },
                ],
                f"slot={slot}",
            ),
            validator=lambda result: (
                isinstance(result, dict)
                and isinstance(result.get("blockhash"), str)
                and (
                    ("transactions" in result and isinstance(result.get("transactions"), list))
                    or ("signatures" in result and isinstance(result.get("signatures"), list))
                )
            ),
        ),
        "getBlockHeight": MethodSpec(
            name="getBlockHeight",
            build_params=lambda: (
                [{"commitment": args.commitment}],
                f"commitment={args.commitment}",
            ),
            validator=is_non_negative_int,
        ),
        "getSlot": MethodSpec(
            name="getSlot",
            build_params=lambda: (
                [{"commitment": args.commitment}],
                f"commitment={args.commitment}",
            ),
            validator=is_non_negative_int,
        ),
        "getTransactionCount": MethodSpec(
            name="getTransactionCount",
            build_params=lambda: (
                [{"commitment": args.commitment}],
                f"commitment={args.commitment}",
            ),
            validator=is_non_negative_int,
        ),
        "getLatestBlockhash": MethodSpec(
            name="getLatestBlockhash",
            build_params=lambda: (
                [{"commitment": args.commitment}],
                f"commitment={args.commitment}",
            ),
            validator=lambda result: (
                isinstance(result, dict)
                and isinstance(result.get("context"), dict)
                and isinstance(result.get("value"), dict)
                and isinstance(result["value"].get("blockhash"), str)
                and is_non_negative_int(result["value"].get("lastValidBlockHeight"))
            ),
        ),
        "getBlockTime": MethodSpec(
            name="getBlockTime",
            build_params=lambda: (
                [(slot := slot_cursor.next())],
                f"slot={slot}",
            ),
            validator=lambda result: isinstance(result, int) and result > 0,
        ),
        "getBlocks": MethodSpec(
            name="getBlocks",
            build_params=lambda: (
                [
                    (slot := slot_cursor.next()),
                    slot + args.blocks_range,
                    {"commitment": args.commitment},
                ],
                f"startSlot={slot} endSlot={slot + args.blocks_range}",
            ),
            validator=lambda result: (
                isinstance(result, list)
                and len(result) > 0
                and all(is_non_negative_int(entry) for entry in result)
            ),
        ),
        "getBlocksWithLimit": MethodSpec(
            name="getBlocksWithLimit",
            build_params=lambda: (
                [
                    (slot := slot_cursor.next()),
                    args.blocks_with_limit,
                    {"commitment": args.commitment},
                ],
                f"startSlot={slot} limit={args.blocks_with_limit}",
            ),
            validator=lambda result: (
                isinstance(result, list)
                and len(result) > 0
                and all(is_non_negative_int(entry) for entry in result)
            ),
        ),
        "getFirstAvailableBlock": MethodSpec(
            name="getFirstAvailableBlock",
            build_params=lambda: ([], "none"),
            validator=is_non_negative_int,
        ),
        "getInflationReward": MethodSpec(
            name="getInflationReward",
            build_params=lambda: (
                [
                    (
                        address_batch := inflation_address_cursor.next_batch(
                            args.inflation_reward_address_count
                        )
                    ),
                    {
                        "epoch": inflation_reward_epoch,
                        "commitment": args.commitment,
                    },
                ],
                (
                    f"epoch={inflation_reward_epoch} addressCount={len(address_batch)} "
                    f"firstAddress={address_batch[0]}"
                ),
            ),
            validator=lambda result: (
                isinstance(result, list)
                and len(result) == args.inflation_reward_address_count
                and any(isinstance(entry, dict) and "amount" in entry for entry in result)
            ),
        ),
    }

    return [specs[method] for method in args.methods]


def perform_attempt(
    client: RpcClient,
    spec: MethodSpec,
    request_id: int,
) -> AttemptResult:
    params, input_summary = spec.build_params()
    payload = make_payload(spec.name, params, request_id)

    start = time.perf_counter()
    try:
        status, raw_body = client.request(payload)
    except Exception as exc:
        elapsed_ms = (time.perf_counter() - start) * 1000.0
        return AttemptResult(
            kind="network_error",
            elapsed_ms=elapsed_ms,
            error_message=str(exc),
            input_summary=input_summary,
        )

    elapsed_ms = (time.perf_counter() - start) * 1000.0

    parsed_body: Any = None
    if raw_body:
        try:
            parsed_body = json.loads(raw_body.decode("utf-8"))
        except Exception:
            parsed_body = None

    if status != 200:
        message = None
        if isinstance(parsed_body, dict):
            error = parsed_body.get("error")
            if isinstance(error, dict):
                message = str(error.get("message") or "")
        if detect_rate_limit(status, message):
            return AttemptResult(
                kind="rate_limited",
                elapsed_ms=elapsed_ms,
                status=status,
                error_message=message,
                input_summary=input_summary,
            )
        return AttemptResult(
            kind="http_error",
            elapsed_ms=elapsed_ms,
            status=status,
            error_message=message,
            input_summary=input_summary,
        )

    if not isinstance(parsed_body, dict):
        return AttemptResult(
            kind="invalid_result",
            elapsed_ms=elapsed_ms,
            status=status,
            error_message="response was not valid JSON",
            input_summary=input_summary,
        )

    if "error" in parsed_body and parsed_body["error"] is not None:
        error = parsed_body["error"]
        code = None
        message = None
        if isinstance(error, dict):
            code = error.get("code")
            message = str(error.get("message") or "")
        if detect_rate_limit(status, message):
            return AttemptResult(
                kind="rate_limited",
                elapsed_ms=elapsed_ms,
                status=status,
                jsonrpc_code=code,
                error_message=message,
                input_summary=input_summary,
            )
        return AttemptResult(
            kind="jsonrpc_error",
            elapsed_ms=elapsed_ms,
            status=status,
            jsonrpc_code=code,
            error_message=message,
            input_summary=input_summary,
        )

    result = parsed_body.get("result")
    if not spec.validator(result):
        return AttemptResult(
            kind="invalid_result",
            elapsed_ms=elapsed_ms,
            status=status,
            error_message="response shape was valid JSON-RPC but not a usable result",
            input_summary=input_summary,
        )

    return AttemptResult(
        kind="valid",
        elapsed_ms=elapsed_ms,
        status=status,
        input_summary=input_summary,
    )


def resolve_inflation_reward_epoch(
    client: RpcClient,
    commitment: str,
    slots_per_epoch: int,
) -> int:
    payload = make_payload(
        "getSlot",
        [{"commitment": commitment}],
        request_id=1,
    )

    start = time.perf_counter()
    status, raw_body = client.request(payload)
    _ = (time.perf_counter() - start) * 1000.0

    if status != 200:
        raise RuntimeError(f"Could not resolve epoch via getSlot: HTTP {status}")

    try:
        body = json.loads(raw_body.decode("utf-8"))
    except Exception as exc:
        raise RuntimeError("Could not resolve epoch via getSlot: non-JSON response") from exc

    if not isinstance(body, dict) or body.get("error") is not None:
        raise RuntimeError(f"Could not resolve epoch via getSlot: {body}")

    slot = body.get("result")
    if not is_non_negative_int(slot):
        raise RuntimeError(f"Could not resolve epoch via getSlot: unexpected result {slot!r}")

    current_epoch = slot // slots_per_epoch
    return max(0, current_epoch - 1)


def fetch_vote_account_addresses(
    client: RpcClient,
    commitment: str,
) -> list[str]:
    payload = make_payload(
        "getVoteAccounts",
        [{"commitment": commitment}],
        request_id=2,
    )
    status, raw_body = client.request(payload)
    if status != 200:
        return []

    try:
        body = json.loads(raw_body.decode("utf-8"))
    except Exception:
        return []

    if not isinstance(body, dict) or body.get("error") is not None:
        return []

    result = body.get("result")
    if not isinstance(result, dict):
        return []

    addresses: list[str] = []
    for bucket_name in ("current", "delinquent"):
        bucket = result.get(bucket_name)
        if not isinstance(bucket, list):
            continue
        for entry in bucket:
            if not isinstance(entry, dict):
                continue
            vote_pubkey = entry.get("votePubkey")
            if isinstance(vote_pubkey, str) and vote_pubkey:
                addresses.append(vote_pubkey)
    return addresses


def prepare_inflation_reward_addresses(
    client: RpcClient,
    args: argparse.Namespace,
    addresses: list[str],
    inflation_reward_epoch: int,
) -> list[str]:
    target = args.inflation_reward_address_count
    if target <= 0:
        return []

    validator = lambda result: (
        isinstance(result, list)
        and len(result) == 1
        and isinstance(result[0], dict)
        and "amount" in result[0]
    )

    vote_accounts = fetch_vote_account_addresses(client, args.commitment)
    candidates: list[str] = []
    candidate_set: set[str] = set()

    for vote_account in vote_accounts:
        if vote_account not in candidate_set:
            candidates.append(vote_account)
            candidate_set.add(vote_account)

    for address in addresses:
        if address not in candidate_set:
            candidates.append(address)
            candidate_set.add(address)

    usable: list[str] = []
    seen: set[str] = set()
    max_attempts = min(len(candidates), max(target * 25, 100))

    for candidate in candidates:
        if candidate in seen:
            continue
        seen.add(candidate)

        attempt = perform_attempt(
            client=client,
            spec=MethodSpec(
                name="getInflationReward",
                build_params=lambda candidate=candidate: (
                    [
                        [candidate],
                        {
                            "epoch": inflation_reward_epoch,
                            "commitment": args.commitment,
                        },
                    ],
                    f"epoch={inflation_reward_epoch} address={candidate}",
                ),
                validator=validator,
            ),
            request_id=3 + len(seen),
        )

        if attempt.kind == "valid":
            usable.append(candidate)
            if len(usable) >= target:
                return usable

        sleep_with_jitter(args.request_interval_ms, args.request_jitter_ms)
        if attempt.kind == "rate_limited":
            time.sleep(args.rate_limit_backoff_ms / 1000.0)

        if len(seen) >= max_attempts:
            break

    raise RuntimeError(
        "Could not find enough reward-bearing addresses for getInflationReward. "
        "Provide --inflation-reward-epoch or a better --address-file."
    )


def record_attempt(state: MethodState, attempt: AttemptResult) -> None:
    state.attempts += 1
    state.last_input = attempt.input_summary

    if attempt.status is not None:
        state.http_status_counts[str(attempt.status)] += 1

    if attempt.kind == "valid":
        state.valid_latencies_ms.append(attempt.elapsed_ms or 0.0)
        return

    if attempt.kind == "rate_limited":
        state.rate_limited += 1
    elif attempt.kind == "http_error":
        state.http_errors += 1
    elif attempt.kind == "jsonrpc_error":
        state.jsonrpc_errors += 1
    elif attempt.kind == "invalid_result":
        state.invalid_results += 1
    elif attempt.kind == "network_error":
        state.network_errors += 1

    if attempt.jsonrpc_code is not None:
        state.jsonrpc_code_counts[str(attempt.jsonrpc_code)] += 1

    if attempt.error_message:
        state.last_error = attempt.error_message


def sleep_with_jitter(base_ms: int, jitter_ms: int) -> None:
    delay_ms = base_ms
    if jitter_ms > 0:
        delay_ms += random.randint(0, jitter_ms)
    if delay_ms > 0:
        time.sleep(delay_ms / 1000.0)


def all_targets_met(states: dict[str, MethodState], target: int) -> bool:
    return all(state.valid_count >= target for state in states.values())


def any_attempt_cap_exceeded(
    states: dict[str, MethodState], max_attempts_per_method: int, target: int
) -> bool:
    return any(
        state.valid_count < target and state.attempts >= max_attempts_per_method
        for state in states.values()
    )


def build_summary(
    args: argparse.Namespace,
    states: dict[str, MethodState],
    inflation_reward_epoch: int,
    started_at: str,
    finished_at: str,
    duration_seconds: float,
) -> dict[str, Any]:
    methods: dict[str, Any] = {}
    complete = True

    for method in args.methods:
        state = states[method]
        latencies = state.valid_latencies_ms
        method_complete = state.valid_count >= args.valid_samples_per_method
        complete = complete and method_complete

        methods[method] = {
            "complete": method_complete,
            "attempts": state.attempts,
            "valid_samples": state.valid_count,
            "latency_ms": {
                "min": min(latencies) if latencies else 0.0,
                "avg": (sum(latencies) / len(latencies)) if latencies else 0.0,
                "p50": percentile(latencies, 0.50),
                "p90": percentile(latencies, 0.90),
                "p99": percentile(latencies, 0.99),
                "max": max(latencies) if latencies else 0.0,
            },
            "excluded_attempts": {
                "rate_limited": state.rate_limited,
                "http_errors": state.http_errors,
                "jsonrpc_errors": state.jsonrpc_errors,
                "invalid_results": state.invalid_results,
                "network_errors": state.network_errors,
            },
            "http_status_counts": dict(state.http_status_counts),
            "jsonrpc_code_counts": dict(state.jsonrpc_code_counts),
            "last_input": state.last_input,
            "last_error": state.last_error,
        }

    return {
        "complete": complete,
        "timestamp": finished_at,
        "started_at": started_at,
        "finished_at": finished_at,
        "duration_seconds": duration_seconds,
        "rpc_url": args.rpc_url,
        "config": {
            "methods": args.methods,
            "valid_samples_per_method": args.valid_samples_per_method,
            "max_attempt_multiplier": args.max_attempt_multiplier,
            "request_interval_ms": args.request_interval_ms,
            "request_jitter_ms": args.request_jitter_ms,
            "rate_limit_backoff_ms": args.rate_limit_backoff_ms,
            "timeout_ms": args.timeout_ms,
            "commitment": args.commitment,
            "signatures_limit": args.signatures_limit,
            "signature_statuses_batch": args.signature_statuses_batch,
            "signature_statuses_search_history": args.signature_statuses_search_history,
            "tx_encoding": args.tx_encoding,
            "block_encoding": args.block_encoding,
            "block_transaction_details": args.block_transaction_details,
            "block_rewards": args.block_rewards,
            "max_supported_tx_version": args.max_supported_tx_version,
            "blocks_range": args.blocks_range,
            "blocks_with_limit": args.blocks_with_limit,
            "inflation_reward_epoch": inflation_reward_epoch,
            "inflation_reward_address_count": args.inflation_reward_address_count,
        },
        "methods": methods,
    }


def print_progress(states: dict[str, MethodState], target: int) -> None:
    parts = []
    for state in states.values():
        parts.append(
            (
                f"{state.name}={state.valid_count}/{target}"
                f"(429={state.rate_limited},http={state.http_errors},"
                f"rpc={state.jsonrpc_errors},invalid={state.invalid_results})"
            )
        )
    print("progress:", "; ".join(parts), file=sys.stderr)


def print_table(summary: dict[str, Any]) -> None:
    headers = [
        "Method",
        "Valid",
        "Attempts",
        "p50",
        "p90",
        "p99",
        "429",
        "HTTP",
        "RPC",
        "Invalid",
        "Net",
    ]

    rows = []
    for method, details in summary["methods"].items():
        lat = details["latency_ms"]
        exc = details["excluded_attempts"]
        rows.append(
            [
                method,
                str(details["valid_samples"]),
                str(details["attempts"]),
                format_ms(lat["p50"]),
                format_ms(lat["p90"]),
                format_ms(lat["p99"]),
                str(exc["rate_limited"]),
                str(exc["http_errors"]),
                str(exc["jsonrpc_errors"]),
                str(exc["invalid_results"]),
                str(exc["network_errors"]),
            ]
        )

    widths = [len(header) for header in headers]
    for row in rows:
        for index, cell in enumerate(row):
            widths[index] = max(widths[index], len(cell))

    def fmt_row(row: list[str]) -> str:
        return "  ".join(cell.ljust(widths[index]) for index, cell in enumerate(row))

    print()
    print(fmt_row(headers))
    print(fmt_row(["-" * width for width in widths]))
    for row in rows:
        print(fmt_row(row))


def main() -> int:
    args = parse_args()
    random.seed()

    addresses = load_tokens(args.address_file)
    signatures = load_tokens(args.signature_file)
    slots = load_slots(args.slot_file)

    client = RpcClient(args.rpc_url, args.timeout_ms / 1000.0)
    started_at = utc_now()
    started_at_perf = time.perf_counter()

    try:
        inflation_reward_epoch: int | None = None
        inflation_reward_addresses: list[str] = []
        if "getInflationReward" in args.methods:
            inflation_reward_epoch = (
                args.inflation_reward_epoch
                if args.inflation_reward_epoch is not None
                else resolve_inflation_reward_epoch(
                    client=client,
                    commitment=args.commitment,
                    slots_per_epoch=args.slots_per_epoch,
                )
            )
            inflation_reward_addresses = prepare_inflation_reward_addresses(
                client=client,
                args=args,
                addresses=addresses,
                inflation_reward_epoch=inflation_reward_epoch,
            )

        specs = build_method_specs(
            args=args,
            addresses=addresses,
            signatures=signatures,
            slots=slots,
            inflation_reward_epoch=inflation_reward_epoch,
            inflation_reward_addresses=inflation_reward_addresses,
        )
        states = {spec.name: MethodState(spec.name) for spec in specs}

        request_id = 10
        max_attempts_per_method = (
            args.valid_samples_per_method * args.max_attempt_multiplier
        )
        attempts_since_progress = 0

        while not all_targets_met(states, args.valid_samples_per_method):
            if any_attempt_cap_exceeded(
                states, max_attempts_per_method, args.valid_samples_per_method
            ):
                break

            for spec in specs:
                state = states[spec.name]
                if state.valid_count >= args.valid_samples_per_method:
                    continue
                if state.attempts >= max_attempts_per_method:
                    continue

                request_id += 1
                attempt = perform_attempt(client, spec, request_id)
                record_attempt(state, attempt)
                attempts_since_progress += 1

                sleep_with_jitter(args.request_interval_ms, args.request_jitter_ms)
                if attempt.kind == "rate_limited":
                    time.sleep(args.rate_limit_backoff_ms / 1000.0)

                if (
                    not args.quiet
                    and attempts_since_progress >= len(specs) * 2
                ):
                    print_progress(states, args.valid_samples_per_method)
                    attempts_since_progress = 0

                if all_targets_met(states, args.valid_samples_per_method):
                    break
                if any_attempt_cap_exceeded(
                    states, max_attempts_per_method, args.valid_samples_per_method
                ):
                    break

        finished_at = utc_now()
        duration_seconds = time.perf_counter() - started_at_perf
        summary = build_summary(
            args=args,
            states=states,
            inflation_reward_epoch=inflation_reward_epoch,
            started_at=started_at,
            finished_at=finished_at,
            duration_seconds=duration_seconds,
        )

        print(
            f"Public RPC baseline against {args.rpc_url}",
            file=sys.stderr,
        )
        print(
            (
                f"Started {summary['started_at']} | Finished {summary['finished_at']} | "
                f"Duration {duration_seconds:.1f}s | "
                f"Inflation reward epoch {inflation_reward_epoch if inflation_reward_epoch is not None else 'n/a'}"
            ),
            file=sys.stderr,
        )
        print_table(summary)

        if args.json_output:
            json_output_path = Path(args.json_output)
            json_output_path.parent.mkdir(parents=True, exist_ok=True)
            json_output_path.write_text(
                json.dumps(summary, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            print(f"\nWrote JSON summary to {json_output_path}", file=sys.stderr)

        if not summary["complete"]:
            print(
                "\nRun was incomplete: at least one method hit the max-attempt cap before "
                "collecting enough valid samples.",
                file=sys.stderr,
            )
            return 2

        return 0
    finally:
        client.close()


if __name__ == "__main__":
    raise SystemExit(main())
