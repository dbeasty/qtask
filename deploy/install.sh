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

needs_sudo_for_install_dir() {
  if [[ "$(id -u)" -eq 0 ]]; then
    return 1
  fi
  if [[ -d "${INSTALL_DIR}" && -w "${INSTALL_DIR}" ]]; then
    return 1
  fi
  local parent
  parent="$(dirname "${INSTALL_DIR}")"
  if [[ ! -d "${INSTALL_DIR}" && -d "${parent}" && -w "${parent}" ]]; then
    return 1
  fi
  return 0
}

run_privileged() {
  if needs_sudo_for_install_dir; then
    sudo "$@"
  else
    "$@"
  fi
}

run_privileged mkdir -p "${INSTALL_DIR}"
run_privileged rsync -a --delete \
  --exclude='.env' \
  --exclude='.env.local' \
  --exclude='.ssh/' \
  --exclude='qtask-*/' \
  --exclude='run/' \
  "${APP_ROOT}/" "${INSTALL_DIR}/"

cd "${INSTALL_DIR}"
npm ci --omit=dev

if [[ ! -f "${INSTALL_DIR}/.env" ]]; then
  cp "${INSTALL_DIR}/deploy/.env.production.example" "${INSTALL_DIR}/.env"
  echo "Created ${INSTALL_DIR}/.env — edit secrets before starting."
fi

if [[ "$(id -u)" -eq 0 ]] || needs_sudo_for_install_dir; then
  if ! id qtask &>/dev/null; then
    run_privileged useradd --system --home "${INSTALL_DIR}" --shell /bin/bash qtask
  else
    run_privileged usermod -d "${INSTALL_DIR}" -s /bin/bash qtask 2>/dev/null || true
  fi

  if getent group docker >/dev/null 2>&1; then
    run_privileged usermod -aG docker qtask
  fi

  run_privileged chown -R qtask:qtask "${INSTALL_DIR}"
fi

echo ""
echo "Next steps:"
echo "  Full deploy: ${INSTALL_DIR}/deploy/deploy-app.sh"
echo "  Or from dev machine: npm run publish:app"
echo ""
echo "  1. Edit ${INSTALL_DIR}/.env (JWT/admin secrets, mail, domain, OLLAMA_BASE_URL)"
echo "     Optional: npm run hash-admin-password for bcrypt admin password storage"
echo "     Optional: SECRETS_BACKEND=vault (see docs/DEPLOY.md §8) or MONGO_ENCRYPT_AT_REST=true (§7)"
echo "  2. Start MongoDB: ${INSTALL_DIR}/deploy/start-mongodb.sh"
echo "     (or: docker compose -f ${INSTALL_DIR}/deploy/docker-compose.mongodb.yml up -d)"
echo "  3. Install systemd unit:"
echo "       sudo cp ${INSTALL_DIR}/deploy/qtask.service /etc/systemd/system/"
echo "       sudo cp ${INSTALL_DIR}/deploy/qtask-admin.service /etc/systemd/system/"
echo "       sudo systemctl daemon-reload"
echo "       sudo systemctl enable --now qtask"
echo "       sudo systemctl enable --now qtask-admin"
echo "  4. Verify: curl http://127.0.0.1:3003/health && curl http://127.0.0.1:3004/health"
