#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must be set}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

INPUT="${1:?Usage: ./scripts/restore-postgres.sh path/to/backup.dump   (or s3:<key> to pull from off-site storage first, e.g. s3:marketbridge-20260916T000000Z.dump)}"

BACKUP_FILE="$INPUT"
TMP_DOWNLOAD=""
# Registered before the download runs below (not after) — if the download
# itself fails partway, the trap still needs to be armed to clean up
# whatever mktemp already created.
#
# Must always itself exit 0, or bash silently replaces the script's real
# exit status (2 for "confirmation required", 0 for success, etc.) with
# whatever this trap's last command returned — e.g. `rm -f` on an
# empty/unset path returning non-zero would turn a successful restore
# into a reported failure.
cleanup() { rm -f -- "${TMP_DOWNLOAD}" 2>/dev/null || true; }
trap cleanup EXIT

if [[ "$INPUT" == s3:* ]]; then
  KEY="${INPUT#s3:}"
  TMP_DOWNLOAD="$(mktemp --suffix=.dump -t marketbridge-restore-XXXXXX)"
  node scripts/backupStorage.js download "$KEY" "$TMP_DOWNLOAD"
  BACKUP_FILE="$TMP_DOWNLOAD"
fi

[[ -f "$BACKUP_FILE" ]] || { echo "Backup not found: $BACKUP_FILE"; exit 1; }

if [[ "${CONFIRM_RESTORE:-}" != "YES" ]]; then
  echo 'Restore is destructive to the target database.'
  echo 'Set CONFIRM_RESTORE=YES and run again after verifying DATABASE_URL points to the intended restore target.'
  exit 2
fi

pg_restore --list "$BACKUP_FILE" >/dev/null
pg_restore --clean --if-exists --no-owner --no-privileges --dbname="$DATABASE_URL" "$BACKUP_FILE"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c 'SELECT 1;' >/dev/null
printf 'Restore completed and database connectivity verified.\n'
