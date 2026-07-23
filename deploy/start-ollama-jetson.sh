#!/usr/bin/env bash
# Start Ollama + docker-proxy on Jetson (runs as qtask via systemd or interactive login).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/docker-compose.sh
source "${SCRIPT_DIR}/lib/docker-compose.sh"

APP_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.jetson.yml"
ENV_FILE="${QTASK_JETSON_ENV_FILE:-${APP_ROOT}/.env}"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Error: missing ${ENV_FILE} — copy deploy/.env.jetson.example to .env and set JETSON_BIND_ADDRESS" >&2
  exit 1
fi

cd "${APP_ROOT}"
qtask_migrate_jetson_ollama_volume
qtask_remove_legacy_jetson_containers
echo "Starting Jetson Ollama stack (${COMPOSE_FILE}, bind from ${ENV_FILE})"
qtask_compose_project -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" up -d --build
