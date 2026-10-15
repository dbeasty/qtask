#!/usr/bin/env bash
# Installs the pinned KDB release's kdb-service and kdb-inspect for the systemd deployment.
#
#   sudo deploy/install-kdb.sh [--version 0.8.0] [--prefix /opt/qtask] [--no-units]
#
# - Downloads kdb-service-linux-<arch> and kdb-inspect-linux-<arch> from the GitHub release and
#   refuses to install either unless it matches the release's SHA256SUMS. Never builds anything.
# - Installs them to <prefix>/bin (kdb-service, kdb-inspect), atomically, and prints --version.
# - Creates /var/lib/qtask/kdb/data and /var/lib/qtask/backups/kdb owned by the qtask user.
# - Installs (does not enable or start) qtask-kdb.service and the qtask-kdb-backup timer.
#
# The version defaults to the @kdb/client version this checkout installs (package-lock.json): the
# client refuses a server from another release line, so the two must move together.
#
# Environment: KDB_RELEASE_BASE overrides the download URL prefix (a mirror); QTASK_USER (qtask);
# QTASK_DATA (/var/lib/qtask); SYSTEMD_DIR (/etc/systemd/system).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PREFIX=/opt/qtask
UNITS=true
VERSION=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --prefix) PREFIX="$2"; shift 2 ;;
    --no-units) UNITS=false; shift ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "${VERSION}" ]]; then
  VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["packages"]["node_modules/@kdb/client"]["version"])' "${APP_ROOT}/package-lock.json")"
fi
QTASK_USER="${QTASK_USER:-qtask}"
QTASK_DATA="${QTASK_DATA:-/var/lib/qtask}"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
BASE="${KDB_RELEASE_BASE:-https://github.com/dbeasty/kdb/releases/download/v${VERSION}}"

case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; *) echo "unsupported OS $(uname -s)" >&2; exit 1 ;; esac
case "$(uname -m)" in x86_64|amd64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; *) echo "unsupported CPU $(uname -m)" >&2; exit 1 ;; esac
[[ "${os}" == linux ]] || echo "warning: installing ${os} binaries; production runs linux" >&2

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi; }

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
echo "KDB v${VERSION} (${os}/${arch}) from ${BASE}"
curl -fsSL --retry 3 -o "${work}/SHA256SUMS" "${BASE}/SHA256SUMS"

mkdir -p "${PREFIX}/bin"
for tool in kdb-service kdb-inspect; do
  asset="${tool}-${os}-${arch}"
  curl -fsSL --retry 3 -o "${work}/${asset}" "${BASE}/${asset}"
  # SHA256SUMS lists paths like bin/<asset>; match the basename exactly.
  want="$(awk -v f="${asset}" '{ n = $2; sub(/^\*/, "", n); sub(/.*\//, "", n); if (n == f) print $1 }' "${work}/SHA256SUMS")"
  got="$(sha256 "${work}/${asset}")"
  if [[ -z "${want}" ]]; then echo "${asset} is not listed in the release's SHA256SUMS - refusing" >&2; exit 1; fi
  if [[ "${want}" != "${got}" ]]; then echo "${asset}: sha256 ${got}, release says ${want} - refusing" >&2; exit 1; fi
  chmod 755 "${work}/${asset}"
  version_line="$("${work}/${asset}" --version 2>&1 | head -1 || true)"
  case "${version_line}" in
    *"${VERSION}"*) ;;
    *) if [[ "${tool}" == kdb-service ]]; then echo "${asset} --version says '${version_line}', expected ${VERSION} - refusing" >&2; exit 1; fi ;;
  esac
  install -m 755 "${work}/${asset}" "${PREFIX}/bin/.${tool}.new"
  mv -f "${PREFIX}/bin/.${tool}.new" "${PREFIX}/bin/${tool}"
  echo "  ${PREFIX}/bin/${tool}  sha256 ${got}  ${version_line}"
done

if [[ "${UNITS}" == true ]]; then
  if ! id -u "${QTASK_USER}" >/dev/null 2>&1; then echo "user ${QTASK_USER} does not exist (run deploy/install.sh first)" >&2; exit 1; fi
  install -d -o "${QTASK_USER}" -g "${QTASK_USER}" -m 750 "${QTASK_DATA}/kdb" "${QTASK_DATA}/kdb/data" "${QTASK_DATA}/backups/kdb"
  for unit in qtask-kdb.service qtask-kdb-backup.service qtask-kdb-backup.timer; do
    install -m 644 "${SCRIPT_DIR}/${unit}" "${SYSTEMD_DIR}/${unit}"
  done
  systemctl daemon-reload 2>/dev/null || true
  cat <<EOF
Installed. Nothing is started. Next (docs/KDB_MIGRATION.md, Stage 2):
  sudo systemctl enable --now qtask-kdb
  curl -s 127.0.0.1:7701/readyz
  sudo systemctl enable --now qtask-kdb-backup.timer
EOF
fi
