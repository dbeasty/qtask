#!/usr/bin/env bash
# Benchmark feedback vision classification against local Ollama.
#
# Usage:
#   ./scripts/benchmark-feedback-vision.sh
#   OLLAMA_VISION_MODEL=moondream ./scripts/benchmark-feedback-vision.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURES="${ROOT}/tests/fixtures/feedback"
MODEL="${OLLAMA_VISION_MODEL:-moondream}"
BASE_URL="${OLLAMA_VISION_BASE_URL:-http://127.0.0.1:11434}"

if [[ ! -d "${FIXTURES}" ]]; then
  echo "Missing fixtures directory: ${FIXTURES}" >&2
  exit 1
fi

shopt -s nullglob
files=("${FIXTURES}"/*.{png,jpg,jpeg,webp})
if [[ ${#files[@]} -eq 0 ]]; then
  echo "No fixture images in ${FIXTURES}" >&2
  exit 1
fi

echo "Vision base URL: ${BASE_URL}"
echo "Model: ${MODEL}"
echo

for file in "${files[@]}"; do
  echo "==> $(basename "${file}")"
  start=$(date +%s)
  node --input-type=module - "${file}" "${MODEL}" "${BASE_URL}" <<'EOF'
import fs from 'node:fs';
import path from 'node:path';

const [file, model, baseUrl] = process.argv.slice(2);
const buffer = fs.readFileSync(file);
const ext = path.extname(file).slice(1).toLowerCase();
const contentType =
  ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';

process.env.OLLAMA_VISION_BASE_URL = baseUrl;
process.env.OLLAMA_VISION_MODEL = model;
process.env.QTASK_SKIP_DOTENV = 'true';

const { classifyScreenshot } = await import('./src/services/feedbackVisionService.js');
const started = Date.now();
const result = await classifyScreenshot(buffer, contentType, 'benchmark-user');
console.log(JSON.stringify({ ...result, elapsedMs: Date.now() - started }, null, 2));
EOF
  end=$(date +%s)
  echo "wall time: $((end - start))s"
  echo
done
