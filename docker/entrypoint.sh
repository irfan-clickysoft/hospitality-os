#!/bin/sh
# Brings the database up to date, then starts the server.
#   RUN_MIGRATIONS=1 (default)  apply pending SQL migrations (needs DATABASE_URL_OWNER) and add any new built-in roles/permissions to every business
#   RUN_MIGRATIONS=0            skip both (several replicas: run one with 1, the rest with 0)
#   HOS_TEST_COPY=1             a hosted TEST copy: fill an empty database with the Sunset demo business once (needs DEMO_PASSWORD). Never for real guest data.
set -eu
cd /app
if [ "${RUN_MIGRATIONS:-1}" = "1" ]; then
  echo "[hos] checking database migrations"
  node packages/db/dist/migrate-cli.js
  echo "[hos] syncing built-in roles"
  node apps/api/dist/cli/sync-roles.js
fi
if [ "${HOS_TEST_COPY:-0}" = "1" ]; then
  node apps/api/dist/cli/seed-test-copy.js
fi
echo "[hos] starting api on :${PORT:-3000}"
exec node apps/api/dist/main.js
