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
