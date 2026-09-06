#!/usr/bin/env bash
# Records the git commit this build was produced from, so a running
# deployment's exact codebase can be identified from /health (see
# src/version.ts and docs/DEPLOY.md).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

SHA="$(git rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"
if [ "${SHA}" != "unknown" ] && [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  SHA="${SHA}-dirty"
fi

mkdir -p dist
printf '%s' "${SHA}" > dist/GIT_SHA
