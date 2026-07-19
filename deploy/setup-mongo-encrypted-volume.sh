#!/usr/bin/env bash
# Create and open a LUKS volume for MongoDB data (opt-in encryption at rest).
# Community MongoDB has no native EAR; this encrypts the host directory Docker bind-mounts.
#
# Usage (as root):
#   ./deploy/setup-mongo-encrypted-volume.sh /dev/sdX1
#   # or use a sparse file backed loop device for lab/testing:
#   ./deploy/setup-mongo-encrypted-volume.sh --file /var/lib/qtask/mongo.luks 20G
#
# Then set in .env:
#   MONGO_ENCRYPT_AT_REST=true
#   MONGO_ENCRYPT_MOUNT=/var/lib/qtask/mongo-data
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOUNT_POINT="${MONGO_ENCRYPT_MOUNT:-/var/lib/qtask/mongo-data}"
MAPPER_NAME="${MONGO_LUKS_NAME:-qtask_mongo}"
MAPPER_PATH="/dev/mapper/${MAPPER_NAME}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Error: run as root (needed for cryptsetup/mount)." >&2
  exit 1
fi

if ! command -v cryptsetup >/dev/null 2>&1; then
  echo "Error: cryptsetup not found. Install cryptsetup package." >&2
  exit 1
fi

DEVICE=""
if [[ "${1:-}" == "--file" ]]; then
  FILE_PATH="${2:?path required after --file}"
  SIZE="${3:-20G}"
  mkdir -p "$(dirname "${FILE_PATH}")"
  if [[ ! -f "${FILE_PATH}" ]]; then
    echo "Creating sparse file ${FILE_PATH} (${SIZE})"
    truncate -s "${SIZE}" "${FILE_PATH}"
    cryptsetup luksFormat --type luks2 "${FILE_PATH}"
  fi
  if ! losetup -a | grep -q "${FILE_PATH}"; then
    DEVICE="$(losetup --find --show "${FILE_PATH}")"
    echo "Loop device: ${DEVICE}"
  else
    DEVICE="$(losetup -j "${FILE_PATH}" | cut -d: -f1 | head -1)"
  fi
else
  DEVICE="${1:?Usage: $0 <block-device> | $0 --file <path> [size]}"
fi

if [[ ! -e "${MAPPER_PATH}" ]]; then
  if ! cryptsetup isLuks "${DEVICE}" 2>/dev/null; then
    echo "Formatting LUKS on ${DEVICE} (destructive for that device)"
    cryptsetup luksFormat --type luks2 "${DEVICE}"
  fi
  echo "Opening LUKS mapper ${MAPPER_NAME}"
  cryptsetup open "${DEVICE}" "${MAPPER_NAME}"
fi

if ! blkid -o value -s TYPE "${MAPPER_PATH}" 2>/dev/null | grep -q ext4; then
  echo "Creating ext4 on ${MAPPER_PATH}"
  mkfs.ext4 -L qtask_mongo "${MAPPER_PATH}"
fi

mkdir -p "${MOUNT_POINT}"
if ! findmnt -n "${MOUNT_POINT}" >/dev/null 2>&1; then
  mount "${MAPPER_PATH}" "${MOUNT_POINT}"
fi

# MongoDB container typically runs as uid 999
chown -R 999:999 "${MOUNT_POINT}"
chmod 700 "${MOUNT_POINT}"

echo ""
echo "Encrypted volume ready at ${MOUNT_POINT}"
echo "Set in /opt/qtask/.env:"
echo "  MONGO_ENCRYPT_AT_REST=true"
echo "  MONGO_ENCRYPT_MOUNT=${MOUNT_POINT}"
echo ""
echo "Persist across reboot: add crypttab + fstab entries for ${DEVICE} -> ${MAPPER_NAME} -> ${MOUNT_POINT}"
echo "Start Mongo: ${SCRIPT_DIR}/start-mongodb.sh"
