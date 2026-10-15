#!/usr/bin/env bash
# Online backup of qtask's KDB namespace, verified, with retention.
#
#   deploy/kdb-backup.sh [backup|verify ID|list|prune]       (default: backup, then prune)
#
# KDB v0.8.0's supported backup is a manifest-defined copy of the namespace's delta log: sealed
# segments whole (content-addressed, shared between backups), the segment still being written as
# its CRC-verified prefix, and a manifest written last. Two ways to take one:
#   - online, through kdb-service's control plane (POST /v1/ns/{ns}/backups) - what this script
#     does. Consistency: everything acknowledged before the backup started is in it; a write that
#     lands during it may or may not be. Requires --control-addr, --control-write and
#     --control-backup-dir on kdb-service (deploy/qtask-kdb.service, docker-compose.kdb.yml).
#   - offline, `kdb-inspect backup --data-dir ... --to DIR`, which needs kdb-service stopped
#     (it takes the data directory's lock). Without --namespace it also captures KDB's internal
#     _kdb/meta namespace; the online one does not (see "what a restore needs" below).
#
# Every backup is verified straight away (the server re-reads every object against the hash the
# manifest records); an unverified backup is reported as a failure.
#
# Restore is offline and goes to a NEW data directory - see scripts/kdb-restore-drill.ts, which
# rehearses the whole path, and docs/KDB_MIGRATION.md:
#   kdb-inspect restore --namespace qtask/docs --from-backup <backup dir> --backup-id <id> --out <new data dir>
# What a restore needs besides the backup: the namespace's unique constraints and lookup indexes
# live in KDB's _kdb/meta namespace, which this backup does not carry. The qtask store declares
# them again on connect (DATA_KDB_DECLARE_CONSTRAINTS / DATA_KDB_DECLARE_INDEXES, on by default).
#
# Configuration (environment; the systemd unit sets none, so the defaults are the production ones):
#   KDB_CONTROL_URL      http://127.0.0.1:7702         the control plane (deploy/qtask-kdb.service)
#   KDB_NAMESPACE        qtask/docs                    = KDB_NAMESPACE_PREFIX
#   KDB_BACKUP_DIR       /var/lib/qtask/backups/kdb    = kdb-service --control-backup-dir, for prune
#   KDB_CONTROL_AUTH     qtask:unused                  user:password sent as Basic auth. Without
#                                                      --rbac kdb-service accepts any, but it does
#                                                      require the header.
#   KDB_RETENTION_DAYS   14   backups older than this are pruned...
#   KDB_RETENTION_MIN    3    ...but never the newest this many
#   KDB_COMPOSE          unset; for the docker-compose deployment, the compose command prefix,
#                        e.g. "docker compose -f docker-compose.yml -f docker-compose.kdb.yml".
#                        Requests and prune then run inside the kdb container (busybox wget/sh),
#                        against its loopback control plane on 127.0.0.1:9094 and /var/backups/kdb.
set -euo pipefail

NS="${KDB_NAMESPACE:-qtask/docs}"
NS_PATH="${NS//\//%2F}"
AUTH="${KDB_CONTROL_AUTH:-qtask:unused}"
RETENTION_DAYS="${KDB_RETENTION_DAYS:-14}"
RETENTION_MIN="${KDB_RETENTION_MIN:-3}"
if [[ -n "${KDB_COMPOSE:-}" ]]; then
  CONTROL_URL="${KDB_CONTROL_URL:-http://127.0.0.1:9094}"
  BACKUP_DIR="${KDB_BACKUP_DIR:-/var/backups/kdb}"
else
  CONTROL_URL="${KDB_CONTROL_URL:-http://127.0.0.1:7702}"
  BACKUP_DIR="${KDB_BACKUP_DIR:-/var/lib/qtask/backups/kdb}"
fi

log() { echo "kdb-backup: $*" >&2; }
die() { log "ERROR: $*"; exit 1; }

# POST/GET against the control plane; prints the JSON body. Non-2xx is an error.
request() {
  local method="$1" path="$2" auth
  auth="$(printf '%s' "${AUTH}" | base64 | tr -d '\n')"
  if [[ -n "${KDB_COMPOSE:-}" ]]; then
    # busybox wget: --post-data makes it a POST.
    if [[ "${method}" == POST ]]; then
      # shellcheck disable=SC2086
      ${KDB_COMPOSE} exec -T kdb wget -q -O - --header "Authorization: Basic ${auth}" \
        --header 'Content-Type: application/json' --post-data '{}' "${CONTROL_URL}${path}"
    else
      # shellcheck disable=SC2086
      ${KDB_COMPOSE} exec -T kdb wget -q -O - --header "Authorization: Basic ${auth}" "${CONTROL_URL}${path}"
    fi
  elif [[ "${method}" == POST ]]; then
    curl -fsS -X POST -H "Authorization: Basic ${auth}" -H 'Content-Type: application/json' --data '{}' "${CONTROL_URL}${path}"
  else
    curl -fsS -H "Authorization: Basic ${auth}" "${CONTROL_URL}${path}"
  fi
}

