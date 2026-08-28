#!/usr/bin/env bash
# Build app release tarball and deploy to the app server via SSH.
# Auto-bumps patch version before building.
# Usage:
#   APP_SSH=user@host ./scripts/publish-app-release.sh
#   ./scripts/publish-app-release.sh user@host
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

APP_SSH="${1:-${APP_SSH:-}}"
if [[ -z "${APP_SSH}" ]]; then
  echo "Error: no deploy target set. Pass one as an argument or set APP_SSH, e.g.:" >&2
  echo "  APP_SSH=user@host ./scripts/publish-app-release.sh" >&2
  exit 1
fi

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
scp -o BatchMode=yes "${ARCHIVE}" "${APP_SSH}:~/${REMOTE_TAR}"

echo "==> Deploying on app server"
MAJOR_FLAG=""
if [[ "${QTASK_DEPLOY_MAJOR:-}" == "1" ]]; then
  MAJOR_FLAG="--major"
fi

ssh -o BatchMode=yes "${APP_SSH}" "set -euo pipefail
  TAR=\"\${HOME}/${REMOTE_TAR}\"
  DEPLOY=\"\"
  EXTRACT_DIR=\"\$(mktemp -d)\"
  trap 'rm -rf \"\${EXTRACT_DIR}\"' EXIT
  tar xzf \"\${TAR}\" -C \"\${EXTRACT_DIR}\" qtask-${VERSION}/deploy/ 2>/dev/null || true
  if [[ -x \"\${EXTRACT_DIR}/qtask-${VERSION}/deploy/qtask-deploy\" ]]; then
    DEPLOY=\"\${EXTRACT_DIR}/qtask-${VERSION}/deploy/qtask-deploy\"
  elif [[ -x /opt/qtask/live/deploy/qtask-deploy ]]; then
    DEPLOY=\"/opt/qtask/live/deploy/qtask-deploy\"
  fi
  if [[ -n \"\${DEPLOY}\" ]]; then
    \"\${DEPLOY}\" prepare ${MAJOR_FLAG} \"\${TAR}\"
    echo ''
    echo 'Candidate is ready. On the server:'
    echo '  qtask-deploy test'
    echo '  qtask-deploy promote${MAJOR_FLAG:+ --promote-db}'
  else
    cd ~
    rm -rf qtask-${VERSION}
    tar xzf ${REMOTE_TAR}
    cd qtask-${VERSION}
    ./deploy/deploy-app.sh
    echo ''
    echo 'First install complete. For A/B deploys, run once on the server:'
    echo '  qtask-deploy init'
  fi
"

echo ""
echo "Publish complete (${APP_SSH})."
echo ""
echo "On the server after first init: qtask-deploy repair  (or sudo repair-ab-deploy.sh as admin)"
echo "First install? Edit /opt/qtask/live/.env on the app server, then run publish:app again."
echo "Jetson Ollama (separate): npm run publish:jetson"
