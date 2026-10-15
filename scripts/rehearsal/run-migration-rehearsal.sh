#!/usr/bin/env bash
# Production-scale rehearsal of the MongoDB -> KDB migration, on SYNTHETIC data.
#
#   scripts/rehearsal/run-migration-rehearsal.sh [--tasks N] [--skip-generate] [--keep]
#
# What it does, in order (docs/KDB_MIGRATION.md, Stage 0 and Stage 2):
#   1. MongoDB 7 in a container (qtask-rehearsal-mongo), filled by generate-mongo.ts at --tasks
#      scale unless --skip-generate.
#   2. kdb-service from the pinned KDB release, run in a Linux container (the release's
#      linux/<arch> binary, checked against SHA256SUMS) with the production unit's flags:
#      on disk, --durability sync, --expire-field _expireAt. Fresh data volume each run.
#   3. npm run migrate:kdb -- counts; declare + backfill (order: INDEX_ORDER); verify. Each step timed. kdb-service RSS sampled every 2 s throughout (VmRSS of the
#      service process in the container).
#   4. Disk size on each side; read latencies of the hot queries (bench-reads.ts) on both.
#
# Results go to $OUT (default .rehearsal/<timestamp>/): one log per step plus summary.txt.
# Nothing here touches anything but its own two containers and one volume.
#
# Environment: MONGO_PORT (8240), KDB_PORT (8250), KDB_CPUS (4), KDB_MEMORY (4g), MONGO_CPUS (2),
# INDEX_ORDER (before: declare on the empty namespace, then backfill; after: backfill with
# DATA_KDB_DECLARE_INDEXES=false, then declare).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TASKS=100000
GENERATE=true
KEEP=false
REUSE=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tasks) TASKS="$2"; shift 2 ;;
    --skip-generate) GENERATE=false; shift ;;
    --keep) KEEP=true; shift ;;
    # Restart kdb-service on the data a previous --keep run loaded, skip the load, verify and bench.
    --reuse-kdb) REUSE=true; GENERATE=false; KEEP=true; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

MONGO_PORT="${MONGO_PORT:-8240}"
KDB_PORT="${KDB_PORT:-8250}"
KDB_CPUS="${KDB_CPUS:-4}"
KDB_MEMORY="${KDB_MEMORY:-4g}"
# What the production unit sets. 0 = kdb-service's own default (the container's whole limit).
KDB_MEMORY_BUDGET_MB="${KDB_MEMORY_BUDGET_MB:-1536}"
MONGO_CPUS="${MONGO_CPUS:-2}"
# before: declare indexes on the empty namespace, then backfill (default); after: the reverse.
INDEX_ORDER="${INDEX_ORDER:-before}"
MONGO_NAME=qtask-rehearsal-mongo
KDB_NAME=qtask-rehearsal-kdb
KDB_VOLUME=qtask-rehearsal-kdb-data
DB="qtask_rehearsal_${TASKS}"
NS=qtask/docs
OUT="${OUT:-${ROOT}/.rehearsal/$(date +%Y%m%d-%H%M%S)-${TASKS}}"
mkdir -p "${OUT}"
SUMMARY="${OUT}/summary.txt"
log() { echo "$*" | tee -a "${SUMMARY}"; }
now() { perl -MTime::HiRes=time -e 'printf "%.3f", time'; }

# --- the KDB release binary for the container's platform ------------------------------------
KDB_VERSION="$(node -p "require('${ROOT}/node_modules/@kdb/client/package.json').version")"
case "$(uname -m)" in arm64|aarch64) ARCH=arm64 ;; x86_64|amd64) ARCH=amd64 ;; *) echo "unsupported arch" >&2; exit 1 ;; esac
BIN_DIR="${ROOT}/.kdb/${KDB_VERSION}/linux-${ARCH}"
if [[ ! -x "${BIN_DIR}/kdb-service" ]]; then
  mkdir -p "${BIN_DIR}"
  base="https://github.com/dbeasty/kdb/releases/download/v${KDB_VERSION}"
  curl -fsSL -o "${BIN_DIR}/SHA256SUMS" "${base}/SHA256SUMS"
  curl -fsSL -o "${BIN_DIR}/kdb-service.partial" "${base}/kdb-service-linux-${ARCH}"
  want="$(awk -v f="kdb-service-linux-${ARCH}" '$2 ~ ("(^|/)" f "$") {print $1}' "${BIN_DIR}/SHA256SUMS")"
  got="$(shasum -a 256 "${BIN_DIR}/kdb-service.partial" | awk '{print $1}')"
  [[ -n "${want}" && "${want}" == "${got}" ]] || { echo "checksum mismatch for kdb-service-linux-${ARCH}: ${got} vs ${want}" >&2; exit 1; }
  chmod 755 "${BIN_DIR}/kdb-service.partial"
  mv "${BIN_DIR}/kdb-service.partial" "${BIN_DIR}/kdb-service"
