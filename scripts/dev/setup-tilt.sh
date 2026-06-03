#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# Copyright 2025-2026 Triton One Limited. All rights reserved.
#

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"

usage() {
  cat <<'USAGE'
Usage: scripts/dev/setup-tilt.sh [options] [-- <extra tilt args...>]

Sets up prerequisites for local Superbank development with Tilt (Kind cluster, kubectl context,
and optional local registry). This script does NOT run Tilt; it prints the `tilt up` command
to run next.

If you're not already in the Nix dev shell, this script will re-exec itself via `nix develop`
so `kind`, `kubectl`, etc. are available.

Options:
  --cluster <name>          Kind cluster name (default: superbank)
  --namespace <name>        Kubernetes namespace (default: superbank-dev)
  --ingest-mode <rpc|grpc>  Tiltfile ingest mode (default: rpc)
  --no-kind-setup           Don't create/select a Kind cluster
  --no-local-registry       Don't set up a Kind local registry (Tilt may warn)
  -h, --help                Show this help

Env vars (override defaults):
  SUPERBANK_KIND_CLUSTER
  SUPERBANK_NAMESPACE
  SUPERBANK_INGEST_MODE
  SUPERBANK_SETUP_KIND=0|1
  SUPERBANK_USE_LOCAL_REGISTRY=0|1
  SUPERBANK_KIND_REGISTRY_NAME
  SUPERBANK_KIND_REGISTRY_PORT
USAGE
}

if [[ "${1-}" == "-h" || "${1-}" == "--help" ]]; then
  usage
  exit 0
fi

# Ensure we run inside the Nix dev shell so `tilt`, `kind`, `kubectl`, etc. are available.
if [[ -z "${IN_NIX_SHELL-}" && "${SUPERBANK_DEV_IN_NIX-}" != "1" ]]; then
  if ! command -v nix >/dev/null 2>&1; then
    echo "error: nix not found. Install Nix, then re-run this script." >&2
    exit 1
  fi

  cd "${REPO_ROOT}"

  # Prefer plain `nix develop`, but fall back to enabling flakes/nix-command if needed.
  nix_develop=(nix develop)
  if ! nix develop -c true >/dev/null 2>&1; then
    nix_develop=(nix --extra-experimental-features 'nix-command flakes' develop)
    if ! "${nix_develop[@]}" -c true >/dev/null 2>&1; then
      cat >&2 <<'MSG'
error: nix is installed, but failed to enter the dev shell.
  - Try:
      nix develop
  - If flakes are disabled (no global config change):
      nix --extra-experimental-features 'nix-command flakes' develop
MSG
      exit 1
    fi
  fi

  exec "${nix_develop[@]}" -c env SUPERBANK_DEV_IN_NIX=1 "${SCRIPT_DIR}/setup-tilt.sh" "$@"
fi

cluster_name="${SUPERBANK_KIND_CLUSTER:-superbank}"
namespace="${SUPERBANK_NAMESPACE:-superbank-dev}"
ingest_mode="${SUPERBANK_INGEST_MODE:-rpc}"
setup_kind="${SUPERBANK_SETUP_KIND:-1}"
use_local_registry="${SUPERBANK_USE_LOCAL_REGISTRY:-1}"
registry_name="${SUPERBANK_KIND_REGISTRY_NAME:-kind-registry}"
registry_port="${SUPERBANK_KIND_REGISTRY_PORT:-5001}"

tilt_args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --cluster)
      cluster_name="${2:?missing value for --cluster}"
      shift 2
      ;;
    --namespace)
      namespace="${2:?missing value for --namespace}"
      shift 2
      ;;
    --ingest-mode)
      ingest_mode="${2:?missing value for --ingest-mode}"
      shift 2
      ;;
    --no-kind-setup)
      setup_kind=0
      shift
      ;;
    --no-local-registry|--no-registry)
      use_local_registry=0
      shift
      ;;
    --)
      shift
      tilt_args+=("$@")
      break
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      tilt_args+=("$1")
      shift
      ;;
  esac
done

case "${setup_kind}" in
  0|1) ;;
  *) echo "error: SUPERBANK_SETUP_KIND must be 0 or 1 (got: ${setup_kind})" >&2; exit 2 ;;
esac

case "${use_local_registry}" in
  0|1) ;;
  *) echo "error: SUPERBANK_USE_LOCAL_REGISTRY must be 0 or 1 (got: ${use_local_registry})" >&2; exit 2 ;;
esac

