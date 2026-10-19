#!/usr/bin/env bash
# Wipes the LOCAL development database and rebuilds it: migrations, the Sunset seed, the rate card, the demo staff, the bank accounts, the tax matrix (as drafts).
# Development only — it refuses to run against anything but a database named hos_dev.
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/psql.sh
set -a; . ./.env; set +a
case "$DATABASE_URL_OWNER" in */hos_dev) ;; *) echo "refusing: DATABASE_URL_OWNER is not the hos_dev database" >&2; exit 1;; esac
hpsql "$DATABASE_URL_OWNER" -v ON_ERROR_STOP=1 -qc "DROP OWNED BY hos_owner CASCADE"
pnpm --silent db:migrate
(cd apps/api && pnpm --silent seed:sunset >/dev/null && pnpm --silent seed:sunset-rates >/dev/null && pnpm --silent seed:demo-staff && pnpm --silent seed:sunset-accounts && pnpm --silent seed:sunset-tax)
