#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

fail=0
check() {
  if "$@"; then
    echo "PASS: $*"
  else
    echo "FAIL: $*"
    fail=1
  fi
}

[[ -f package-lock.json ]] || { echo 'FAIL: backend/package-lock.json missing'; fail=1; }
node -e "const p=require('./package.json'); if(!p.dependencies.sharp) process.exit(1)" || { echo 'FAIL: sharp dependency missing from package.json'; fail=1; }
node -e "const p=require('./package-lock.json'); if(!p.packages?.['node_modules/sharp']) process.exit(1)" || { echo 'FAIL: package-lock.json does not contain sharp; run npm install and commit the regenerated lockfile'; fail=1; }
check npx prisma validate
check npx prisma migrate status

if [[ -n "${DATABASE_URL:-}" ]]; then
  check npx prisma db execute --stdin <<< 'SELECT 1;'
else
  echo 'INFO: DATABASE_URL not set; database connectivity check skipped.'
fi

if [[ "$fail" -ne 0 ]]; then
  echo 'Production validation FAILED.'
  exit 1
fi

echo 'Production validation PASSED.'
