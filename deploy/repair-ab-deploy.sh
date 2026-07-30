#!/usr/bin/env bash
# One-shot repair after qtask-deploy init — run as an admin user with sudo on the app server.
# Fixes nginx upstream, migrates to qtask user systemd (no sudo for deploy user).
#
#   sudo ./deploy/repair-ab-deploy.sh
#   sudo /opt/qtask/live/deploy/repair-ab-deploy.sh
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root or with sudo: sudo $0" >&2
  exit 1
fi

QTASK_ROOT="${QTASK_ROOT:-/opt/qtask}"
QTASK_DATA="${QTASK_DATA:-/var/lib/qtask}"
LIVE_LINK="${QTASK_ROOT}/live"
DEPLOY_DIR="${QTASK_DATA}/deploy"
NGINX_UPSTREAM="${DEPLOY_DIR}/nginx-upstream.conf"

if [[ -L "${LIVE_LINK}" ]]; then
  DEPLOY_SCRIPT="${LIVE_LINK}/deploy/qtask-deploy"
  MIGRATE_SCRIPT="${LIVE_LINK}/deploy/migrate-to-user-systemd.sh"
else
  DEPLOY_SCRIPT="${QTASK_ROOT}/deploy/qtask-deploy"
  MIGRATE_SCRIPT="${QTASK_ROOT}/deploy/migrate-to-user-systemd.sh"
fi

echo "==> Ensuring ${QTASK_DATA} layout permissions"
mkdir -p "${DEPLOY_DIR}" "${QTASK_DATA}/backups" "${QTASK_DATA}/uploads"
chown -R qtask:qtask "${QTASK_DATA}"
chmod 755 "${QTASK_DATA}" "${DEPLOY_DIR}"
chmod 700 "${QTASK_DATA}/backups"
chmod 755 "${QTASK_DATA}/uploads"

if [[ ! -f "${NGINX_UPSTREAM}" ]]; then
  cat > "${NGINX_UPSTREAM}" <<'EOF'
upstream qtask_active {
    server 127.0.0.1:3003;
}
EOF
  chown qtask:qtask "${NGINX_UPSTREAM}"
fi
chmod 644 "${NGINX_UPSTREAM}"

echo "==> Installing nginx upstream for qtask_active"
mkdir -p /etc/nginx/conf.d
cp "${NGINX_UPSTREAM}" /etc/nginx/conf.d/qtask-upstream.conf
nginx -t
systemctl reload nginx

if [[ -x "${MIGRATE_SCRIPT}" ]]; then
  echo "==> Migrating app stacks to qtask user systemd"
  bash "${MIGRATE_SCRIPT}"
elif [[ -x "${DEPLOY_SCRIPT}" ]]; then
  echo "Warning: ${MIGRATE_SCRIPT} not found — only nginx repaired" >&2
else
  echo "Warning: deploy scripts not found under ${LIVE_LINK}/deploy" >&2
fi

echo ""
echo "==> Health checks"
curl -sf "http://127.0.0.1:3003/health" | head -c 200 || echo "(live API unreachable)"
echo ""
curl -sf "http://127.0.0.1:3005/health" | head -c 200 || echo "(candidate API unreachable — ok if none)"
echo ""
echo "Repair complete. qtask manages stacks with systemctl --user (no sudo)."
