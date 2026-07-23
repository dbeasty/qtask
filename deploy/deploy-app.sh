#!/usr/bin/env bash
# Install, start MongoDB, and enable systemd for the QTask app server.
# Run from extracted release tar or repo (as qtask):
#   ./deploy/deploy-app.sh
# Options:
#   --install-only   Only rsync into /opt/qtask (no MongoDB/systemd)
#   --skip-mongodb   Do not start MongoDB
#   --skip-systemd   Do not install/enable systemd units
#   --force          Start services even if .env still has placeholder secrets
set -euo pipefail

INSTALL_DIR="${QTASK_INSTALL_DIR:-/opt/qtask}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

INSTALL_ONLY=false
SKIP_MONGODB=false
SKIP_SYSTEMD=false
FORCE=false

for arg in "$@"; do
  case "${arg}" in
    --install-only) INSTALL_ONLY=true ;;
    --skip-mongodb) SKIP_MONGODB=true ;;
    --skip-systemd) SKIP_SYSTEMD=true ;;
    --force) FORCE=true ;;
    *)
      echo "Unknown option: ${arg}" >&2
      exit 1
      ;;
  esac
done

echo "==> Installing to ${INSTALL_DIR}"
"${SCRIPT_DIR}/install.sh" "${INSTALL_DIR}"

ENV_FILE="${INSTALL_DIR}/.env"
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Error: missing ${ENV_FILE}" >&2
  exit 1
fi

if [[ "${INSTALL_ONLY}" == true ]]; then
  echo "Install complete (--install-only)."
  exit 0
fi

needs_config=false
if grep -qE 'JWT_SECRET=change-me|ADMIN_PASSWORD=change-me|ADMIN_JWT_SECRET=change-me' "${ENV_FILE}"; then
  needs_config=true
fi

if [[ "${needs_config}" == true && "${FORCE}" != true ]]; then
  echo ""
  echo "Edit ${ENV_FILE} before starting services (JWT_SECRET, ADMIN_PASSWORD, ADMIN_JWT_SECRET, domain URLs)."
  echo "Then re-run: ${INSTALL_DIR}/deploy/deploy-app.sh"
  echo "Or from dev machine: npm run publish:app"
  exit 0
fi

if [[ "${SKIP_MONGODB}" != true ]]; then
  echo "==> Starting MongoDB"
  QTASK_ENV_FILE="${ENV_FILE}" "${INSTALL_DIR}/deploy/start-mongodb.sh"
fi

if [[ "${SKIP_SYSTEMD}" != true ]]; then
  echo "==> Enabling systemd (qtask, qtask-admin)"
  # MongoDB is managed by docker compose (restart: unless-stopped) via start-mongodb.sh — no systemd/sudo needed.
  if ! sudo -n cp "${INSTALL_DIR}/deploy/qtask.service" /etc/systemd/system/qtask.service 2>/dev/null; then
    echo ""
    echo "Error: qtask user cannot install systemd units (sudo denied)." >&2
    echo "One-time fix as an admin user on this server:" >&2
    echo "  sudo cp ${INSTALL_DIR}/deploy/qtask-deploy.sudoers.example /etc/sudoers.d/qtask-deploy" >&2
    echo "  sudo chmod 440 /etc/sudoers.d/qtask-deploy" >&2
    echo "  sudo visudo -cf /etc/sudoers.d/qtask-deploy" >&2
    echo "Or re-run: ./deploy/bootstrap-app-server.sh" >&2
    echo ""
    echo "MongoDB is already running via Docker. To skip systemd and start API/admin manually:" >&2
    echo "  ${INSTALL_DIR}/deploy/deploy-app.sh --skip-systemd" >&2
    exit 1
  fi
  sudo cp "${INSTALL_DIR}/deploy/qtask-admin.service" /etc/systemd/system/qtask-admin.service
  sudo systemctl daemon-reload
  sudo systemctl enable qtask.service
  sudo systemctl enable qtask-admin.service
  sudo systemctl restart qtask.service
  sudo systemctl restart qtask-admin.service
fi

echo "==> Waiting for API"
for _ in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:3003/health" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

echo "==> Health checks"
curl -sf "http://127.0.0.1:3003/health" | head -c 200
echo ""
curl -sf "http://127.0.0.1:3004/health" | head -c 200
echo ""

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

if [[ -n "${OLLAMA_BASE_URL:-}" ]]; then
  echo "==> Ollama reachability (${OLLAMA_BASE_URL})"
  curl -sf "${OLLAMA_BASE_URL}/api/tags" | head -c 120 || echo "(Ollama not reachable — check Jetson firewall from app host)"
  echo ""
fi

echo ""
echo "App server deploy complete (${INSTALL_DIR})."
