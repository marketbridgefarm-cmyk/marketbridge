#!/usr/bin/env bash
set -euo pipefail

# --- Configuration & Defaults ---
DB_HOST="${POSTGRES_HOST:-localhost}"
DB_PORT="${POSTGRES_PORT:-5432}"
DB_USER="${POSTGRES_USER:-postgres}"
DB_NAME="${POSTGRES_DB:-marketbridge}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"

TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_FILE="${BACKUP_DIR}/${DB_NAME}_${TIMESTAMP}.dump"

# Ensure backup directory exists
mkdir -p "${BACKUP_DIR}"

echo "Starting PostgreSQL backup for database: ${DB_NAME}..."

# --- Execute pg_dump (Custom Format for flexibility) ---
PGPASSWORD="${POSTGRES_PASSWORD:-}" pg_dump \
  -h "${DB_HOST}" \
  -p "${DB_PORT}" \
  -U "${DB_USER}" \
  -d "${DB_NAME}" \
  -F c \
  -b \
  -v \
  -f "${BACKUP_FILE}"

echo "Backup successfully created at: ${BACKUP_FILE}"

# --- Retention Cleanup ---
echo "Cleaning up backups older than ${RETENTION_DAYS} days..."
find "${BACKUP_DIR}" -type f -name "${DB_NAME}_*.dump" -mtime +"${RETENTION_DAYS}" -delete

echo "Backup pipeline completed successfully."
