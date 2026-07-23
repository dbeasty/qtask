#!/usr/bin/env bash
# Build app release tarball and deploy to the app server via SSH (as qtask).
# Auto-bumps patch version before building.
# Usage:
#   APP_SSH=qtask@192.168.13.13 ./scripts/publish-app-release.sh
#   ./scripts/publish-app-release.sh qtask@192.168.13.13
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

APP_SSH="${1:-${APP_SSH:-qtask@192.168.13.13}}"

echo "Bumping patch version..."
npm version patch --no-git-tag-version
npm version patch --no-git-tag-version --prefix client
npm version patch --no-git-tag-version --prefix admin-client

bash "${ROOT}/scripts/build-app-release.sh"

VERSION="$(node -p "require('./package.json').version")"
ARCHIVE="${ROOT}/release/qtask-${VERSION}-linux.tar.gz"
REMOTE_TAR="qtask-${VERSION}-linux.tar.gz"

echo ""
echo "==> Uploading to ${APP_SSH}"
scp "${ARCHIVE}" "${APP_SSH}:~/${REMOTE_TAR}"

echo "==> Deploying on app server"
ssh "${APP_SSH}" "set -euo pipefail
  cd ~
  rm -rf qtask-${VERSION}
  tar xzf ${REMOTE_TAR}
  cd qtask-${VERSION}
  ./deploy/deploy-app.sh
"

echo ""
echo "Publish complete (${APP_SSH})."
echo ""
echo "First install? Edit /opt/qtask/.env on the app server, then run publish:app again."
echo "Jetson Ollama (separate): npm run publish:jetson"
