#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

VERSION="$(node -p "require('./package.json').version")"
STAGING="${ROOT}/release/qtask-ollama-${VERSION}"
ARCHIVE="${ROOT}/release/qtask-ollama-${VERSION}-jetson.tar.gz"

JETSON_FILES=(
  docker-compose.jetson.yml
  start-ollama-jetson.sh
  stop-ollama-jetson.sh
  deploy-jetson-ollama.sh
  qtask-ollama.service
  .env.jetson.example
  install-jetson-ollama.sh
)

LIB_FILES=(
  lib/docker-compose.sh
)

echo "Building Jetson Ollama release ${VERSION}..."

rm -rf "${STAGING}"
mkdir -p "${STAGING}/deploy/lib"

for f in "${JETSON_FILES[@]}"; do
  cp "deploy/${f}" "${STAGING}/deploy/"
done
for f in "${LIB_FILES[@]}"; do
  cp "deploy/${f}" "${STAGING}/deploy/${f}"
done
cp -R deploy/jetson-gpu-stats "${STAGING}/deploy/"

chmod +x \
  "${STAGING}/deploy/start-ollama-jetson.sh" \
  "${STAGING}/deploy/stop-ollama-jetson.sh" \
  "${STAGING}/deploy/deploy-jetson-ollama.sh" \
  "${STAGING}/deploy/install-jetson-ollama.sh" \
  "${STAGING}/deploy/lib/docker-compose.sh"

mkdir -p "${ROOT}/release"
tar -czf "${ARCHIVE}" -C "${ROOT}/release" "qtask-ollama-${VERSION}"

CHECKSUM="$(shasum -a 256 "${ARCHIVE}" | awk '{print $1}')"

echo ""
echo "Jetson release ready:"
echo "  ${ARCHIVE}"
echo "  sha256: ${CHECKSUM}"
echo ""
echo "Deploy on Jetson (as qtask):"
echo "  ./scripts/publish-jetson-release.sh qtask@192.168.1.14"
echo ""
echo "Or manually:"
echo "  scp ${ARCHIVE} qtask@192.168.1.14:"
echo "  ssh qtask@192.168.1.14 'tar xzf qtask-ollama-${VERSION}-jetson.tar.gz && cd qtask-ollama-${VERSION} && ./deploy/deploy-jetson-ollama.sh'"