fi

log "# KDB migration rehearsal - SYNTHETIC data (scripts/rehearsal/dataset.ts), not production"
log "date: $(date -u +%Y-%m-%dT%H:%M:%SZ)  host: $(uname -sm), $(sysctl -n hw.ncpu 2>/dev/null || nproc) cpus"
log "index order: ${INDEX_ORDER}"
log "tasks: ${TASKS}  kdb-service v${KDB_VERSION} linux-${ARCH} in a container (cpus=${KDB_CPUS}, memory=${KDB_MEMORY})  mongo:7 (cpus=${MONGO_CPUS})"

# --- MongoDB ------------------------------------------------------------------------------
if ! docker ps --format '{{.Names}}' | grep -qx "${MONGO_NAME}"; then
  docker rm -f "${MONGO_NAME}" >/dev/null 2>&1 || true
  docker run -d --name "${MONGO_NAME}" --cpus "${MONGO_CPUS}" -p "127.0.0.1:${MONGO_PORT}:27017" mongo:7 >/dev/null
  until docker exec "${MONGO_NAME}" mongosh --quiet --eval 'db.runCommand({ping:1}).ok' >/dev/null 2>&1; do sleep 1; done
fi
export MONGODB_URI="mongodb://127.0.0.1:${MONGO_PORT}/${DB}"
export JWT_SECRET=rehearsal ADMIN_JWT_SECRET=rehearsal MCP_OAUTH_JWT_SECRET=rehearsal
cd "${ROOT}"
if [[ "${GENERATE}" == true ]]; then
  t0=$(date +%s)
  npx tsx scripts/rehearsal/generate-mongo.ts --tasks="${TASKS}" --drop | tee "${OUT}/generate.log"
  log "generate: $(( $(date +%s) - t0 ))s"
fi

# --- kdb-service ----------------------------------------------------------------------------
docker rm -f "${KDB_NAME}" >/dev/null 2>&1 || true
if [[ "${REUSE}" != true ]]; then
  docker volume rm "${KDB_VOLUME}" >/dev/null 2>&1 || true
  docker volume create "${KDB_VOLUME}" >/dev/null
fi
open_started=$(date +%s)
docker run -d --name "${KDB_NAME}" --cpus "${KDB_CPUS}" --memory "${KDB_MEMORY}" \
  -p "127.0.0.1:${KDB_PORT}:7700" -v "${KDB_VOLUME}:/var/lib/kdb" -v "${BIN_DIR}:/opt/kdb:ro" \
  alpine:3.20 /opt/kdb/kdb-service \
    --data-dir /var/lib/kdb --namespace "${NS}" \
    --sql-addr "tcp://0.0.0.0:7700?bind=true" --admin-addr 127.0.0.1:7701 \
    --peer-addr "" --stream-addr "" \
    --expire-field _expireAt --expire-interval 1m --durability sync \
    --memory-budget-mb "${KDB_MEMORY_BUDGET_MB}" \
    --log-format json --log-level warn >/dev/null
until docker exec "${KDB_NAME}" wget -q -O /dev/null http://127.0.0.1:7701/readyz 2>/dev/null; do sleep 0.5; done
log "kdb-service: $(docker exec "${KDB_NAME}" /opt/kdb/kdb-service --version); memory budget ${KDB_MEMORY_BUDGET_MB} MiB; ready in $(( $(date +%s) - open_started ))s"

PHASE_FILE="${OUT}/.phase"
echo idle > "${PHASE_FILE}"
( while docker exec "${KDB_NAME}" true 2>/dev/null; do
    rss=$(docker exec "${KDB_NAME}" awk '/VmRSS/{print $2}' /proc/1/status 2>/dev/null || echo "")
    [[ -n "${rss}" ]] && echo "$(date +%s),$(cat "${PHASE_FILE}"),${rss}" >> "${OUT}/rss.csv"
    sleep 2
  done ) &
SAMPLER=$!
trap 'kill ${SAMPLER} 2>/dev/null || true' EXIT

export KDB_ADDR="tcp://127.0.0.1:${KDB_PORT}" KDB_NAMESPACE_PREFIX="${NS}"
step() {
  local name="$1"; shift
  echo "${name}" > "${PHASE_FILE}"
  local t0 t1
  t0=$(now)
  set +e
  "$@" 2>&1 | tee "${OUT}/${name}.log"
  local status=${PIPESTATUS[0]}
  set -e
  t1=$(now)
  log "${name}: $(awk -v a="${t0}" -v b="${t1}" 'BEGIN{printf "%.1f", b-a}')s (exit ${status})"
  echo idle > "${PHASE_FILE}"
  return 0
}

