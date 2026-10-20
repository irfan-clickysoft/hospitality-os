#!/usr/bin/env bash
# One command to run the whole system on your own computer (Mac or Linux) and open it in the browser:
#     bash scripts/start-local.sh        (or: pnpm start)
# First run: installs, builds, makes .env with a fresh key, starts the database in Docker, loads the Sunset demo business. Later runs: just starts it (your data is kept).
# Stop with Ctrl-C. Logs: .local/api.log and .local/web.log.
# HOS_SKIP_DOCKER=1  use a PostgreSQL you already run (the .env URLs and PGSUPERUSER_URL must point at it; the database must already be set up).
set -euo pipefail
cd "$(dirname "$0")/.."
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

say "1/6 Checking your computer"
command -v node >/dev/null || die "Node.js is not installed. Install Node 22 or newer from https://nodejs.org and run this again."
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] || die "Node $(node -v) is too old. Install Node 22 or newer from https://nodejs.org."
command -v pnpm >/dev/null || { command -v corepack >/dev/null && corepack enable >/dev/null 2>&1; }
command -v pnpm >/dev/null || die "pnpm is not available. Run:  corepack enable   (or: npm i -g pnpm)  and try again."
if [ "${HOS_SKIP_DOCKER:-0}" != "1" ]; then
  command -v docker >/dev/null || die "Docker is not installed. Install Docker Desktop (https://www.docker.com/products/docker-desktop), open it once, and run this again."
  docker info >/dev/null 2>&1 || die "Docker is installed but not running. Open Docker Desktop, wait until it says it is running, and run this again."
fi

say "2/6 Settings (.env)"
if [ ! -f .env ]; then cp .env.example .env; echo "created .env"; fi
if grep -q '^APP_ENCRYPTION_KEY=CHANGE_ME' .env; then
  key="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")"
  sed -i.bak "s#^APP_ENCRYPTION_KEY=CHANGE_ME#APP_ENCRYPTION_KEY=${key}#" .env && rm -f .env.bak
  echo "made a fresh encryption key (kept in .env: do not delete it, second-factor secrets depend on it)"
fi
set -a; . ./.env; set +a
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
# Many computers already run their own PostgreSQL on 5432. The project's database lives in Docker, so move it to a free port rather than failing (and write that into .env).
if [ "${HOS_SKIP_DOCKER:-0}" != "1" ]; then
  cur="${HOS_DB_PORT:-5432}"
  if port_busy "$cur" && ! docker compose port db 5432 2>/dev/null | grep -q ":$cur\$"; then
    new=""; for p in 5433 5434 5435 5436 5437 5438; do port_busy "$p" || { new="$p"; break; }; done
    [ -n "$new" ] || die "Port $cur is used by another program and so are 5433-5438. Stop another PostgreSQL (or set HOS_DB_PORT in .env to a free port) and run this again."
    echo "port $cur is used by another PostgreSQL on this computer: using port $new for the project's own database (saved in .env)"
    if grep -q '^HOS_DB_PORT=' .env; then sed -i.bak "s#^HOS_DB_PORT=.*#HOS_DB_PORT=$new#" .env; else echo "HOS_DB_PORT=$new" >> .env; fi
    sed -i.bak -E "s#^(DATABASE_URL_[A-Z]+=postgres://[^@]+@localhost:)[0-9]+/#\1$new/#" .env && rm -f .env.bak
    set -a; . ./.env; set +a
  fi
fi
[ "${HOS_STOP_AFTER_SETTINGS:-0}" = "1" ] && exit 0   # used by the test of this step
if curl -fs -o /dev/null http://localhost:3000/readyz 2>/dev/null && curl -fs -o /dev/null http://localhost:3001/ 2>/dev/null; then
  echo; echo "It is already running: open http://localhost:3001  (to restart it, stop the other Terminal window with Ctrl-C first)"; exit 0
