#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must be set}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
mkdir -p "$BACKUP_DIR"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUTPUT="${BACKUP_DIR}/marketbridge-${TIMESTAMP}.dump"

pg_dump "$DATABASE_URL" --format=custom --no-owner --no-privileges --file="$OUTPUT"
pg_restore --list "$OUTPUT" >/dev/null
printf 'Backup created and verified: %s\n' "$OUTPUT"
