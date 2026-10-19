#!/usr/bin/env bash
# Creates the three database roles and the database for a real deployment (the dev script bootstrap-db.sh uses throw-away passwords; this one never does).
#   hos_owner  owns the schema and runs migrations
#   hos_app    runtime, row-level security ENFORCED (cannot bypass it)
#   hos_admin  provisioning and platform jobs only (BYPASSRLS)
# Needs: PGSUPERUSER_URL (a superuser / admin connection to the server, e.g. postgres://postgres:…@db:5432/postgres) and the three passwords below.
# Safe to run again: it creates what is missing and re-sets the passwords, so it also rotates them.
set -euo pipefail
: "${PGSUPERUSER_URL:?set PGSUPERUSER_URL}" "${HOS_OWNER_PASSWORD:?}" "${HOS_APP_PASSWORD:?}" "${HOS_ADMIN_PASSWORD:?}"
DB="${HOS_DB:-hos}"
psql "$PGSUPERUSER_URL" -v ON_ERROR_STOP=1 -qAt -v owner_pw="$HOS_OWNER_PASSWORD" -v app_pw="$HOS_APP_PASSWORD" -v admin_pw="$HOS_ADMIN_PASSWORD" -v db="$DB" <<'SQL'
SELECT format('CREATE ROLE hos_owner LOGIN NOSUPERUSER NOBYPASSRLS') WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'hos_owner') \gexec
SELECT format('CREATE ROLE hos_app LOGIN NOSUPERUSER NOBYPASSRLS') WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'hos_app') \gexec
SELECT format('CREATE ROLE hos_admin LOGIN NOSUPERUSER BYPASSRLS') WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'hos_admin') \gexec
SELECT format('ALTER ROLE hos_owner PASSWORD %L', :'owner_pw') \gexec
SELECT format('ALTER ROLE hos_app PASSWORD %L', :'app_pw') \gexec
SELECT format('ALTER ROLE hos_admin PASSWORD %L', :'admin_pw') \gexec
SELECT format('CREATE DATABASE %I OWNER hos_owner', :'db') WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'db') \gexec
SELECT format('ALTER DATABASE %I SET search_path = public', :'db') \gexec
SQL
# extensions (the four are "trusted" in PostgreSQL 13+, so on most managed services the database owner could create them too)
base="${PGSUPERUSER_URL%/*}"
psql "$base/$DB" -v ON_ERROR_STOP=1 -qAt -c "CREATE EXTENSION IF NOT EXISTS btree_gist; CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS citext;"
echo "database '$DB' ready: roles hos_owner, hos_app, hos_admin"
