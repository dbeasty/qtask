#!/usr/bin/env bash
# Bootstrap HashiCorp Vault for QTask (AppRole + KV v2).
# Prerequisites:
#   - Vault listening at VAULT_ADDR (default http://127.0.0.1:8200)
#   - vault CLI installed
#   - For a fresh server: run `vault operator init` and `vault operator unseal` first,
#     then export VAULT_TOKEN=<root-or-admin-token>
#
# Usage:
#   export VAULT_ADDR=http://127.0.0.1:8200
#   export VAULT_TOKEN=...
#   ./deploy/vault/bootstrap.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POLICY_FILE="${SCRIPT_DIR}/policies/qtask.hcl"
VAULT_ADDR="${VAULT_ADDR:-http://127.0.0.1:8200}"
export VAULT_ADDR

if [[ -z "${VAULT_TOKEN:-}" ]]; then
  echo "Error: set VAULT_TOKEN to a root/admin token after init/unseal." >&2
  exit 1
fi

if ! command -v vault >/dev/null 2>&1; then
  echo "Error: vault CLI not found in PATH." >&2
  exit 1
fi

if [[ ! -f "${POLICY_FILE}" ]]; then
  echo "Error: missing policy file ${POLICY_FILE}" >&2
  exit 1
fi

echo "Using VAULT_ADDR=${VAULT_ADDR}"

if ! vault secrets list -format=json 2>/dev/null | grep -q '"secret/"'; then
  echo "Enabling KV v2 at secret/"
  vault secrets enable -path=secret kv-v2
else
  echo "KV mount secret/ already present"
fi

echo "Writing policy qtask"
vault policy write qtask "${POLICY_FILE}"

if ! vault auth list -format=json 2>/dev/null | grep -q '"approle/"'; then
  echo "Enabling AppRole auth"
  vault auth enable approle
else
  echo "AppRole auth already enabled"
fi

echo "Creating AppRole qtask"
vault write auth/approle/role/qtask \
  token_policies="qtask" \
  token_ttl=1h \
  token_max_ttl=4h \
  secret_id_ttl=0

SECRET_PATH="${VAULT_SECRET_PATH:-secret/qtask/production}"
# CLI path for kv put is without /data/
CLI_PATH="${SECRET_PATH#secret/data/}"
CLI_PATH="${CLI_PATH#secret/}"

if ! vault kv get "secret/${CLI_PATH}" >/dev/null 2>&1; then
  echo "Seeding placeholder secrets at secret/${CLI_PATH}"
  vault kv put "secret/${CLI_PATH}" \
    JWT_SECRET="change-me-$(openssl rand -hex 16)" \
    ADMIN_JWT_SECRET="change-me-$(openssl rand -hex 16)" \
    ADMIN_PASSWORD="change-me-admin-password" \
    ADMIN_PROXY_SECRET="" \
    RESEND_API_KEY="" \
    SMTP_USER="" \
    SMTP_PASS="" \
    MONGO_ROOT_USER="qtask" \
    MONGO_ROOT_PASSWORD="change-me-$(openssl rand -hex 12)" \
    MONGODB_URI="mongodb://qtask:change-me@127.0.0.1:27017/qtask?authSource=admin"
  echo "Edit secrets with: vault kv put secret/${CLI_PATH} key=value ..."
else
  echo "Secrets already exist at secret/${CLI_PATH} (leaving unchanged)"
fi

ROLE_ID="$(vault read -field=role_id auth/approle/role/qtask/role-id)"
SECRET_ID="$(vault write -f -field=secret_id auth/approle/role/qtask/secret-id)"

echo ""
echo "=== AppRole credentials (store with systemd-creds; do not put in .env) ==="
echo "ROLE_ID=${ROLE_ID}"
echo "SECRET_ID=${SECRET_ID}"
echo ""
echo "Encrypt for systemd (as root):"
echo "  echo -n \"${ROLE_ID}\" | systemd-creds encrypt - /etc/credstore/qtask-vault-role-id"
echo "  echo -n \"${SECRET_ID}\" | systemd-creds encrypt - /etc/credstore/qtask-vault-secret-id"
echo ""
echo "Then set in /opt/qtask/.env:"
echo "  SECRETS_BACKEND=vault"
echo "  VAULT_ADDR=${VAULT_ADDR}"
echo "  VAULT_SECRET_PATH=secret/data/${CLI_PATH}"
echo ""
echo "Remove JWT_SECRET, ADMIN_*, RESEND_API_KEY, SMTP_PASS, MONGO_ROOT_*, MONGODB_URI from .env."
echo "Optional hash mode: set ADMIN_PASSWORD_HASH + HASH_ADMIN_PASSWORD=true (npm run hash-admin-password)."
