#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/docker-compose.sh
source "${SCRIPT_DIR}/lib/docker-compose.sh"

COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.vision.yml"

echo "Stopping app-server vision Ollama"
qtask_compose -p qtask-vision -f "${COMPOSE_FILE}" down
