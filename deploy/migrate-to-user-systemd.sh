#!/usr/bin/env bash
# One-time migration: system-wide qtask@.service → qtask user systemd (no sudo for deploys).
# Run as admin with sudo on the app server:
#   sudo ./deploy/migrate-to-user-systemd.sh
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root or with sudo: sudo $0" >&2
  exit 1
fi

QTASK_ROOT="${QTASK_ROOT:-/opt/qtask}"
LIVE_LINK="${QTASK_ROOT}/live"

if [[ -L "${LIVE_LINK}" ]]; then
  UNIT_SRC="${LIVE_LINK}/deploy/systemd-user"
else
  UNIT_SRC="${QTASK_ROOT}/deploy/systemd-user"
fi

echo "==> Enable systemd linger for qtask (services run at boot without login)"
loginctl enable-linger qtask

echo "==> Install user systemd units"
USER_UNIT_DIR="${QTASK_ROOT}/.config/systemd/user"
install -d -o qtask -g qtask -m 755 "${QTASK_ROOT}/.config" "${USER_UNIT_DIR}"
install -o qtask -g qtask -m 644 "${UNIT_SRC}/qtask@.service" "${USER_UNIT_DIR}/"
install -o qtask -g qtask -m 644 "${UNIT_SRC}/qtask-admin@.service" "${USER_UNIT_DIR}/"

echo "==> Stop legacy system-wide units (if present)"
systemctl disable --now qtask.service qtask-admin.service 2>/dev/null || true
for stack in live candidate; do
  systemctl disable --now "qtask@${stack}.service" "qtask-admin@${stack}.service" 2>/dev/null || true
done

echo "==> Start stacks via qtask user systemd"
sudo -u qtask XDG_RUNTIME_DIR="/run/user/$(id -u qtask)" systemctl --user daemon-reload
sudo -u qtask XDG_RUNTIME_DIR="/run/user/$(id -u qtask)" systemctl --user enable qtask@live.service qtask-admin@live.service
sudo -u qtask XDG_RUNTIME_DIR="/run/user/$(id -u qtask)" systemctl --user restart qtask@live.service qtask-admin@live.service

if [[ -L "${QTASK_ROOT}/candidate" ]]; then
  sudo -u qtask XDG_RUNTIME_DIR="/run/user/$(id -u qtask)" systemctl --user enable qtask@candidate.service qtask-admin@candidate.service
  sudo -u qtask XDG_RUNTIME_DIR="/run/user/$(id -u qtask)" systemctl --user restart qtask@candidate.service qtask-admin@candidate.service
fi

echo ""
echo "Migration complete. qtask can manage deploys with: systemctl --user (no sudo)."
echo "Verify as qtask:"
echo "  systemctl --user status qtask@live qtask@candidate"
echo "  curl http://127.0.0.1:3003/health && curl http://127.0.0.1:3005/health"
