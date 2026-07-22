#!/usr/bin/env bash
# Install QTask Ollama stack on a Jetson (Compose + systemd as user qtask).
# Prefer deploy-jetson-ollama.sh for full install + start + models + systemd.
#   ./deploy/deploy-jetson-ollama.sh
# This script only copies files to /opt/qtask-ollama:
#   ./deploy/install-jetson-ollama.sh
set -euo pipefail

INSTALL_DIR="${1:-/opt/qtask-ollama}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

JETSON_FILES=(
  docker-compose.jetson.yml
  start-ollama-jetson.sh
  stop-ollama-jetson.sh
  deploy-jetson-ollama.sh
  qtask-ollama.service
  .env.jetson.example
  install-jetson-ollama.sh
)

LIB_FILES=(
  lib/docker-compose.sh
)

echo "Installing Jetson Ollama stack to ${INSTALL_DIR}..."

for f in "${JETSON_FILES[@]}"; do
  if [[ ! -f "${SCRIPT_DIR}/${f}" ]]; then
    echo "Error: missing ${SCRIPT_DIR}/${f}" >&2
    exit 1
  fi
done

for f in "${LIB_FILES[@]}"; do
  if [[ ! -f "${SCRIPT_DIR}/${f}" ]]; then
    echo "Error: missing ${SCRIPT_DIR}/${f}" >&2
    exit 1
  fi
done

if ! command -v docker >/dev/null 2>&1; then
  echo "Error: docker is not installed (see docs/DEPLOY.md §4.1.1)" >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1 && ! command -v docker-compose >/dev/null 2>&1; then
  echo "Error: Docker Compose not found. Install docker-compose-v2 or docker-compose." >&2
  exit 1
fi

sudo mkdir -p "${INSTALL_DIR}/deploy/lib"
for f in "${JETSON_FILES[@]}"; do
  sudo cp "${SCRIPT_DIR}/${f}" "${INSTALL_DIR}/deploy/"
done
for f in "${LIB_FILES[@]}"; do
  sudo cp "${SCRIPT_DIR}/${f}" "${INSTALL_DIR}/deploy/${f}"
done

if ! id qtask &>/dev/null; then
  echo "Creating system user qtask (home ${INSTALL_DIR})..."
  sudo useradd --system --home "${INSTALL_DIR}" --shell /bin/bash qtask
fi

if getent group docker >/dev/null 2>&1; then
  sudo usermod -aG docker qtask
else
  echo "Warning: docker group not found — create it or install Docker, then: sudo usermod -aG docker qtask" >&2
fi

if [[ ! -f "${INSTALL_DIR}/.env" ]]; then
  sudo cp "${INSTALL_DIR}/deploy/.env.jetson.example" "${INSTALL_DIR}/.env"
  echo "Created ${INSTALL_DIR}/.env — set JETSON_BIND_ADDRESS to your service VLAN IP."
fi

sudo chmod +x \
  "${INSTALL_DIR}/deploy/start-ollama-jetson.sh" \
  "${INSTALL_DIR}/deploy/stop-ollama-jetson.sh" \
  "${INSTALL_DIR}/deploy/deploy-jetson-ollama.sh" \
  "${INSTALL_DIR}/deploy/install-jetson-ollama.sh" \
  "${INSTALL_DIR}/deploy/lib/docker-compose.sh"
sudo chown -R qtask:qtask "${INSTALL_DIR}"

echo ""
echo "Install complete. Full deploy:"
echo "  ${INSTALL_DIR}/deploy/deploy-jetson-ollama.sh"
