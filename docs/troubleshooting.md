# Troubleshooting

This page collects common local development failures and the fastest fixes. All paths are relative
to the repo root.

## Docker socket permission denied

Symptom:
- `docker info` fails with `permission denied` (common on Linux).
- `scripts/dev/setup-tilt.sh` prints: `error: Docker socket is not accessible (permission denied).`

Cause:
- Docker is installed, but your user cannot access the Docker daemon socket (often
  `/var/run/docker.sock`).

Fix:
1. Add your user to the `docker` group and start a new shell:

```bash
sudo usermod -aG docker "$USER"
newgrp docker    # or log out/in
```

2. Confirm Docker is reachable:

```bash
docker info
```

Notes:
- The Nix dev shell provides the Docker CLI, but you still need a running Docker daemon on the host.

## ClickHouse connection issues and missing tables

Symptom:
- `superbank-rpc` fails to start with `ClickHouse initialization failed: ...`.
- Logs mention missing or inaccessible tables such as `default.gsfa`, `default.signatures`,
  `default.blocks_metadata`, or `default.transactions`.

Cause:
- `CLICKHOUSE_URL` points to the wrong host/port, credentials are wrong (`CLICKHOUSE_USER` /
  `CLICKHOUSE_PASSWORD`), or required ClickHouse DDL was not applied.

Fix:
1. If you are using local Docker ClickHouse, start it (matches the root `README.md`):

```bash
docker run -d --name clickhouse \
  --ulimit nofile=262144:262144 \
  -e CLICKHOUSE_SKIP_USER_SETUP=1 \
  -p 8123:8123 -p 9000:9000 \
  clickhouse/clickhouse-server:26.1.2.11
```

`CLICKHOUSE_SKIP_USER_SETUP=1` makes the image's `default` user reachable through the mapped
ports for local development. Without it, 26.1.x images can reject host-side connections with an
authentication error that looks like a bad password. Do not use this insecure local-only setting
for production ClickHouse.

2. Apply the local (single-node) schemas from `ddl/local/*.sql`. Minimum set for `superbank-rpc`:

```bash
cat ddl/local/transactions.sql | docker exec -i clickhouse clickhouse-client --multiquery
cat ddl/local/blocks_metadata.sql | docker exec -i clickhouse clickhouse-client --multiquery
cat ddl/local/gsfa.sql | docker exec -i clickhouse clickhouse-client --multiquery
cat ddl/local/signatures.sql | docker exec -i clickhouse clickhouse-client --multiquery

# Optional: enables tokenAccounts filters in getTransactionsForAddress
cat ddl/local/token_owner_activity.sql | docker exec -i clickhouse clickhouse-client --multiquery
```

Apply `transactions.sql` first. `gsfa.sql`, `signatures.sql`, and `token_owner_activity.sql` are
materialized views that read from the transactions table.

3. Ensure `superbank-rpc` is configured for the same ClickHouse instance. The local helper defaults
   match the Docker ClickHouse setup above; override these values if your local setup differs:

```bash
CLICKHOUSE_URL=http://localhost:8123 \
CLICKHOUSE_USER=default \
CLICKHOUSE_PASSWORD= \
scripts/dev/run-local-rpc.sh
```

4. If you are running under Tilt, table creation is handled by the `clickhouse-ddl` Job
   (`deploy/k8s/11-clickhouse-ddl-job.yaml`). If you see missing-table errors under Tilt, check that
   the `clickhouse-ddl` resource completed successfully.

Notes:
- For ClickHouse clusters, use `ddl/cluster/*.sql` for non-replicated shard-local tables or
  `ddl/replicated/*.sql` for replicated shard-local tables. The replicated files require
  Keeper/ZooKeeper and `{cluster}`, `{shard}`, and `{replica}` macros.
- `token_owner_activity` is optional. If it is missing/unavailable, `superbank-rpc` will start but
  disables `tokenAccounts` filters and logs a warning.

## Build fails: protoc missing

Symptom:
- `cargo build` / `cargo test` fails with an error mentioning `protoc` (for example: `protoc: not
  found`).

Cause:
- The Protocol Buffers compiler (`protoc`) is not installed or not on `PATH`.

Fix:
- Install `protoc` and ensure it is discoverable on `PATH`.
- CI installs Protoc `25.3` (see `.github/workflows/ci.yml`). If you want to match CI exactly,
  install that version locally.

Notes:
- The Nix dev shell in `flake.nix` includes `protoc`; `nix develop -c protoc --version` is a quick
  way to verify it is available.

## Build fails on Linux: libclang/llvm issues

