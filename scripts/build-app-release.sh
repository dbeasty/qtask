#!/usr/bin/env bash
# Build app release tarball at the current version (no bump).
# Used by release:app for local builds; publish:app bumps first.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

VERSION="$(node -p "require('./package.json').version")"
STAGING="${ROOT}/release/qtask-${VERSION}"
ARCHIVE="${ROOT}/release/qtask-${VERSION}-linux.tar.gz"

echo "Building QTask app release ${VERSION}..."

rm -rf "${STAGING}"
mkdir -p "${STAGING}"

npm ci
npm run build
npm ci --prefix client
npm run build --prefix client
npm ci --prefix admin-client
npm run build --prefix admin-client

cp package.json package-lock.json "${STAGING}/"
cp -R dist "${STAGING}/dist"
mkdir -p "${STAGING}/client"
cp -R client/dist "${STAGING}/client/dist"
mkdir -p "${STAGING}/admin-client"
cp -R admin-client/dist "${STAGING}/admin-client/dist"
cp -R deploy "${STAGING}/deploy"

chmod +x "${STAGING}/deploy/"*.sh

mkdir -p "${ROOT}/release"
tar -czf "${ARCHIVE}" -C "${ROOT}/release" "qtask-${VERSION}"

CHECKSUM="$(shasum -a 256 "${ARCHIVE}" | awk '{print $1}')"

echo ""
echo "App release ready:"
echo "  ${ARCHIVE}"
echo "  sha256: ${CHECKSUM}"
echo ""
echo "Publish to app server (as qtask):"
echo "  ./scripts/publish-app-release.sh qtask@192.168.13.13"
echo ""
echo "Or manually:"
echo "  scp ${ARCHIVE} qtask@192.168.13.13:"
echo "  ssh qtask@192.168.13.13 'tar xzf qtask-${VERSION}-linux.tar.gz && cd qtask-${VERSION} && ./deploy/deploy-app.sh'"
