#!/usr/bin/env bash
# Start Ollama + docker-proxy on Jetson (runs as qtask via systemd or interactive login).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/docker-compose.sh
source "${SCRIPT_DIR}/lib/docker-compose.sh"
# shellcheck source=lib/wait-jetson-ready.sh
source "${SCRIPT_DIR}/lib/wait-jetson-ready.sh"
# shellcheck source=lib/warm-jetson-models.sh
source "${SCRIPT_DIR}/lib/warm-jetson-models.sh"

APP_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.jetson.yml"
ENV_FILE="${QTASK_JETSON_ENV_FILE:-${APP_ROOT}/.env}"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Error: missing ${ENV_FILE} — copy deploy/.env.jetson.example to .env and set JETSON_BIND_ADDRESS" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

if [[ -z "${JETSON_BIND_ADDRESS:-}" ]]; then
  echo "Error: set JETSON_BIND_ADDRESS in ${ENV_FILE}" >&2
  exit 1
fi

qtask_wait_jetson_ready "${JETSON_BIND_ADDRESS}"

cd "${APP_ROOT}"
qtask_migrate_jetson_ollama_volume

if qtask_jetson_ollama_healthy "${JETSON_BIND_ADDRESS}"; then
  echo "Ollama already healthy on ${JETSON_BIND_ADDRESS}; skipping legacy container removal"
else
  qtask_remove_legacy_jetson_containers
fi

echo "Starting Jetson Ollama stack (${COMPOSE_FILE}, bind from ${ENV_FILE})"
qtask_compose_project -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" up -d --build

if [[ "${QTASK_SKIP_WARMUP:-}" != "1" ]]; then
  CHAT_MODEL="${QTASK_JETSON_CHAT_MODEL:-qwen3.5:2b}"
  EMBED_MODEL="${QTASK_JETSON_EMBED_MODEL:-nomic-embed-text}"
  qtask_warm_jetson_models "${JETSON_BIND_ADDRESS}" "${CHAT_MODEL}" "${EMBED_MODEL}" || true
fi