fi
# Another program (often another project's dev server) may already use 3000 or 3001: take the next free ports and remember them in .env.
pick_port() { local p; for p in "$@"; do port_busy "$p" || { echo "$p"; return 0; }; done; return 1; }
API_PORT="$(pick_port 3000 3100 3200 3300)" || die "Ports 3000, 3100, 3200 and 3300 are all in use. Stop some programs and try again."
WEB_PORT="$(pick_port 3001 3101 3201 3301)" || die "Ports 3001, 3101, 3201 and 3301 are all in use. Stop some programs and try again."
[ "$API_PORT" = "3000" ] && [ "$WEB_PORT" = "3001" ] || echo "ports 3000/3001 are used by another program: using $API_PORT for the system and $WEB_PORT for the page you open (saved in .env)"
set_env() { if grep -q "^$1=" .env; then sed -i.bak "s#^$1=.*#$1=$2#" .env; else echo "$1=$2" >> .env; fi; rm -f .env.bak; }
set_env PORT "$API_PORT"; set_env ALLOWED_ORIGINS "http://localhost:$WEB_PORT"
set -a; . ./.env; set +a

say "3/6 Installing and building (the first time takes a few minutes)"
[ -d node_modules ] || pnpm install
[ -f packages/db/dist/index.js ] || pnpm build

say "4/6 Database"
. scripts/psql.sh
if [ "${HOS_SKIP_DOCKER:-0}" != "1" ]; then
  docker compose up -d db
  printf 'waiting for the database'
  for _ in $(seq 1 60); do docker compose exec -T db pg_isready -U postgres >/dev/null 2>&1 && break; printf '.'; sleep 1; done; echo
  PGSUPERUSER_URL="${PGSUPERUSER_URL:-postgres://postgres:postgres@localhost:${HOS_DB_PORT:-5432}/postgres}" bash scripts/bootstrap-db.sh
fi

say "5/6 Demo data"
count="$(hpsql "$(hos_super_db_url)" -qAt -c "SELECT CASE WHEN to_regclass('public.tenant') IS NULL THEN 0 ELSE (SELECT count(*) FROM public.tenant) END" 2>/dev/null || echo 0)"
if [ "$count" = "0" ]; then echo "loading the Sunset demo business (first run only)"; bash scripts/reset-dev.sh --yes >/dev/null; else echo "found your data: keeping it (to start again from scratch: bash scripts/reset-dev.sh)"; fi

say "6/6 Starting"
mkdir -p .local
set -m
pids=()
# each server runs in its own process group (set -m), so stopping takes the whole tree (pnpm, tsx, vite, node) with it, not just the first process
cleanup() { trap - EXIT INT TERM; echo; echo "stopping…"; for p in "${pids[@]}"; do kill -TERM -- "-$p" 2>/dev/null || kill "$p" 2>/dev/null || true; done; sleep 1; for p in "${pids[@]}"; do kill -KILL -- "-$p" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM
(cd apps/api && exec pnpm dev) > .local/api.log 2>&1 & pids+=($!)
(cd apps/staff-web && API_URL="http://localhost:$API_PORT" exec pnpm exec vite --port "$WEB_PORT" --host) > .local/web.log 2>&1 & pids+=($!)
printf 'starting'
ready=0
for _ in $(seq 1 90); do
  if curl -fs -o /dev/null "http://localhost:$API_PORT/readyz" && curl -fs -o /dev/null "http://localhost:$WEB_PORT/"; then ready=1; break; fi
  for p in "${pids[@]}"; do kill -0 "$p" 2>/dev/null || { echo; tail -20 .local/api.log .local/web.log; die "A server stopped. The last lines of the logs are above (full logs in .local/)."; }; done
  printf '.'; sleep 1
done; echo
[ "$ready" = "1" ] || { tail -20 .local/api.log .local/web.log; die "It did not become ready in time. See .local/api.log and .local/web.log."; }

cat <<MSG

  ✅ Running. Open  http://localhost:$WEB_PORT

  Company code:  sunset        Password (everyone):  sunset-demo-passphrase
    hira@sunset.local      front desk (try check-in, moving a guest, check-out)
    manager@sunset.local   property manager
    owner@sunset.local     the owner (asks you to set up a second factor on first sign-in)
    sana@ / bilal@ / ayesha@sunset.local   housekeeping      gate@sunset.local   gate security

  Press Ctrl-C here to stop.
MSG
open_url() { command -v open >/dev/null && open "$1" || { command -v xdg-open >/dev/null && xdg-open "$1" >/dev/null 2>&1 || true; }; }
open_url "http://localhost:$WEB_PORT"
wait
