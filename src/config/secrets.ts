import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** Env keys treated as secrets (loaded from Vault when SECRETS_BACKEND=vault). */
export const SECRET_ENV_KEYS = [
  'JWT_SECRET',
  'ADMIN_JWT_SECRET',
  'ADMIN_PASSWORD',
  'ADMIN_PROXY_SECRET',
  'RESEND_API_KEY',
  'SMTP_USER',
  'SMTP_PASS',
  'MONGO_ROOT_USER',
  'MONGO_ROOT_PASSWORD',
  'MONGODB_URI',
] as const;

export type SecretsBackend = 'env' | 'vault';

export function resolveSecretsBackend(env: NodeJS.ProcessEnv = process.env): SecretsBackend {
  const raw = (env.SECRETS_BACKEND ?? 'env').trim().toLowerCase();
  if (raw === 'vault') return 'vault';
  if (raw === 'env' || raw === '') return 'env';
  throw new Error(`SECRETS_BACKEND must be "env" or "vault" (got "${env.SECRETS_BACKEND}")`);
}

async function readCredentialFile(name: string): Promise<string | undefined> {
  const dir = process.env.CREDENTIALS_DIRECTORY;
  if (!dir) return undefined;
  try {
    const value = await readFile(path.join(dir, name), 'utf8');
    return value.trim() || undefined;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    throw err;
  }
}

async function resolveAppRoleCredentials(): Promise<{ roleId: string; secretId: string }> {
  const roleId =
    process.env.VAULT_ROLE_ID?.trim() || (await readCredentialFile('vault_role_id'));
  const secretId =
    process.env.VAULT_SECRET_ID?.trim() || (await readCredentialFile('vault_secret_id'));

  if (!roleId || !secretId) {
    throw new Error(
      'Vault AppRole credentials missing: set VAULT_ROLE_ID and VAULT_SECRET_ID, ' +
        'or provide systemd LoadCredential vault_role_id / vault_secret_id',
    );
  }
  return { roleId, secretId };
}

function vaultAddr(): string {
  const addr = (process.env.VAULT_ADDR ?? 'http://127.0.0.1:8200').replace(/\/$/, '');
  return addr;
}

/** KV v2 API path, e.g. secret/data/qtask/production */
function vaultSecretPath(): string {
  const raw = process.env.VAULT_SECRET_PATH?.trim() || 'secret/data/qtask/production';
  return raw.replace(/^\//, '');
}

interface VaultLoginResponse {
  auth?: { client_token?: string };
  errors?: string[];
}

interface VaultKvResponse {
  data?: { data?: Record<string, unknown> };
  errors?: string[];
}

async function vaultFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = (await res.json()) as T & { errors?: string[] };
  if (!res.ok) {
    const detail = body.errors?.join('; ') || res.statusText;
    throw new Error(`Vault request failed (${res.status}): ${detail}`);
  }
  if (body.errors?.length) {
    throw new Error(`Vault error: ${body.errors.join('; ')}`);
  }
  return body;
}

async function appRoleLogin(roleId: string, secretId: string): Promise<string> {
  const body = await vaultFetch<VaultLoginResponse>(`${vaultAddr()}/v1/auth/approle/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role_id: roleId, secret_id: secretId }),
  });
  const token = body.auth?.client_token;
  if (!token) {
    throw new Error('Vault AppRole login did not return a client token');
  }
  return token;
}

async function readKvSecrets(token: string): Promise<Record<string, string>> {
  const body = await vaultFetch<VaultKvResponse>(`${vaultAddr()}/v1/${vaultSecretPath()}`, {
    headers: { 'X-Vault-Token': token },
  });
  const data = body.data?.data;
  if (!data || typeof data !== 'object') {
    throw new Error(`Vault secret at ${vaultSecretPath()} has no data`);
  }

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue;
    out[key] = String(value);
  }
  return out;
}

function warnIfSecretsPresentInEnv(): void {
  const present = SECRET_ENV_KEYS.filter((key) => {
    const v = process.env[key];
    return typeof v === 'string' && v.length > 0;
  });
  if (present.length === 0) return;
  console.warn(
    `[secrets] SECRETS_BACKEND=vault but these secrets are also set in the environment ` +
      `(remove them from .env to avoid plaintext drift): ${present.join(', ')}`,
  );
}

/**
 * Load secrets into process.env when SECRETS_BACKEND=vault.
 * Default backend is "env" (no-op — use dotenv / EnvironmentFile).
 */
export async function loadSecrets(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const backend = resolveSecretsBackend(env);
  if (backend === 'env') return;

  warnIfSecretsPresentInEnv();

  const { roleId, secretId } = await resolveAppRoleCredentials();
  const token = await appRoleLogin(roleId, secretId);
  const secrets = await readKvSecrets(token);

  for (const key of SECRET_ENV_KEYS) {
    const value = secrets[key];
    if (value !== undefined && value !== '') {
      process.env[key] = value;
    }
  }

  // Allow additional keys from Vault to flow through (forward-compatible).
  for (const [key, value] of Object.entries(secrets)) {
    if ((SECRET_ENV_KEYS as readonly string[]).includes(key)) continue;
    if (value !== undefined && value !== '') {
      process.env[key] = value;
    }
  }
}
