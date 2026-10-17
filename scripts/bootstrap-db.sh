#!/usr/bin/env bash
# Creates roles and databases for local dev / CI. Needs a Postgres superuser (PGSUPERUSER_URL, else `su postgres`).
# hos_owner: owns schema, runs migrations. hos_app: runtime, RLS ENFORCED (no BYPASSRLS).
# hos_admin: provisioning/support jobs only (BYPASSRLS). Passwords here are dev-only.
set -euo pipefail
DBS="${HOS_DATABASES:-hos_dev hos_test}"
psql_stdin() {
  if [ -n "${PGSUPERUSER_URL:-}" ]; then psql "$PGSUPERUSER_URL" -v ON_ERROR_STOP=1 -qAt
  else su postgres -c "psql -v ON_ERROR_STOP=1 -qAt"; fi
}
sql() { printf '%s\n' "$1" | psql_stdin; }
sql "DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='hos_owner') THEN CREATE ROLE hos_owner LOGIN PASSWORD 'dev' NOSUPERUSER NOBYPASSRLS CREATEDB; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='hos_app') THEN CREATE ROLE hos_app LOGIN PASSWORD 'dev' NOSUPERUSER NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='hos_admin') THEN CREATE ROLE hos_admin LOGIN PASSWORD 'dev' NOSUPERUSER BYPASSRLS; END IF;
END \$\$;"
for db in $DBS; do
  if [ -z "$(sql "SELECT 1 FROM pg_database WHERE datname='$db'")" ]; then sql "CREATE DATABASE $db OWNER hos_owner"; fi
  sql "ALTER DATABASE $db SET search_path = public"
done
# extensions need superuser: install once per database
for db in $DBS; do
  if [ -n "${PGSUPERUSER_URL:-}" ]; then
    psql "${PGSUPERUSER_URL%/*}/$db" -v ON_ERROR_STOP=1 -qAt -c "CREATE EXTENSION IF NOT EXISTS btree_gist; CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS citext;"
  else
    su postgres -c "psql -d $db -v ON_ERROR_STOP=1 -qAt -c 'CREATE EXTENSION IF NOT EXISTS btree_gist; CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS citext;'"
  fi
done
echo "bootstrap complete: $DBS"
