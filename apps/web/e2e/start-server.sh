#!/usr/bin/env bash
# Fresh seeded database for the end-to-end tests, then the shop server serving the built screens.
set -euo pipefail
cd "$(dirname "$0")/../../server"
export DATABASE_URL="${E2E_DATABASE_URL:-postgresql://aruna:aruna@localhost:5432/aruna_e2e?schema=public}"
export PIN_SECRET="e2e-pin-secret-0123456789"
export PORT="${E2E_PORT:-3100}"
export WEB_DIST_DIR="$(cd ../web && pwd)/dist"
export DATA_DIR="/tmp/aruna-e2e-data"
export DISABLE_SCHEDULERS=1
export LOG_LEVEL=warn
DB_NAME="$(node -e 'console.log(new URL(process.env.DATABASE_URL).pathname.slice(1))')"
ADMIN_URL="$(node -e 'const u=new URL(process.env.DATABASE_URL);u.pathname="/postgres";u.search="";console.log(u.toString())')"
psql "$ADMIN_URL" -qc "DROP DATABASE IF EXISTS \"$DB_NAME\" WITH (FORCE)" -c "CREATE DATABASE \"$DB_NAME\""
npx prisma migrate deploy > /dev/null
npx tsx src/scripts/seed.ts > /dev/null
exec npx tsx src/index.ts
