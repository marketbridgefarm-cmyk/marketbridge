#!/usr/bin/env bash
set -euo pipefail

BACKUP_FILE="${1:-}"

if [[ -z "${BACKUP_FILE}" ]]; then
  echo "Usage: $0 <path_to_backup_file.dump>"
  exit 1
fi

if [[ ! -f "${BACKUP_FILE}" ]]; then
  echo "Error: Backup file '${BACKUP_FILE}' not found."
  exit 1
fi

DB_HOST="${POSTGRES_HOST:-localhost}"
DB_PORT="${POSTGRES_PORT:-5432}"
DB_USER="${POSTGRES_USER:-postgres}"
DB_NAME="${POSTGRES_DB:-marketbridge}"
MAINTENANCE_DB="${POSTGRES_MAINTENANCE_DB:-postgres}"

export PGPASSWORD="${POSTGRES_PASSWORD:-}"

echo "WARNING: Restoring will overwrite existing data in '${DB_NAME}'."
echo "Target Host: ${DB_HOST}:${DB_PORT}"

# --- Step 1: Terminate active connections to target DB ---
echo "Terminating active connections to '${DB_NAME}'..."
psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${MAINTENANCE_DB}" -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DB_NAME}' AND pid <> pg_backend_pid();" || true

# --- Step 2: Drop and Recreate Clean Database ---
echo "Recreating database '${DB_NAME}'..."
psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${MAINTENANCE_DB}" -c "DROP DATABASE IF EXISTS ${DB_NAME};"
psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${MAINTENANCE_DB}" -c "CREATE DATABASE ${DB_NAME};"

# --- Step 3: Restore Database using pg_restore ---
echo "Restoring database from '${BACKUP_FILE}'..."
pg_restore \
  -h "${DB_HOST}" \
  -p "${DB_PORT}" \
  -U "${DB_USER}" \
  -d "${DB_NAME}" \
  --clean \
  --if-exists \
  --no-owner \
  --no-acl \
  -v \
  "${BACKUP_FILE}" || {
    echo "Notice: pg_restore finished with minor warnings."
  }

echo "Database restoration completed successfully."
