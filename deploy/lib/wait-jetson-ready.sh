#!/usr/bin/env bash
# Wait for Jetson VLAN bind address and Docker before starting Ollama Compose.
# Source from deploy/start-ollama-jetson.sh (do not run directly).

qtask_wait_for_bind_address() {
  local bind_address="${1:?bind address required}"
  local timeout_seconds="${2:-120}"
  local waited=0

  while (( waited < timeout_seconds )); do
    if ip -4 addr show | grep -Fq "inet ${bind_address}/"; then
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done

  echo "Error: ${bind_address} not assigned after ${timeout_seconds}s (VLAN interface may be down)" >&2
  return 1
}

qtask_wait_for_docker() {
  local timeout_seconds="${1:-120}"
  local waited=0

  while (( waited < timeout_seconds )); do
    if docker info >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done

  echo "Error: Docker not ready after ${timeout_seconds}s" >&2
  return 1
}

qtask_jetson_ollama_healthy() {
  local bind_address="${1:?bind address required}"
  local attempts="${2:-10}"
  local i

  for (( i = 1; i <= attempts; i++ )); do
    if curl -sf --connect-timeout 2 "http://${bind_address}:11434/api/tags" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done

  return 1
}

qtask_wait_jetson_ready() {
  local bind_address="${1:?bind address required}"

  echo "Waiting for bind address ${bind_address}..."
  qtask_wait_for_bind_address "${bind_address}"

  echo "Waiting for Docker..."
  qtask_wait_for_docker
}
