#!/usr/bin/env bash
# Builds the Mac app into client-macos/build/QTask.app (ad hoc signed):
#
#   1. the web client (client/dist),
#   2. the backend as one bundled file (src/local/entry.ts -> dist/server.mjs) and the
#      KDB client as another,
#   3. the helper programs: a standalone Node and kdb-service,
#   4. the Swift shell, linked and wrapped into the .app.
#
#   scripts/build-macos.sh                 release build
#   CONFIG=debug scripts/build-macos.sh    debug build
#   E2E=1 scripts/build-macos.sh           also compile the end-to-end control folder
#                                          (never in a build you ship; e2e/macos/run.mjs
#                                          and perf.mjs need it)
#
# Inputs you may need to point at:
#   QTASK_NODE_BIN     a *standalone* Node (statically bundles its libraries). Homebrew's
#                      node loads libnode from the Cellar, so it cannot be copied into an
#                      app and is refused. Default: the newest ~/.gradle/nodejs/node-v*-darwin-arm64
#   KDB_SERVICE_BIN    the kdb-service binary (default: the pinned release in
#                      .kdb/<version>/kdb-service, from `npm run kdb:fetch`)
#   KDB_CLIENT_SRC     @limidus/kdb-client's entry (default: the installed release package)
#   KDB_ROOT           a kdb checkout, to bundle an unreleased build from source instead
#
# The default is the released KDB this checkout pins (package.json), the same one the
# server and tests use. KDB is read, never modified.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MAC="$ROOT/client-macos"
OUT="$MAC/build"
CONFIG="${CONFIG:-release}"
APP="$OUT/QTask.app"
cd "$ROOT"

# --- locate inputs ---------------------------------------------------------------------

if [ -n "${KDB_ROOT:-}" ]; then
  # An unreleased KDB build from a source checkout.
  KDB_SERVICE_BIN="${KDB_SERVICE_BIN:-$KDB_ROOT/go/bin/kdb-service}"
  KDB_CLIENT_SRC="${KDB_CLIENT_SRC:-$KDB_ROOT/packages/kdb-client/src/index.ts}"
else
  KDB_CLIENT_PKG="$ROOT/node_modules/@limidus/kdb-client"
  [ -f "$KDB_CLIENT_PKG/package.json" ] || { echo "@limidus/kdb-client is not installed: run npm install" >&2; exit 1; }
  KDB_VERSION="$(node -p "require('$KDB_CLIENT_PKG/package.json').version")"
  KDB_SERVICE_BIN="${KDB_SERVICE_BIN:-$ROOT/.kdb/$KDB_VERSION/kdb-service}"
  KDB_CLIENT_SRC="${KDB_CLIENT_SRC:-$KDB_CLIENT_PKG/dist/index.js}"
fi
[ -x "$KDB_SERVICE_BIN" ] || { echo "kdb-service not found at $KDB_SERVICE_BIN (run npm run kdb:fetch, or set KDB_SERVICE_BIN)" >&2; exit 1; }
[ -f "$KDB_CLIENT_SRC" ] || { echo "@limidus/kdb-client not found at $KDB_CLIENT_SRC (run npm install, or set KDB_CLIENT_SRC)" >&2; exit 1; }

NODE_BIN="${QTASK_NODE_BIN:-}"
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(ls -d "$HOME"/.gradle/nodejs/node-v*-darwin-arm64/bin/node 2>/dev/null | sort -V | tail -1 || true)"
fi
[ -x "$NODE_BIN" ] || { echo "no standalone Node found; set QTASK_NODE_BIN" >&2; exit 1; }
if otool -L "$NODE_BIN" | grep -qE '/(opt/homebrew|usr/local)/'; then
  echo "$NODE_BIN links Homebrew libraries and cannot be bundled; point QTASK_NODE_BIN at a standalone node" >&2
  exit 1
fi

ESBUILD="$ROOT/node_modules/.bin/esbuild"
[ -x "$ESBUILD" ] || { echo "run npm ci first (esbuild comes with tsx)" >&2; exit 1; }

