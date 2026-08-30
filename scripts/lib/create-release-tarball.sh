#!/usr/bin/env bash
# Create a portable gzip tarball for Linux deploy hosts.
# Strips macOS extended attributes so GNU tar on Linux does not warn about
# LIBARCHIVE.xattr.com.apple.provenance headers.
#
# Usage: create-release-tarball.sh <archive-path> <parent-dir> <member-name>
set -euo pipefail

archive="${1:?archive path required}"
parent_dir="${2:?parent directory required}"
member="${3:?archive member required}"
staging="${parent_dir%/}/${member}"

if [[ ! -e "${staging}" ]]; then
  echo "Error: staging path not found: ${staging}" >&2
  exit 1
fi

mkdir -p "$(dirname "${archive}")"

if [[ "$(uname -s)" == "Darwin" ]]; then
  if command -v xattr >/dev/null 2>&1; then
    xattr -cr "${staging}" 2>/dev/null || true
  fi
  COPYFILE_DISABLE=1 tar --no-xattrs --no-acls --no-fflags -czf "${archive}" -C "${parent_dir}" "${member}"
else
  tar -czf "${archive}" -C "${parent_dir}" "${member}"
fi