Symptom:
- Build fails on Linux with errors referencing `clang`, `libclang`, or `llvm` (for example, missing
  `libclang`).

Cause:
- Missing system dependencies required by some crates.

Fix:
- On Ubuntu, install the same packages CI installs (see `.github/workflows/ci.yml`):

```bash
sudo apt-get update
sudo apt-get install -y clang libclang-dev llvm-dev pkg-config libudev-dev libusb-1.0-0-dev
```

Then re-run `cargo build` / `cargo test`.

## RPC rejects commitment=processed (head cache disabled)

Symptom:
- JSON-RPC requests that pass `"commitment": "processed"` fail with error `-32602` and message:
  `Only confirmed or finalized commitments are supported`.
- `scripts/test/run-k6.sh` may skip the head-cache WS scenario with:
  `RPC does not support commitment=processed (head cache disabled)`.

Cause:
- `processed` commitment is rejected by default.
- `processed` is only supported (for a subset of methods) when:
  - `superbank-rpc` is compiled with `--features grpc-head-cache`, and
  - the head cache is enabled at runtime (`HEAD_CACHE_ENABLED=true` and `DRAGONSMOUTH_ENDPOINT` set).
- `getBlock` still requires `confirmed` or `finalized`.
- `getBlocks` and `getBlocksWithLimit` support `processed` only when head cache is enabled.

Fix:
1. If you do not need `processed`, use `confirmed` or `finalized`.
2. To enable the head cache locally, build with the feature and enable it at runtime. Using the
   helper script:

```bash
SUPERBANK_RPC_FEATURES=grpc-head-cache \
HEAD_CACHE_ENABLED=true \
DRAGONSMOUTH_ENDPOINT=https://YOUR_DRAGONSMOUTH_ENDPOINT \
DRAGONSMOUTH_X_TOKEN=YOUR_OPTIONAL_TOKEN \
CLICKHOUSE_URL=http://localhost:8123 \
CLICKHOUSE_USER=default \
scripts/dev/run-local-rpc.sh
```

3. If `HEAD_CACHE_ENABLED=true` but `DRAGONSMOUTH_ENDPOINT` is empty, `superbank-rpc` logs a warning
   and runs with head cache disabled.

Notes:
- Enabling `grpc-head-cache` pulls in an AGPL-3.0 dependency. See `crates/superbank-rpc/README.md`.

## gRPC ingest fails with `Unexpected EOF decoding stream`

Symptom:
- `superbank` exits with:
  `Error: gRPC update error`
  `Caused by: code: 'Internal error', message: "Unexpected EOF decoding stream."`

Cause:
- The upstream HTTP/2 gRPC response ended with a partial frame buffered in the client.
- This indicates a truncated stream from the provider or the network path, not a Superbank block/transaction mapping failure.
- If `GRPC_MAX_DECODING_BYTES` were too small, tonic would report a message-length limit error instead.

Fix:
1. Upgrade to a build that includes the reconnecting gRPC ingest loop.
2. For seeded live-tail deployments, set `DRAGONSMOUTH_FROM_SLOT=*` so restarts resume from the latest durable slot already written to `blocks_metadata`.
3. If the error persists frequently, inspect the upstream provider status and any intermediate load balancer or proxy for HTTP/2 stream resets.

Notes:
- `deploy/k8s/31-superbank-ingest-grpc.yaml` now defaults `DRAGONSMOUTH_FROM_SLOT` to `*` for this reason.

## GSFA backfill fails with `Code: 252 (TOO_MANY_PARTS)`

Symptom:
- Backfill or replay writes fail with errors similar to:
  `Too many parts (...) in table 'default.gsfa_local' ... while pushing to view default.gsfa`.

Cause:
- GSFA rows are derived from `transactions` via materialization, and high-concurrency backfills can
  create parts faster than merges can compact them.
- Older deployments may also still use an incompatible split GSFA layout with a separate
  `default.gsfa_mv` object.

Fix (manual rollout on your ClickHouse cluster):
1. Pause writers to `default.transactions` and stop GSFA-dependent reads during the migration.
2. Migrate to the current GSFA layout:
   - `default.gsfa_local`: storage table
   - `default.gsfa`: materialized view and distributed query/write surface

Example migration sequence (clustered replicated deployment):

```sql
-- backup old GSFA objects first
RENAME TABLE default.gsfa TO default.gsfa_legacy_backup ON CLUSTER '{cluster}';
-- if the split layout exists, also drop or rename the separate writer
RENAME TABLE default.gsfa_mv TO default.gsfa_mv_legacy_backup ON CLUSTER '{cluster}';

-- apply the current DDL shape from repo
-- (run ddl/replicated/gsfa.sql or ddl/replicated/gsfa_nohot.sql)
```

