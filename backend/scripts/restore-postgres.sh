#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must be set}"
BACKUP_FILE="${1:?Usage: ./scripts/restore-postgres.sh path/to/backup.dump}"
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
