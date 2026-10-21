#!/usr/bin/env bash
# Restores the LOCAL development database from a backup made by backup-db.sh. REPLACES everything in the database (after backing up what is there now).
# Usage: bash scripts/restore-db.sh backups/hos_dev-YYYYMMDD-HHMMSS.dump [--yes]
# Run `pnpm db:migrate` afterwards if the backup is older than the code (it only adds what is missing).
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/psql.sh
set -a; . ./.env; set +a
case "$DATABASE_URL_OWNER" in */hos_dev) ;; *) echo "refusing: DATABASE_URL_OWNER is not the hos_dev database" >&2; exit 1;; esac
f="${1:-}"
if [ -z "$f" ] || [ ! -f "$f" ]; then echo "usage: bash scripts/restore-db.sh backups/<file>.dump [--yes]" >&2; ls -1t backups/hos_dev-*.dump 2>/dev/null | head -5 >&2 || true; exit 1; fi
[ "$(head -c 5 "$f")" = "PGDMP" ] || { echo "refusing: $f is not a backup made by backup-db.sh" >&2; exit 1; }
if [ "${2:-}" != "--yes" ] && [ "${HOS_YES:-}" != "1" ]; then
  [ -t 0 ] || { echo "refusing: this replaces the whole database; run it in a terminal, or add --yes" >&2; exit 1; }
  read -r -p "This REPLACES everything in the local database with $f. Type restore to continue: " a; [ "$a" = "restore" ] || { echo "cancelled"; exit 1; }
fi
# nothing is dropped unless the current database has been safely backed up first
if ! bash scripts/backup-db.sh; then echo "stopping: the current database could not be backed up, so nothing was changed" >&2; exit 1; fi
hpsql "$DATABASE_URL_OWNER" -v ON_ERROR_STOP=1 -qc "DROP OWNED BY hos_owner CASCADE"
hpgrestore "$(hos_super_db_url)" --exit-on-error < "$f"
echo "restored from $f"
