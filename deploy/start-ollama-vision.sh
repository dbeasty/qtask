#!/usr/bin/env bash
# Start loopback-only Ollama for feedback screenshot validation on the app server.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/docker-compose.sh
source "${SCRIPT_DIR}/lib/docker-compose.sh"

APP_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.vision.yml"

cd "${APP_ROOT}"
echo "Starting app-server vision Ollama (${COMPOSE_FILE}, 127.0.0.1:11434)"
qtask_compose -p qtask-vision -f "${COMPOSE_FILE}" up -d

for _ in $(seq 1 30); do
  if curl -sf http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
    echo "Vision Ollama is up."
    exit 0
  fi
  sleep 2
done

echo "Warning: Ollama did not respond on 127.0.0.1:11434 — check: docker logs qtask-ollama-vision" >&2
exit 1
