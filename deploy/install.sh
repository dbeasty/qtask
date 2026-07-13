#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${1:-/opt/qtask}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "Installing QTask to ${INSTALL_DIR}..."

if [[ ! -f "${APP_ROOT}/package.json" ]]; then
  echo "Error: run install.sh from inside an extracted release tarball." >&2
  exit 1
fi

sudo mkdir -p "${INSTALL_DIR}"
sudo rsync -a --delete \
  --exclude='.env' \
  --exclude='.env.local' \
  "${APP_ROOT}/" "${INSTALL_DIR}/"

cd "${INSTALL_DIR}"
npm ci --omit=dev

if [[ ! -f "${INSTALL_DIR}/.env" ]]; then
  cp "${INSTALL_DIR}/deploy/.env.production.example" "${INSTALL_DIR}/.env"
  echo "Created ${INSTALL_DIR}/.env — edit secrets before starting."
fi

if ! id qtask &>/dev/null; then
  sudo useradd --system --home "${INSTALL_DIR}" --shell /usr/sbin/nologin qtask
fi

sudo chown -R qtask:qtask "${INSTALL_DIR}"

echo ""
echo "Next steps:"
echo "  1. Edit ${INSTALL_DIR}/.env (JWT_SECRET, Resend/mail, domain, Jetson OLLAMA_BASE_URL)"
echo "  2. Start MongoDB: docker compose -f ${INSTALL_DIR}/deploy/docker-compose.mongodb.yml up -d"
echo "  3. Install systemd unit:"
echo "       sudo cp ${INSTALL_DIR}/deploy/qtask.service /etc/systemd/system/"
echo "       sudo systemctl daemon-reload"
echo "       sudo systemctl enable --now qtask"
echo "  4. Verify: curl http://127.0.0.1:3003/health"
