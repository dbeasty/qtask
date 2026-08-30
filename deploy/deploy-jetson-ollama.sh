#!/usr/bin/env bash
# Install, start, pull models, and enable systemd for Jetson Ollama.
# Run from extracted release tar or repo (as qtask):
#   ./deploy/deploy-jetson-ollama.sh
# Options:
#   --skip-models    Do not pull Ollama models
#   --skip-systemd   Do not install/enable qtask-ollama.service
#   --install-only   Only run install-jetson-ollama.sh
set -euo pipefail

INSTALL_DIR="${QTASK_JETSON_INSTALL_DIR:-/opt/qtask-ollama}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/docker-compose.sh
source "${SCRIPT_DIR}/lib/docker-compose.sh"
# shellcheck source=lib/warm-jetson-models.sh
source "${SCRIPT_DIR}/lib/warm-jetson-models.sh"

SKIP_MODELS=false
SKIP_SYSTEMD=false
INSTALL_ONLY=false

for arg in "$@"; do
  case "${arg}" in
    --skip-models) SKIP_MODELS=true ;;
    --skip-systemd) SKIP_SYSTEMD=true ;;
    --install-only) INSTALL_ONLY=true ;;
    *)
      echo "Unknown option: ${arg}" >&2
      exit 1
      ;;
  esac
done

CHAT_MODEL="${QTASK_JETSON_CHAT_MODEL:-qwen3.5:2b}"
EMBED_MODEL="${QTASK_JETSON_EMBED_MODEL:-nomic-embed-text}"

echo "==> Installing to ${INSTALL_DIR}"
"${SCRIPT_DIR}/install-jetson-ollama.sh" "${INSTALL_DIR}"

ENV_FILE="${INSTALL_DIR}/.env"
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Error: missing ${ENV_FILE}" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

if [[ -z "${JETSON_BIND_ADDRESS:-}" ]]; then
  echo "Error: set JETSON_BIND_ADDRESS in ${ENV_FILE} (e.g. 192.168.13.14)" >&2
  exit 1
fi

if [[ "${INSTALL_ONLY}" == true ]]; then
  echo "Install complete (--install-only)."
  exit 0
fi

echo "==> Starting stack (bind ${JETSON_BIND_ADDRESS})"
QTASK_SKIP_WARMUP=1 QTASK_JETSON_ENV_FILE="${ENV_FILE}" "${INSTALL_DIR}/deploy/start-ollama-jetson.sh"

qtask_wait_jetson_ollama_api "${JETSON_BIND_ADDRESS}"

echo "==> Waiting for GPU stats sidecar"
for _ in $(seq 1 15); do
  if curl -sf "http://${JETSON_BIND_ADDRESS}:9401/health" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

if [[ "${SKIP_MODELS}" != true ]]; then
  echo "==> Pulling models (${CHAT_MODEL}, ${EMBED_MODEL})"
  docker exec qtask-ollama ollama pull "${CHAT_MODEL}"
  docker exec qtask-ollama ollama pull "${EMBED_MODEL}"
fi

echo "==> Warming agent + embedding models"
qtask_warm_jetson_models "${JETSON_BIND_ADDRESS}" "${CHAT_MODEL}" "${EMBED_MODEL}"

if [[ "${SKIP_SYSTEMD}" != true ]]; then
  echo "==> Enabling systemd (qtask-ollama.service)"
  sudo cp "${INSTALL_DIR}/deploy/qtask-ollama.service" /etc/systemd/system/
  sudo systemctl daemon-reload
  sudo systemctl enable --now qtask-ollama.service
fi

echo "==> Health checks"
curl -sf "http://${JETSON_BIND_ADDRESS}:11434/api/tags" | head -c 120
echo ""
curl -sf "http://${JETSON_BIND_ADDRESS}:2375/v1.44/_ping"
echo ""

echo ""
echo "Jetson Ollama deploy complete."
echo "App host .env:"
echo "  OLLAMA_BASE_URL=http://${JETSON_BIND_ADDRESS}:11434"
echo "  OLLAMA_MODEL=${CHAT_MODEL}"
echo "  OLLAMA_EMBEDDING_MODEL=${EMBED_MODEL}"
echo "  OLLAMA_DOCKER_STATS_URL=http://${JETSON_BIND_ADDRESS}:2375/v1.44"
echo "  OLLAMA_DOCKER_CONTAINER=qtask-ollama"