# A slow statement is a measurement here, not a failure: the client's 30 s default would cut it off.
export KDB_REQUEST_TIMEOUT_MS="${KDB_REQUEST_TIMEOUT_MS:-3600000}"
if [[ "${REUSE}" == true ]]; then
  log "reusing the data a previous run loaded: no counts, declare or backfill"
elif [[ "${INDEX_ORDER}" == after ]]; then
  step counts npm run -s migrate:kdb -- counts
  # The order docs/KDB_MIGRATION.md used to recommend: load without indexes, then build them.
  step backfill env DATA_KDB_DECLARE_INDEXES=false npm run -s migrate:kdb -- backfill
  step declare npm run -s migrate:kdb -- declare
else
  step counts npm run -s migrate:kdb -- counts
  # Indexes declared on the empty namespace and maintained through the load.
  step declare npm run -s migrate:kdb -- declare
  step backfill npm run -s migrate:kdb -- backfill
fi
step verify npm run -s migrate:kdb -- verify
grep -hE 'TOTAL|DIFFERS|verified in|declared' "${OUT}"/{counts,backfill,declare,verify}.log 2>/dev/null | sed 's/^/  /' | tee -a "${SUMMARY}" || true
if ! docker exec "${KDB_NAME}" true 2>/dev/null; then
  log "kdb-service is NOT running: $(docker inspect "${KDB_NAME}" --format 'exit={{.State.ExitCode}} oomKilled={{.State.OOMKilled}}')"
  exit 1
fi

# --- sizes ----------------------------------------------------------------------------------
sleep 3
log "kdb data dir: $(docker exec "${KDB_NAME}" du -sh /var/lib/kdb | awk '{print $1}')"
docker exec "${KDB_NAME}" sh -c 'du -sh /var/lib/kdb/ns/qtask/docs/* 2>/dev/null' | sed 's/^/  /' | tee -a "${SUMMARY}"
log "mongo: $(docker exec "${MONGO_NAME}" mongosh --quiet "${DB}" --eval 'const s=db.stats(); print(`dataSize=${(s.dataSize/1048576).toFixed(1)}MiB storageSize=${(s.storageSize/1048576).toFixed(1)}MiB indexSize=${(s.indexSize/1048576).toFixed(1)}MiB objects=${s.objects}`)')"

# --- read latencies ---------------------------------------------------------------------------
step bench-mongo npx tsx scripts/rehearsal/bench-reads.ts --tasks="${TASKS}"
step bench-kdb env DATA_KDB=true DATA_KDB_PUSHDOWN=true npx tsx scripts/rehearsal/bench-reads.ts --tasks="${TASKS}"
# Last: without pushdown every read scans its whole collection, which at scale may take the service down (B5).
step bench-kdb-nopushdown env DATA_KDB=true DATA_KDB_PUSHDOWN=false npx tsx scripts/rehearsal/bench-reads.ts --tasks="${TASKS}" --iterations=5
log "kdb-service after the benches: $(docker inspect "${KDB_NAME}" --format 'running={{.State.Running}} exit={{.State.ExitCode}} oomKilled={{.State.OOMKilled}}')"

# --- memory -------------------------------------------------------------------------------
kill "${SAMPLER}" 2>/dev/null || true
log "kdb-service RSS by phase (MiB, sampled every 2 s):"
for phase in $(cut -d, -f2 "${OUT}/rss.csv" | sort -u); do
  vals="$(awk -F, -v p="${phase}" '$2==p {print $3}' "${OUT}/rss.csv" | sort -n)"
  n=$(echo "${vals}" | wc -l | tr -d ' ')
  max=$(echo "${vals}" | tail -1)
  med=$(echo "${vals}" | sed -n "$(( (n + 1) / 2 ))p")
  printf "  %-22s max %7.1f  median %7.1f  (%s samples)\n" "${phase}" "$(echo "${max} / 1024" | bc -l)" "$(echo "${med} / 1024" | bc -l)" "${n}" | tee -a "${SUMMARY}"
done

if [[ "${KEEP}" != true ]]; then
  docker rm -f "${KDB_NAME}" >/dev/null
  docker volume rm "${KDB_VOLUME}" >/dev/null
  log "removed ${KDB_NAME} and its volume (MongoDB container ${MONGO_NAME} kept for re-runs with --skip-generate)"
fi
log "results: ${OUT}"
