#!/usr/bin/env bash
# Backs up the LOCAL development database to backups/hos_dev-<date>-<time>.dump (a compressed PostgreSQL dump) and keeps the newest 30.
# Needs the database superuser (PGSUPERUSER_URL, the same as bootstrap-db.sh; the default fits the Docker database).
# Usage: bash scripts/backup-db.sh            (restore with: bash scripts/restore-db.sh backups/<file>)
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/psql.sh
set -a; . ./.env; set +a
case "$DATABASE_URL_OWNER" in */hos_dev) ;; *) echo "refusing: DATABASE_URL_OWNER is not the hos_dev database" >&2; exit 1;; esac
mkdir -p backups
f="backups/hos_dev-$(date +%Y%m%d-%H%M%S).dump"
tmp="$f.partial"
# written under another name and only renamed when complete and readable, so a failed backup never leaves a file that looks like a good one
if ! hpgdump "$(hos_super_db_url)" -Fc > "$tmp"; then rm -f "$tmp"; echo "backup failed: could not read the database (is PGSUPERUSER_URL right?)" >&2; exit 1; fi
if [ ! -s "$tmp" ] || [ "$(head -c 5 "$tmp")" != "PGDMP" ]; then rm -f "$tmp"; echo "backup failed: the dump is empty or unreadable" >&2; exit 1; fi
mv "$tmp" "$f"
ls -1t backups/hos_dev-*.dump 2>/dev/null | tail -n +31 | while read -r old; do rm -f "$old"; done
echo "backed up to $f ($(wc -c < "$f" | tr -d ' ') bytes)"
