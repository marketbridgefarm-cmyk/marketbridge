#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must be set}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
mkdir -p "$BACKUP_DIR"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUTPUT="${BACKUP_DIR}/marketbridge-${TIMESTAMP}.dump"

pg_dump "$DATABASE_URL" --format=custom --no-owner --no-privileges --file="$OUTPUT"
pg_restore --list "$OUTPUT" >/dev/null
printf 'Backup created and verified: %s\n' "$OUTPUT"

# Off-site copy: on Render (and most PaaS hosts) the local filesystem is
# ephemeral and does not survive a redeploy or restart, so a dump that only
# ever lands here can silently disappear before anyone needs it. This is
# best-effort: an unconfigured or failed upload does not fail the backup
# itself, since the verified local dump above already satisfies this
# script's core job.
if [[ -f "scripts/backupStorage.js" ]]; then
  node scripts/backupStorage.js upload "$OUTPUT" || echo 'Off-site upload failed; local backup above is still valid.'
fi

# Retention: without this, backups accumulate on disk (and off-site)
# forever. Prune anything older than RETENTION_DAYS, locally and remotely.
find "$BACKUP_DIR" -maxdepth 1 -name 'marketbridge-*.dump' -mtime "+${RETENTION_DAYS}" -print -delete 2>/dev/null || true
if [[ -f "scripts/backupStorage.js" ]]; then
  node scripts/backupStorage.js prune "$RETENTION_DAYS" || true
fi
