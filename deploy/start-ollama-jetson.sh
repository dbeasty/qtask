#!/usr/bin/env bash
# Start Ollama + docker-proxy on Jetson for systemd / manual use.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.jetson.yml"

cd "${APP_ROOT}"
echo "Starting Jetson Ollama stack (${COMPOSE_FILE})"
docker compose -f "${COMPOSE_FILE}" up -d
