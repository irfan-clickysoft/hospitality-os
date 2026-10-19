# Source this file. Defines hpsql <url> [psql args…]: uses the psql on this machine if there is one, otherwise the psql inside the project's Docker database container
# (so a Mac without PostgreSQL tools installed still works). Reads SQL from stdin when no -c is given.
hpsql() {
  local url="$1"; shift
  if command -v psql >/dev/null 2>&1; then
    psql "$url" "$@"
  else
    # inside the container the server is on localhost:5432 whatever port it is published on
    local inner; inner="$(printf '%s' "$url" | sed -E 's#@[^/]+/#@localhost:5432/#')"
    docker compose exec -T db psql "$inner" "$@"
  fi
}

# The database superuser, for backups and restores: the tables are protected by forced row-level security, which only a superuser (or the app's admin role) reads in full, and a
# restore must recreate objects with their real owners. Same variable as bootstrap-db.sh; the default is the Docker database from docker-compose.yml.
hos_super_url() { printf '%s' "${PGSUPERUSER_URL:-postgres://postgres:postgres@localhost:${HOS_DB_PORT:-5432}/postgres}"; }
hos_db_name() { printf '%s' "${DATABASE_URL_OWNER##*/}"; }
# the superuser URL pointing at the project database
hos_super_db_url() { local u; u="$(hos_super_url)"; printf '%s/%s' "${u%/*}" "$(hos_db_name)"; }

# pg_dump / pg_restore the same way as psql: the host's tools when installed, otherwise the ones inside the database container.
# Dumps go to stdout and restores read stdin, so no file has to live inside the container.
hpgdump() {
  local url="$1"; shift
  if command -v pg_dump >/dev/null 2>&1; then pg_dump "$url" "$@"
  else
    local inner; inner="$(printf '%s' "$url" | sed -E 's#@[^/]+/#@localhost:5432/#')"
    docker compose exec -T db pg_dump "$inner" "$@"
  fi
}
hpgrestore() {
  local url="$1"; shift
  if command -v pg_restore >/dev/null 2>&1; then pg_restore -d "$url" "$@"
  else
    local inner; inner="$(printf '%s' "$url" | sed -E 's#@[^/]+/#@localhost:5432/#')"
    docker compose exec -T db pg_restore -d "$inner" "$@"
  fi
}
