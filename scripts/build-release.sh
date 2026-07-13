#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

echo "Bumping patch version..."
npm version patch --no-git-tag-version
npm version patch --no-git-tag-version --prefix client

VERSION="$(node -p "require('./package.json').version")"
STAGING="${ROOT}/release/qtask-${VERSION}"
ARCHIVE="${ROOT}/release/qtask-${VERSION}-linux.tar.gz"

echo "Building QTask release ${VERSION}..."

rm -rf "${ROOT}/release"
mkdir -p "${STAGING}"

npm ci
npm run build
npm ci --prefix client
npm run build --prefix client

cp package.json package-lock.json "${STAGING}/"
cp -R dist "${STAGING}/dist"
mkdir -p "${STAGING}/client"
cp -R client/dist "${STAGING}/client/dist"
cp -R deploy "${STAGING}/deploy"

chmod +x "${STAGING}/deploy/install.sh" "${STAGING}/deploy/update-from-git.sh" "${STAGING}/deploy/smoke-test.sh"

mkdir -p "${ROOT}/release"
tar -czf "${ARCHIVE}" -C "${ROOT}/release" "qtask-${VERSION}"

CHECKSUM="$(shasum -a 256 "${ARCHIVE}" | awk '{print $1}')"

echo ""
echo "Release ready:"
echo "  ${ARCHIVE}"
echo "  sha256: ${CHECKSUM}"
echo ""
echo "Version bumped to ${VERSION}. Commit package.json, package-lock.json,"
echo "and client/package*.json before deploying."
echo ""
echo "Deploy:"
echo "  scp ${ARCHIVE} user@server:"
echo "  ssh user@server 'tar xzf qtask-${VERSION}-linux.tar.gz && cd qtask-${VERSION} && ./deploy/install.sh'"