3. Rebuild GSFA from `transactions_local` in bounded epoch windows with low concurrency.
   Use the helper script from this repo if needed:

```bash
CH_PASS='...' scripts/analysis/rebuild-gsfa-from-transactions.sh <start_epoch> <end_epoch>
```
   The helper discovers one host per shard from `system.clusters` and runs those shard-local
   rebuilds in parallel.
   To rebuild the hot table with the same execution model:

```bash
CH_PASS='...' scripts/analysis/rebuild-gsfa-hot-from-transactions.sh <start_epoch> <end_epoch>
```
   `GSFA_HOT_ADDRESS` selects the single hot address to rebuild; rerun the helper separately for
   any additional hot addresses.
   To rebuild the signatures table with the same execution model:

```bash
CH_PASS='...' scripts/analysis/rebuild-signatures-from-transactions.sh <start_epoch> <end_epoch>
```
   To rebuild the token-owner activity table with the same execution model:

```bash
CH_PASS='...' scripts/analysis/rebuild-token-owner-activity-from-transactions.sh <start_epoch> <end_epoch>
```
4. Monitor pressure while rebuilding:
   - `system.parts` for `default.gsfa_local` part counts
   - `system.merges` for active merges
   - `system.errors` for `Code: 252`
5. Resume writers only after the rebuild is complete and validated.

Notes:
- In this repo, GSFA DDL now uses `32` buckets (`cityHash64(address) % 32`) for the replicated and
  clustered layouts.
- If needed during rebuild, raise `max_parts_in_total` temporarily and lower it after merges settle.

## Source cluster has rows missing from another cluster

Symptom:
- One ClickHouse cluster is expected to contain at least the same `transactions_local` or
  `blocks_metadata_local` rows as another cluster, but you need a backfill-oriented list of missing
  keys rather than a human-only count.

Fix:
- Use the cluster audit helper from this repo. In the default `MODE=counts`, it compares
  cluster-wide per-epoch row counts with `cluster() FINAL` and flags epochs whose counts differ.
- If you need exact backfill manifests after that fast screen, rerun the same helper with
  `MODE=missing-keys`.

Example:

```bash
SOURCE_CH_HOST=source-clickhouse.example.com \
SOURCE_CLUSTER=source \
TARGET_CH_HOST=target-clickhouse.example.com \
TARGET_CLUSTER=target \
SOURCE_CH_PASS='...' \
TARGET_CH_PASS='...' \
MODE=counts \
TABLES=transactions_local,blocks_metadata_local \
EPOCH_START=700 \
EPOCH_END=705 \
scripts/analysis/check-cluster-table-missing-keys.sh
```

Outputs:
- `cluster-missing-keys/summary.csv`
- `cluster-missing-keys/<table>/missing-keys-epoch-<n>.csv` when `MODE=missing-keys`

Notes:
- `MODE=counts` uses `FINAL` to collapse duplicates before counting, but equal counts still do not
  prove identical rows.
- `transactions_local` CSVs use `slot,slot_idx,signature` with base58 signatures when
  `MODE=missing-keys`.
- `MODE=missing-keys` is source-to-target only. Extra target rows are ignored.
- If `EPOCH_START` and `EPOCH_END` are omitted, the helper derives the epoch range from the source
  and target table counts being checked.

## Tilt fails: Nix-built binaries and patchelf (runtime image interpreter)

Symptom:
- `tilt up --stream` fails during `superbank-build` with:

```text
error: patchelf is required to run Nix-built binaries in the Ubuntu runtime image.
  - Run Tilt inside the Nix dev shell (provides patchelf), e.g.:
      nix develop -c tilt up --stream
  - Or install patchelf and re-run.
```

Cause:
- The Tilt workflow builds Rust binaries locally, stages them into `dist/`, and then builds an
  Ubuntu runtime image (`deploy/docker/Dockerfile.superbank-dev-runtime`).
- When built inside a Nix environment, the binaries can reference a `/nix/store/...` dynamic linker
  ("interpreter") that does not exist in the Ubuntu image.

Fix:
- Run Tilt inside the Nix dev shell so `patchelf` is available:

```bash
nix develop -c tilt up --stream
```

- Or install `patchelf` on your host and re-run `tilt up --stream`.
- The `Tiltfile` rewrites the interpreter to `/lib64/ld-linux-x86-64.so.2` when it detects a
  Nix-linked binary.
