#!/usr/bin/env bash
# Forward live + candidate app and admin ports from the app server.
#
# Usage:
#   ./scripts/tunnel-app-server.sh              # foreground (keep terminal open)
#   ./scripts/tunnel-app-server.sh -f           # background (-f -N)
#   APP_SSH=user@host ./scripts/tunnel-app-server.sh
#   npm run tunnel:app
set -euo pipefail

APP_SSH="${APP_SSH:-}"
BG=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    -f|--background) BG=true; shift ;;
    -h|--help)
      cat <<'EOF'
Usage: tunnel-app-server.sh [-f|--background]

SSH port forwards from the QTask app server to localhost:

  http://localhost:3003  stack A (live) web app
  http://localhost:3004  stack A (live) admin
  http://localhost:3005  stack B (candidate) web app
  http://localhost:3006  stack B (candidate) admin

Environment:
  APP_SSH   SSH target (required, e.g. user@host)
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "${APP_SSH}" ]]; then
  echo "Error: APP_SSH is not set. Example:" >&2
  echo "  APP_SSH=user@host ./scripts/tunnel-app-server.sh" >&2
  exit 1
fi

FORWARDS=(
  -L 3003:127.0.0.1:3003
  -L 3004:127.0.0.1:3004
  -L 3005:127.0.0.1:3005
  -L 3006:127.0.0.1:3006
)

echo "Tunneling ${APP_SSH}:"
echo "  http://localhost:3003  stack A (live) web"
echo "  http://localhost:3004  stack A (live) admin"
echo "  http://localhost:3005  stack B (candidate) web"
echo "  http://localhost:3006  stack B (candidate) admin"

if $BG; then
  exec ssh -f -N "${FORWARDS[@]}" "${APP_SSH}"
else
  exec ssh "${FORWARDS[@]}" "${APP_SSH}"
fi
