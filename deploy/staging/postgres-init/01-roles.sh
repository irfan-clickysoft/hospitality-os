#!/bin/bash
# Runs once, when the database is first created: the three database roles and the extensions the app needs.
#   hos_owner  owns the schema and runs migrations
#   hos_app    runs the API (row-level security ENFORCED)
#   hos_admin  provisioning and support jobs only (bypasses row-level security)
set -euo pipefail
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<SQL
CREATE ROLE hos_owner LOGIN PASSWORD '${HOS_OWNER_PASSWORD}' NOSUPERUSER NOBYPASSRLS CREATEDB;
CREATE ROLE hos_app LOGIN PASSWORD '${HOS_APP_PASSWORD}' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE hos_admin LOGIN PASSWORD '${HOS_ADMIN_PASSWORD}' NOSUPERUSER BYPASSRLS;
CREATE DATABASE ${HOS_DB} OWNER hos_owner;
SQL
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$HOS_DB" <<SQL
ALTER DATABASE ${HOS_DB} SET search_path = public;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;
SQL
