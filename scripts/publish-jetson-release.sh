#!/usr/bin/env bash
# Build Jetson release tarball and deploy to the Jetson via SSH (as qtask).
# Usage:
#   JETSON_SSH=qtask@192.168.1.14 ./scripts/publish-jetson-release.sh
#   ./scripts/publish-jetson-release.sh qtask@192.168.1.14
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

JETSON_SSH="${1:-${JETSON_SSH:-qtask@192.168.1.14}}"

bash "${ROOT}/scripts/build-jetson-release.sh"

VERSION="$(node -p "require('./package.json').version")"
ARCHIVE="${ROOT}/release/qtask-ollama-${VERSION}-jetson.tar.gz"
REMOTE_TAR="qtask-ollama-${VERSION}-jetson.tar.gz"

echo ""
echo "==> Uploading to ${JETSON_SSH}"
scp "${ARCHIVE}" "${JETSON_SSH}:~/${REMOTE_TAR}"

echo "==> Deploying on Jetson"
ssh "${JETSON_SSH}" "set -euo pipefail
  cd ~
  rm -rf qtask-ollama-${VERSION}
  tar xzf ${REMOTE_TAR}
  cd qtask-ollama-${VERSION}
  ./deploy/deploy-jetson-ollama.sh
"

echo ""
echo "Publish complete (${JETSON_SSH})."
echo ""
echo "Reminder: app server deploy is separate — npm run publish:app (qtask@192.168.13.13)"
