#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

cd "${APP_DIR}"

if [[ ! -d .git ]]; then
  echo "Error: ${APP_DIR} is not a git checkout. Use a release tar for non-git installs." >&2
  exit 1
fi

echo "Updating QTask in ${APP_DIR}..."
git pull --ff-only

npm ci
npm run build
npm ci --prefix client
npm run build --prefix client
npm ci --prefix admin-client
npm run build --prefix admin-client
npm ci --omit=dev

if [[ ! -f .env ]]; then
  cp deploy/.env.production.example .env
  echo "Created .env — edit secrets before restarting."
fi

if systemctl is-active --quiet qtask 2>/dev/null; then
  sudo systemctl restart qtask
  echo "Restarted qtask service."
else
  echo "qtask systemd service not running — start with: sudo systemctl start qtask"
fi
if systemctl is-active --quiet qtask-admin 2>/dev/null; then
  sudo systemctl restart qtask-admin
  echo "Restarted qtask-admin service."
fi

echo "Done. Verify: curl http://127.0.0.1:3003/health && curl http://127.0.0.1:3004/health"
