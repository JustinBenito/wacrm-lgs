#!/usr/bin/env bash
# One-time local setup: install deps + apply every supabase/migrations/*.sql
# to the hosted wacrm-lgs Supabase project. Safe to re-run (migrations are
# idempotent and the CLI skips ones already applied).
set -euo pipefail
cd "$(dirname "$0")/.."

REF="wqeysbgjfhhcscvtjbpd"
HOST="aws-0-ap-northeast-2.pooler.supabase.com"   # session pooler (IPv4-safe)

echo "==> Installing dependencies (npm install)"
npm install --no-audit --no-fund

if [ -z "${SUPABASE_DB_PASSWORD:-}" ]; then
  read -r -s -p "Supabase database password (Connect -> Reset database password): " SUPABASE_DB_PASSWORD
  echo
fi
export SUPABASE_DB_PASSWORD
ENC="$(node -e 'process.stdout.write(encodeURIComponent(process.env.SUPABASE_DB_PASSWORD))')"

echo "==> Applying migrations to project ${REF}"
npx --yes supabase@latest db push --yes \
  --db-url "postgresql://postgres.${REF}:${ENC}@${HOST}:5432/postgres" \
  --include-all

echo
echo "Done. Start the app with:  npm run dev   (then open http://localhost:3000)"
