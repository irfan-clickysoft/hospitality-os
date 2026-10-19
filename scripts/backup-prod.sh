#!/usr/bin/env bash
# Backup of the hosted database (the one in deploy/docker-compose.yml): a compressed dump, kept for KEEP_DAYS days.
# Run it from the project folder on the server, by hand or from cron:   0 2 * * *  cd /srv/hos && bash scripts/backup-prod.sh
#   BACKUP_DIR (default ./backups)   KEEP_DAYS (default 30)   COMPOSE (default: docker compose -f deploy/docker-compose.yml --env-file deploy/.env)
# A backup on the same disk is not enough: copy the files somewhere else too (another machine or cloud storage).
# Restore (tested): stop the api; create an empty database and its extensions, then load the dump —  see docs/hosting.md, "Restoring".
set -euo pipefail
cd "$(dirname "$0")/.."
COMPOSE="${COMPOSE:-docker compose -f deploy/docker-compose.yml --env-file deploy/.env}"
DIR="${BACKUP_DIR:-backups}"; KEEP="${KEEP_DAYS:-30}"
mkdir -p "$DIR"
f="$DIR/hos-$(date +%Y%m%d-%H%M%S).dump"; tmp="$f.partial"
# written under another name and kept only when complete, so a failed backup never looks like a good one
if ! $COMPOSE exec -T db pg_dump -U postgres -Fc hos > "$tmp"; then rm -f "$tmp"; echo "backup failed" >&2; exit 1; fi
if [ ! -s "$tmp" ] || [ "$(head -c 5 "$tmp")" != "PGDMP" ]; then rm -f "$tmp"; echo "backup failed: empty or unreadable dump" >&2; exit 1; fi
mv "$tmp" "$f"
find "$DIR" -name 'hos-*.dump' -mtime +"$KEEP" -delete
echo "backed up to $f ($(wc -c < "$f" | tr -d ' ') bytes)"