VERSION="$(node -p "require('./package.json').version")"
COMMIT="$(git rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"
if [ "$COMMIT" != unknown ] && [ -n "$(git status --porcelain --untracked-files=no 2>/dev/null)" ]; then COMMIT="$COMMIT-dirty"; fi

echo "== QTask $VERSION ($COMMIT), $CONFIG${E2E:+, E2E control compiled in}"
rm -rf "$OUT/stage"
mkdir -p "$OUT/stage/backend/dist" "$OUT/stage/web"

# --- 1. web client ----------------------------------------------------------------------
if [ "${QTASK_MACOS_SKIP_WEB:-0}" != 1 ]; then
  (cd client && ../node_modules/.bin/tsc --noEmit 2>/dev/null || npx tsc --noEmit; npx vite build >/dev/null)
fi
[ -f client/dist/index.html ] || { echo "client/dist/index.html missing" >&2; exit 1; }
cp -R client/dist/. "$OUT/stage/web/"
# The hosted site's social-share image is not needed in a window, and 200 KB is not nothing.
rm -f "$OUT/stage/web/og-image.png" "$OUT/stage/web/robots.txt"
echo "web:     $(du -sh "$OUT/stage/web" | cut -f1)"

# --- 2. backend and KDB client bundles ---------------------------------------------------
# One ESM file each. The banner supplies `require` for the CommonJS packages inside.
# (Not __dirname: src/app.ts declares its own, and the bundle shares one scope.)
BANNER="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"
"$ESBUILD" src/local/entry.ts --bundle --platform=node --target=node22 --format=esm \
  --banner:js="$BANNER" --log-level=warning --legal-comments=none \
  --outfile="$OUT/stage/backend/dist/server.mjs"
printf '%s' "$COMMIT" > "$OUT/stage/backend/dist/GIT_SHA"
# The agent code is bundled (never run in local mode) but reads these when it is imported.
cp src/agent/context.md src/agent/context-mcp.md "$OUT/stage/backend/dist/"
node -e "const p=require('./package.json');require('fs').writeFileSync(process.argv[1],JSON.stringify({name:p.name,version:p.version,type:'module'})+'\n')" "$OUT/stage/backend/package.json"
"$ESBUILD" "$KDB_CLIENT_SRC" --bundle --platform=node --target=node22 --format=esm \
  --banner:js="$BANNER" --log-level=warning --legal-comments=none \
  --outfile="$OUT/stage/backend/kdb-client.mjs"
echo "backend: $(du -sh "$OUT/stage/backend/dist/server.mjs" | cut -f1) server.mjs, $(du -sh "$OUT/stage/backend/kdb-client.mjs" | cut -f1) kdb-client.mjs"

# --- 3. helper programs -------------------------------------------------------------------
cp "$NODE_BIN" "$OUT/stage/backend/node"
cp "$KDB_SERVICE_BIN" "$OUT/stage/backend/kdb-service"
chmod 755 "$OUT/stage/backend/node" "$OUT/stage/backend/kdb-service"
{
  echo "node:        $("$NODE_BIN" -v) ($NODE_BIN)"
  echo "kdb-service: $("$KDB_SERVICE_BIN" --version 2>&1 | head -1) ($KDB_SERVICE_BIN)"
  echo "kdb-client:  $KDB_CLIENT_SRC"
  if [ -d "$KDB_ROOT/.git" ]; then echo "kdb commit:  $(git -C "$KDB_ROOT" rev-parse --short=12 HEAD) $( [ -n "$(git -C "$KDB_ROOT" status --porcelain --untracked-files=no)" ] && echo '(working tree dirty)' )"; fi
  echo "qtask:       $VERSION $COMMIT"
} > "$OUT/stage/backend/VERSIONS.txt"
echo "helpers: node $(du -sh "$OUT/stage/backend/node" | cut -f1), kdb-service $(du -sh "$OUT/stage/backend/kdb-service" | cut -f1)"

