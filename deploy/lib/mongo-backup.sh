#!/usr/bin/env bash
# MongoDB backup/restore helpers for qtask-deploy.
# Usage (sourced): source deploy/lib/mongo-backup.sh
set -euo pipefail

mongo_find_container() {
  local name
  name="$(docker ps --format '{{.Names}}\t{{.Ports}}' 2>/dev/null | awk -F'\t' '/127\.0\.0\.1:27017->/{print $1; exit}')"
  if [[ -z "${name}" ]]; then
    name="$(docker ps --format '{{.Names}}' --filter 'ancestor=mongo:7' 2>/dev/null | head -1)"
  fi
  if [[ -z "${name}" ]]; then
    echo "Error: MongoDB container not found (expected 127.0.0.1:27017)." >&2
    return 1
  fi
  printf '%s' "${name}"
}

mongo_build_uri() {
  local db_name="${1:-qtask}"
  local env_file="${2:-}"

  if [[ -n "${env_file}" && -f "${env_file}" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "${env_file}"
    set +a
  fi

  if [[ -n "${MONGO_ROOT_USER:-}" && -n "${MONGO_ROOT_PASSWORD:-}" ]]; then
    printf 'mongodb://%s:%s@127.0.0.1:27017/%s?authSource=admin' \
      "${MONGO_ROOT_USER}" "${MONGO_ROOT_PASSWORD}" "${db_name}"
  else
    printf 'mongodb://127.0.0.1:27017/%s' "${db_name}"
  fi
}

# Dump a database to host directory OUT_DIR (contains qtask/ subfolder).
mongo_backup_dump() {
  local out_dir="${1:?output directory}"
  local db_name="${2:-qtask}"
  local env_file="${3:-}"
  local container uri tmp_in_container

  container="$(mongo_find_container)"
  uri="$(mongo_build_uri "${db_name}" "${env_file}")"
  mkdir -p "${out_dir}"
  tmp_in_container="/tmp/qtask-dump-$$"

  echo "==> mongodump ${db_name} -> ${out_dir}"
  docker exec "${container}" rm -rf "${tmp_in_container}" 2>/dev/null || true
  docker exec "${container}" mongodump --uri="${uri}" --db="${db_name}" --out="${tmp_in_container}"
  docker cp "${container}:${tmp_in_container}/${db_name}" "${out_dir}/"
  docker exec "${container}" rm -rf "${tmp_in_container}"
  printf '%s\n' "${out_dir}"
}

# Restore from host directory SRC_DIR (expects SRC_DIR or SRC_DIR/qtask with BSON files).
mongo_backup_restore() {
  local src_dir="${1:?source directory}"
  local db_name="${2:-qtask}"
  local env_file="${3:-}"
  local drop="${4:-false}"
  local container uri restore_path tmp_in_container drop_flag=""

  container="$(mongo_find_container)"
  uri="$(mongo_build_uri "${db_name}" "${env_file}")"
  tmp_in_container="/tmp/qtask-restore-$$"

  if [[ -d "${src_dir}/${db_name}" ]]; then
    restore_path="${src_dir}/${db_name}"
  elif [[ -d "${src_dir}/qtask" && "${db_name}" == "qtask" ]]; then
    restore_path="${src_dir}/qtask"
  else
    restore_path="${src_dir}"
  fi

  if [[ "${drop}" == "true" ]]; then
    drop_flag="--drop"
  fi

  echo "==> mongorestore ${db_name} <- ${restore_path}"
  docker exec "${container}" rm -rf "${tmp_in_container}" 2>/dev/null || true
  docker exec "${container}" mkdir -p "${tmp_in_container}"
  docker cp "${restore_path}" "${container}:${tmp_in_container}/data"
  docker exec "${container}" mongorestore --uri="${uri}" ${drop_flag} --db="${db_name}" "${tmp_in_container}/data"
  docker exec "${container}" rm -rf "${tmp_in_container}"
}

# Copy live qtask dump into qtask_candidate for major deploy testing.
mongo_snapshot_to_candidate() {
  local backup_dir="${1:?backup directory}"
  local env_file="${2:-}"
  mongo_backup_restore "${backup_dir}" "qtask_candidate" "${env_file}" "true"
}

# Promote candidate DB to live (major deploy cutover).
mongo_promote_candidate_db() {
  local env_file="${1:-}"
  local container live_uri cand_uri tmp_live tmp_cand

  container="$(mongo_find_container)"
  live_uri="$(mongo_build_uri "qtask" "${env_file}")"
  cand_uri="$(mongo_build_uri "qtask_candidate" "${env_file}")"
  tmp_live="/tmp/qtask-promote-live-$$"
  tmp_cand="/tmp/qtask-promote-cand-$$"

  echo "==> Promoting qtask_candidate -> qtask (live)"
  docker exec "${container}" mongodump --uri="${cand_uri}" --db=qtask_candidate --out="${tmp_cand}"
  docker exec "${container}" mongorestore --uri="${live_uri}" --drop --db=qtask "${tmp_cand}/qtask_candidate"
  docker exec "${container}" rm -rf "${tmp_live}" "${tmp_cand}"
}
