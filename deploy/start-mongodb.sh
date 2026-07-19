#!/usr/bin/env bash
# Start MongoDB for standalone / systemd deployments.
# Respects:
#   SECRETS_BACKEND=env|vault   (default env — use APP .env / env file)
#   MONGO_ENCRYPT_AT_REST=true  (optional LUKS bind mount)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${QTASK_ENV_FILE:-${APP_ROOT}/.env}"
RUN_DIR="${QTASK_RUN_DIR:-/run/qtask}"
COMPOSE_BASE="${SCRIPT_DIR}/docker-compose.mongodb.yml"
COMPOSE_ENC="${SCRIPT_DIR}/docker-compose.mongodb.encrypted.yml"

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

SECRETS_BACKEND="${SECRETS_BACKEND:-env}"
MONGO_ENCRYPT_AT_REST="${MONGO_ENCRYPT_AT_REST:-false}"
MONGO_ENCRYPT_MOUNT="${MONGO_ENCRYPT_MOUNT:-/var/lib/qtask/mongo-data}"
VAULT_ADDR="${VAULT_ADDR:-http://127.0.0.1:8200}"
VAULT_SECRET_PATH="${VAULT_SECRET_PATH:-secret/data/qtask/production}"

mkdir -p "${RUN_DIR}"
chmod 700 "${RUN_DIR}"
COMPOSE_ENV="${RUN_DIR}/mongo.env"
: > "${COMPOSE_ENV}"
chmod 600 "${COMPOSE_ENV}"

write_kv() {
  local key="$1"
  local value="$2"
  printf '%s=%s\n' "${key}" "${value}" >> "${COMPOSE_ENV}"
}

fetch_vault_secrets() {
  if ! command -v vault >/dev/null 2>&1; then
    echo "Error: vault CLI required when SECRETS_BACKEND=vault" >&2
    exit 1
  fi

  local role_id="${VAULT_ROLE_ID:-}"
  local secret_id="${VAULT_SECRET_ID:-}"
  if [[ -n "${CREDENTIALS_DIRECTORY:-}" ]]; then
    [[ -z "${role_id}" && -f "${CREDENTIALS_DIRECTORY}/vault_role_id" ]] &&
      role_id="$(tr -d '\n' < "${CREDENTIALS_DIRECTORY}/vault_role_id")"
    [[ -z "${secret_id}" && -f "${CREDENTIALS_DIRECTORY}/vault_secret_id" ]] &&
      secret_id="$(tr -d '\n' < "${CREDENTIALS_DIRECTORY}/vault_secret_id")"
  fi

  if [[ -z "${role_id}" || -z "${secret_id}" ]]; then
    echo "Error: Vault AppRole credentials missing for Mongo start script" >&2
    exit 1
  fi

  export VAULT_ADDR
  local token
  token="$(vault write -field=token auth/approle/login role_id="${role_id}" secret_id="${secret_id}")"
  export VAULT_TOKEN="${token}"

  # Strip secret/data/ prefix for `vault kv get`
  local kv_path="${VAULT_SECRET_PATH#/}"
  kv_path="${kv_path#secret/data/}"
  kv_path="${kv_path#secret/}"

  local user pass uri
  user="$(vault kv get -field=MONGO_ROOT_USER "secret/${kv_path}" 2>/dev/null || true)"
  pass="$(vault kv get -field=MONGO_ROOT_PASSWORD "secret/${kv_path}" 2>/dev/null || true)"
  uri="$(vault kv get -field=MONGODB_URI "secret/${kv_path}" 2>/dev/null || true)"

  [[ -n "${user}" ]] && write_kv MONGO_ROOT_USER "${user}"
  [[ -n "${pass}" ]] && write_kv MONGO_ROOT_PASSWORD "${pass}"
  [[ -n "${uri}" ]] && write_kv MONGODB_URI "${uri}"
  write_kv MONGO_ENCRYPT_MOUNT "${MONGO_ENCRYPT_MOUNT}"
}

if [[ "${SECRETS_BACKEND}" == "vault" ]]; then
  fetch_vault_secrets
else
  [[ -n "${MONGO_ROOT_USER:-}" ]] && write_kv MONGO_ROOT_USER "${MONGO_ROOT_USER}"
  [[ -n "${MONGO_ROOT_PASSWORD:-}" ]] && write_kv MONGO_ROOT_PASSWORD "${MONGO_ROOT_PASSWORD}"
  write_kv MONGO_ENCRYPT_MOUNT "${MONGO_ENCRYPT_MOUNT}"
fi

COMPOSE_FILE="${COMPOSE_BASE}"
if [[ "${MONGO_ENCRYPT_AT_REST}" == "true" ]]; then
  if [[ ! -d "${MONGO_ENCRYPT_MOUNT}" ]]; then
    echo "Error: MONGO_ENCRYPT_AT_REST=true but mount missing: ${MONGO_ENCRYPT_MOUNT}" >&2
    echo "Run: sudo ${SCRIPT_DIR}/setup-mongo-encrypted-volume.sh" >&2
    exit 1
  fi
  if ! findmnt -n "${MONGO_ENCRYPT_MOUNT}" >/dev/null 2>&1; then
    echo "Warning: ${MONGO_ENCRYPT_MOUNT} exists but does not look mounted; continuing." >&2
  fi
  COMPOSE_FILE="${COMPOSE_ENC}"
fi

echo "Starting MongoDB (SECRETS_BACKEND=${SECRETS_BACKEND}, MONGO_ENCRYPT_AT_REST=${MONGO_ENCRYPT_AT_REST})"
docker compose -f "${COMPOSE_FILE}" --env-file "${COMPOSE_ENV}" up -d

# Avoid leaving vault-sourced passwords on disk longer than needed for compose create
if [[ "${SECRETS_BACKEND}" == "vault" ]]; then
  shred -u "${COMPOSE_ENV}" 2>/dev/null || rm -f "${COMPOSE_ENV}"
fi