json_field() { # json_field <name> : first string or number value of "name" in stdin
  sed -n "s/.*\"$1\":[[:space:]]*\"\{0,1\}\([^\",}]*\)\"\{0,1\}.*/\1/p" | head -1
}

cmd_backup() {
  local started reply id size took clean
  started=$(date +%s)
  reply="$(request POST "/v1/ns/${NS_PATH}/backups")" || die "backup request failed (is kdb-service running with --control-addr/--control-write/--control-backup-dir?)"
  id="$(json_field backupId <<<"${reply}")"
  [[ -n "${id}" ]] || die "no backupId in reply: ${reply}"
  size="$(json_field sizeBytes <<<"${reply}")"
  took="$(json_field tookMs <<<"${reply}")"
  log "backup ${id}: ${size} bytes in ${took} ms ($(json_field commitCount <<<"${reply}") commits, $(json_field segments <<<"${reply}") segments)"
  cmd_verify "${id}"
  log "done in $(( $(date +%s) - started ))s"
  echo "${id}"
}

cmd_verify() {
  local id="${1:?backup id required}" reply
  reply="$(request POST "/v1/ns/${NS_PATH}/backups/${id}/verify")" || die "verify request for ${id} failed"
  if [[ "$(json_field clean <<<"${reply}")" != "true" ]]; then die "backup ${id} did NOT verify: ${reply}"; fi
  log "backup ${id} verified: $(json_field objects <<<"${reply}") objects, clean"
}

cmd_list() { request GET "/v1/ns/${NS_PATH}/backups"; echo; }

# Prune: drop backups past retention (always keeping the newest RETENTION_MIN), then delete the
# shared segment objects no remaining manifest names. Objects younger than an hour are never
# deleted, so a backup being written right now (its manifest goes last) cannot lose its segments.
# POSIX sh + grep/sed/find only, so the same script runs on the host or in the busybox container.
PRUNE_SH='
set -eu
dir="$1"; ns="$2"; days="$3"; keep="$4"
mroot="$dir/backups/$ns"
[ -d "$mroot" ] || { echo "kdb-backup: nothing to prune in $mroot" >&2; exit 0; }
# Backup ids are UUIDs, so order by the mtime of each backup directory, newest first.
ids=$(ls -1t "$mroot")
n=0; removed=0
for id in $ids; do
  [ -f "$mroot/$id/manifest.json" ] || continue
  n=$((n + 1))
  [ "$n" -le "$keep" ] && continue
  if [ -n "$(find "$mroot/$id/manifest.json" -mtime +"$days" 2>/dev/null)" ]; then
    rm -rf "$mroot/$id"; removed=$((removed + 1))
  fi
done
refs=$(mktemp)
cat "$mroot"/*/manifest.json 2>/dev/null | grep -o "\"key\": *\"[^\"]*\"" | sed "s/.*\"\([^\"]*\)\"$/\1/" | sort -u > "$refs"
swept=0
if [ -d "$dir/backup-segments/$ns" ]; then
  for f in $(find "$dir/backup-segments/$ns" -type f -mmin +60); do
    key=${f#"$dir"/}
    if ! grep -qxF "$key" "$refs"; then rm -f "$f"; swept=$((swept + 1)); fi
  done
fi
rm -f "$refs"
echo "kdb-backup: pruned $removed backup(s), $swept unreferenced segment object(s); $(ls -1 "$mroot" | wc -l | tr -d " ") backup(s) kept" >&2
'

cmd_prune() {
  if [[ -n "${KDB_COMPOSE:-}" ]]; then
    # shellcheck disable=SC2086
    ${KDB_COMPOSE} exec -T kdb sh -c "${PRUNE_SH}" prune "${BACKUP_DIR}" "${NS}" "${RETENTION_DAYS}" "${RETENTION_MIN}"
  else
    sh -c "${PRUNE_SH}" prune "${BACKUP_DIR}" "${NS}" "${RETENTION_DAYS}" "${RETENTION_MIN}"
  fi
}

case "${1:-backup}" in
  backup) cmd_backup; cmd_prune ;;
  verify) shift; cmd_verify "$@" ;;
  list) cmd_list ;;
  prune) cmd_prune ;;
  *) die "usage: kdb-backup.sh [backup|verify ID|list|prune]" ;;
esac
