# Read-only access to QTask application secrets (KV v2).
path "secret/data/qtask/*" {
  capabilities = ["read"]
}

path "secret/metadata/qtask/*" {
  capabilities = ["read", "list"]
}