if [[ "${setup_kind}" == "1" ]]; then
  if ! docker info >/dev/null 2>&1; then
    docker_info_err="$(docker info 2>&1 | head -n 1 || true)"
    if [[ "${docker_info_err}" == *"permission denied"* ]]; then
      echo "error: Docker socket is not accessible (permission denied)." >&2
      echo "  - Fix: add your user to the 'docker' group and start a new shell:" >&2
      echo "      sudo usermod -aG docker \"${USER:-$(id -un)}\"" >&2
      echo "      newgrp docker    # or log out/in" >&2
    else
      echo "error: Docker daemon not reachable." >&2
      echo "  - Start Docker on the host (or set DOCKER_HOST) and re-run." >&2
    fi
    exit 1
  fi

  if [[ "${use_local_registry}" == "1" ]]; then
    # Setup Kind local registry (https://github.com/tilt-dev/kind-local).
    running="$(docker inspect -f '{{.State.Running}}' "${registry_name}" 2>/dev/null || true)"
    if [[ "${running}" != "true" ]]; then
      if docker inspect "${registry_name}" >/dev/null 2>&1; then
        docker start "${registry_name}" >/dev/null
      else
        docker run -d \
          --restart=always \
          -p "127.0.0.1:${registry_port}:5000" \
          --name "${registry_name}" \
          registry:2 >/dev/null
      fi
    fi
  fi

  if ! kind get clusters 2>/dev/null | grep -Fxq "${cluster_name}"; then
    kind create cluster --name "${cluster_name}"
  fi

  kind_context="kind-${cluster_name}"
  if ! kubectl config use-context "${kind_context}" >/dev/null 2>&1; then
    echo "error: failed to select kubectl context '${kind_context}'." >&2
    echo "  - Run: kind get clusters" >&2
    echo "  - Run: kubectl config get-contexts" >&2
    exit 1
  fi

  if [[ "${use_local_registry}" == "1" ]]; then
    docker network connect kind "${registry_name}" >/dev/null 2>&1 || true
    kubectl --context "${kind_context}" apply -f - >/dev/null <<EOF
apiVersion: v1
kind: ConfigMap
metadata:
  name: local-registry-hosting
  namespace: kube-public
data:
  localRegistryHosting.v1: |
    host: "localhost:${registry_port}"
    help: "https://github.com/tilt-dev/kind-local"
EOF

    # Kind node images now default to using `config_path`-based registry config (certs.d),
    # which is mutually exclusive with the older `registry.mirrors` config. Configure the
    # local registry by writing a hosts.toml file instead of patching mirrors.
    kind_nodes="$(kind get nodes --name "${cluster_name}" 2>/dev/null || true)"
    if [[ -z "${kind_nodes}" ]]; then
      cat >&2 <<MSG
[warn] Unable to discover Kind nodes for cluster '${cluster_name}'.
       Disabling local registry integration for this run.
MSG
      use_local_registry=0
    else
      hosts_toml="$(cat <<HOSTS
server = "http://${registry_name}:5000"

[host."http://${registry_name}:5000"]
  capabilities = ["pull", "resolve", "push"]
HOSTS
)"
      for node in ${kind_nodes}; do
        docker exec "${node}" mkdir -p "/etc/containerd/certs.d/localhost:${registry_port}" >/dev/null
        printf '%s\n' "${hosts_toml}" | docker exec -i "${node}" tee "/etc/containerd/certs.d/localhost:${registry_port}/hosts.toml" >/dev/null
      done
    fi
  fi
fi

cd "${REPO_ROOT}"

tilt_cmd=(tilt up --stream)
tilt_cmd+=("${tilt_args[@]}")

tilt_env=()
if [[ "${namespace}" != "superbank-dev" ]]; then
  tilt_env+=("SUPERBANK_NAMESPACE=${namespace}")
fi
if [[ "${ingest_mode}" != "rpc" ]]; then
  tilt_env+=("SUPERBANK_INGEST_MODE=${ingest_mode}")
fi

# When using Kind, Tilt needs a registry that the cluster can pull from (unless you're using some
# other image loading workflow). This is the same env var the Tiltfile reads to configure
# default_registry(...).
if [[ "${setup_kind}" == "1" && "${use_local_registry}" == "1" ]]; then
  tilt_env+=("LOCAL_REGISTRY_HOST=localhost:${registry_port}")
fi

cat <<MSG
Setup complete.

Next, run:
MSG

if [[ ${#tilt_env[@]} -gt 0 ]]; then
  printf '  %q ' "${tilt_env[@]}" "${tilt_cmd[@]}"
  echo
else
  printf '  %q ' "${tilt_cmd[@]}"
  echo
fi

if [[ "${SUPERBANK_DEV_IN_NIX-}" == "1" ]]; then
  cat <<'MSG'

Note: this setup was run via `nix develop -c ...`. If you don't have Tilt installed globally,
run Tilt via Nix as well:
MSG
  nix_cmd=(nix develop -c)
  if [[ ${#tilt_env[@]} -gt 0 ]]; then
    nix_cmd+=(env)
    nix_cmd+=("${tilt_env[@]}")
  fi
  nix_cmd+=("${tilt_cmd[@]}")
  printf '  %q ' "${nix_cmd[@]}"
  echo
fi
