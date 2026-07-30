#!/usr/bin/env bash
# One-time app-server bootstrap (run as an admin user with sudo, before first publish:app).
# Creates the qtask system user, /opt/qtask home, docker group, and SSH dir.
#
#   curl -fsSL .../bootstrap-app-server.sh | bash   # or copy from release tar
#   ./deploy/bootstrap-app-server.sh
#
# Then from your dev machine:
#   ssh-copy-id -i ~/.ssh/id_ed25519.pub qtask@192.168.13.13
#   npm run publish:app
set -euo pipefail

INSTALL_DIR="${1:-/opt/qtask}"

echo "Bootstrapping QTask app server at ${INSTALL_DIR}..."

if ! command -v docker >/dev/null 2>&1; then
  echo "Error: docker is not installed. Install Docker before continuing." >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1 && ! command -v docker-compose >/dev/null 2>&1; then
  echo "Error: Docker Compose not found. Install docker-compose-v2 or docker-compose." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js is not installed. Install Node.js 20+ before continuing." >&2
  exit 1
fi

NODE_MAJOR="$(node -p "process.version.slice(1).split('.')[0]")"
if [[ "${NODE_MAJOR}" -lt 20 ]]; then
  echo "Error: Node.js 20+ required (found $(node -v))." >&2
  exit 1
fi

sudo mkdir -p "${INSTALL_DIR}"

if ! id qtask &>/dev/null; then
  echo "Creating system user qtask (home ${INSTALL_DIR})..."
  sudo useradd --system --home "${INSTALL_DIR}" --shell /bin/bash qtask
else
  echo "Updating qtask home/shell..."
  sudo usermod -d "${INSTALL_DIR}" -s /bin/bash qtask 2>/dev/null || true
fi

if getent group docker >/dev/null 2>&1; then
  sudo usermod -aG docker qtask
else
  echo "Warning: docker group not found — install Docker, then: sudo usermod -aG docker qtask" >&2
fi

sudo mkdir -p "${INSTALL_DIR}/.ssh" "${INSTALL_DIR}/run"
sudo chmod 700 "${INSTALL_DIR}/.ssh" "${INSTALL_DIR}/run"
sudo chown qtask:qtask "${INSTALL_DIR}/.ssh" "${INSTALL_DIR}/run"

echo ""
echo "Bootstrap complete."
echo "Next:"
echo "  1. ssh-copy-id -i ~/.ssh/id_ed25519.pub qtask@${HOSTNAME:-192.168.13.13}"
echo "  2. On dev machine: npm run publish:app"
echo "  3. Edit ${INSTALL_DIR}/live/.env (or ${INSTALL_DIR}/.env on first install)"
echo "  4. After first publish + qtask-deploy init, run once as admin:"
echo "       sudo ${INSTALL_DIR}/live/deploy/migrate-to-user-systemd.sh"
echo "     (or: sudo ${INSTALL_DIR}/live/deploy/repair-ab-deploy.sh for nginx + systemd)"
