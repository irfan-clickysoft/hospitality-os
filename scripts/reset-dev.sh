#!/usr/bin/env bash
# Wipes the LOCAL development database and rebuilds it: migrations, the Sunset seed, the rate card, the demo staff, the bank accounts, the tax matrix (as drafts).
# Development only — it refuses to run against anything but a database named hos_dev.
# If the database holds anything, it is backed up first (backups/, restore with scripts/restore-db.sh) and you are asked to confirm (add --yes to skip the question).
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/psql.sh
set -a; . ./.env; set +a
case "$DATABASE_URL_OWNER" in */hos_dev) ;; *) echo "refusing: DATABASE_URL_OWNER is not the hos_dev database" >&2; exit 1;; esac
# is there anything in the database? (read as the superuser: the tables are protected by row-level security, so the owner always sees them as empty)
if has_data="$(hpsql "$(hos_super_db_url)" -qAt -c "SELECT CASE WHEN to_regclass('public.tenant') IS NULL THEN 0 ELSE (SELECT count(*) FROM public.tenant) END" 2>/dev/null)"; then :; else has_data="unknown"; fi
if [ "$has_data" != "0" ]; then
  if [ "${1:-}" != "--yes" ] && [ "${HOS_YES:-}" != "1" ]; then
    [ -t 0 ] || { echo "refusing: the local database may hold data and this would wipe it; run in a terminal, or add --yes" >&2; exit 1; }
    read -r -p "The local database has data (or could not be checked). It will be backed up if possible, then WIPED and rebuilt with the demo data. Type wipe to continue: " a; [ "$a" = "wipe" ] || { echo "cancelled"; exit 1; }
  fi
  if [ "$has_data" = "unknown" ]; then bash scripts/backup-db.sh || echo "(no backup could be made: set PGSUPERUSER_URL to keep one)" >&2; else bash scripts/backup-db.sh; fi
fi
hpsql "$DATABASE_URL_OWNER" -v ON_ERROR_STOP=1 -qc "DROP OWNED BY hos_owner CASCADE"
pnpm --silent db:migrate
(cd apps/api && pnpm --silent seed:sunset >/dev/null && pnpm --silent seed:sunset-rates >/dev/null && pnpm --silent seed:demo-staff && pnpm --silent seed:sunset-accounts && pnpm --silent seed:sunset-tax)