# --- 4. the Swift shell -------------------------------------------------------------------
SWIFT_FLAGS=()
if [ "${E2E:-0}" = 1 ]; then SWIFT_FLAGS+=(-Xswiftc -DQTASK_E2E); fi
BIN_DIR="$(cd "$MAC" && swift build -c "$CONFIG" --show-bin-path)"
# SwiftPM does not notice a changed -D flag, so the binary is always relinked.
rm -f "$BIN_DIR/QTask"
(cd "$MAC" && swift build -c "$CONFIG" --product QTask ${SWIFT_FLAGS[@]+"${SWIFT_FLAGS[@]}"} 2>&1 | grep -E "error|warning: unre|Compiling|Build" | tail -5)

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN_DIR/QTask" "$APP/Contents/MacOS/QTask"
cp -R "$OUT/stage/web" "$APP/Contents/Resources/web"
cp -R "$OUT/stage/backend" "$APP/Contents/Resources/backend"
cp "$MAC/Resources/bridge.js" "$APP/Contents/Resources/bridge.js"
sed -e "s/__VERSION__/$VERSION/g" -e "s/__COMMIT__/$COMMIT/g" "$MAC/Resources/Info.plist" > "$APP/Contents/Info.plist"

# The Dock/Finder icon, from the mobile app's icon.
ICONSET="$OUT/AppIcon.iconset"
rm -rf "$ICONSET"; mkdir -p "$ICONSET"
SRC_ICON="$ROOT/mobile/assets/icon.png"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$SRC_ICON" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  sips -z "$((size * 2))" "$((size * 2))" "$SRC_ICON" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
rm -rf "$ICONSET"

# Ad hoc signing: inner programs first, then the bundle. A release is signed and notarized
# with the team's Developer ID instead (Phase 5).
for inner in "$APP/Contents/Resources/backend/node" "$APP/Contents/Resources/backend/kdb-service"; do
  codesign --force --sign - --options runtime --entitlements "$MAC/Resources/QTask.entitlements" "$inner" >/dev/null 2>&1 \
    || codesign --force --sign - "$inner" >/dev/null
done
codesign --force --sign - --entitlements "$MAC/Resources/QTask.entitlements" "$APP" >/dev/null
codesign --verify --deep --strict "$APP"

# Bluetooth (Phase 4): the permission prompt needs the usage string in Info.plist, and the sandbox
# entitlement is carried by the signature. Fail the build rather than ship an app that would be
# killed by the OS the first time it touches CoreBluetooth.
/usr/libexec/PlistBuddy -c "Print :NSBluetoothAlwaysUsageDescription" "$APP/Contents/Info.plist" >/dev/null \
  || { echo "Info.plist lacks NSBluetoothAlwaysUsageDescription" >&2; exit 1; }
# Wi-Fi sync: without both keys macOS silently blocks Bonjour and LAN connections after the first prompt.
/usr/libexec/PlistBuddy -c "Print :NSLocalNetworkUsageDescription" "$APP/Contents/Info.plist" >/dev/null \
  || { echo "Info.plist lacks NSLocalNetworkUsageDescription" >&2; exit 1; }
/usr/libexec/PlistBuddy -c "Print :NSBonjourServices:0" "$APP/Contents/Info.plist" | grep -qx "_qtask._tcp" \
  || { echo "Info.plist lacks NSBonjourServices _qtask._tcp" >&2; exit 1; }
codesign -d --entitlements :- "$APP" 2>/dev/null | grep -q "com.apple.security.network.server" \
  || { echo "the signed app lacks com.apple.security.network.server" >&2; exit 1; }
codesign -d --entitlements :- "$APP" 2>/dev/null | grep -q "com.apple.security.device.bluetooth" \
  || { echo "the signed app lacks com.apple.security.device.bluetooth" >&2; exit 1; }
rm -rf "$OUT/stage"
echo "app:     $APP ($(du -sh "$APP" | cut -f1))"
