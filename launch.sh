#!/usr/bin/env bash
#
# launch.sh — one command to bring up Solsino locally.
#
# What it does, in order:
#   1. Makes sure a Postgres instance is reachable at DATABASE_URL —
#      starts one via Docker if nothing's listening and Docker is
#      available, otherwise tells you what to do.
#   2. Installs backend + frontend deps if node_modules is missing.
#   3. Runs `prisma generate` + `prisma migrate deploy`.
#   4. Starts the backend (Express + Socket.io) and frontend (Next.js)
#      in the background, logs both to ./logs/, and tails them.
#   5. On Ctrl+C, stops both cleanly (and the Docker Postgres it
#      started, if any — pass --keep-db to leave it running).
#
# Usage:
#   ./launch.sh            start everything
#   ./launch.sh --keep-db  start everything, don't stop Docker Postgres on exit

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="$ROOT_DIR/frontend"
LOG_DIR="$ROOT_DIR/logs"
BACKEND_LOG="$LOG_DIR/backend.log"
FRONTEND_LOG="$LOG_DIR/frontend.log"
DOCKER_PG_CONTAINER="solsino-postgres"
KEEP_DB=false
STARTED_DOCKER_PG=false

for arg in "$@"; do
  case "$arg" in
    --keep-db) KEEP_DB=true ;;
  esac
done

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()  { echo -e "${BLUE}==>${NC} $1"; }
ok()    { echo -e "${GREEN}✓${NC} $1"; }
warn()  { echo -e "${YELLOW}!${NC} $1"; }
fail()  { echo -e "${RED}✗${NC} $1"; }

mkdir -p "$LOG_DIR"

BACKEND_PID=""
FRONTEND_PID=""

cleanup() {
  echo ""
  info "Shutting down..."
  [ -n "$FRONTEND_PID" ] && kill "$FRONTEND_PID" 2>/dev/null
  [ -n "$BACKEND_PID" ] && kill "$BACKEND_PID" 2>/dev/null
  if [ "$STARTED_DOCKER_PG" = true ] && [ "$KEEP_DB" = false ]; then
    info "Stopping the Postgres container this script started (use --keep-db to skip this)..."
    docker stop "$DOCKER_PG_CONTAINER" >/dev/null 2>&1
  fi
  ok "Stopped."
  exit 0
}
trap cleanup INT TERM

# ---------- 0. sanity checks ----------

if ! command -v node >/dev/null 2>&1; then
  fail "Node.js isn't installed or isn't on PATH. Install Node 18+ and re-run."
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  fail "npm isn't installed or isn't on PATH."
  exit 1
fi

if [ ! -f "$ROOT_DIR/.env" ]; then
  fail "No .env file found at $ROOT_DIR/.env — copy your DATABASE_URL / SOLANA_RPC_URL / HOUSE_WALLET_SECRET_KEY / PROFIT_WALLET_ADDRESS / ADMIN_API_KEY into one first."
  exit 1
fi

# Pull DATABASE_URL out of .env without sourcing the whole file (it
# may contain values bash would choke on).
DATABASE_URL="$(grep -E '^DATABASE_URL=' "$ROOT_DIR/.env" | head -1 | cut -d'=' -f2- | sed -e 's/^"//' -e 's/"$//')"

if grep -q '^ADMIN_API_KEY=change-me-to-a-long-random-string' "$ROOT_DIR/.env" 2>/dev/null; then
  warn "ADMIN_API_KEY in .env is still the placeholder value — fine for local devnet testing, but change it before this is reachable by anyone else."
fi

# ---------- 1. make sure Postgres is reachable ----------

parse_db_url() {
  # Very small postgres:// URL parser — good enough for localhost dev URLs.
  python3 - "$DATABASE_URL" <<'PY' 2>/dev/null
import sys
from urllib.parse import urlparse
u = urlparse(sys.argv[1])
print(u.hostname or "")
print(u.port or 5432)
print(u.username or "")
print(u.password or "")
print((u.path or "/").lstrip("/"))
PY
}

DB_HOST=""; DB_PORT=""; DB_USER=""; DB_PASS=""; DB_NAME=""
if command -v python3 >/dev/null 2>&1; then
  IFS=$'\n' read -r DB_HOST DB_PORT DB_USER DB_PASS DB_NAME <<< "$(parse_db_url)"
fi
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"

db_reachable() {
  (exec 3<>"/dev/tcp/$DB_HOST/$DB_PORT") 2>/dev/null
}

info "Checking Postgres at $DB_HOST:$DB_PORT..."
if db_reachable; then
  ok "Postgres is reachable."
else
  warn "Nothing answering on $DB_HOST:$DB_PORT."
  if command -v docker >/dev/null 2>&1; then
    if docker ps -a --format '{{.Names}}' | grep -qx "$DOCKER_PG_CONTAINER"; then
      info "Starting existing Docker container '$DOCKER_PG_CONTAINER'..."
      docker start "$DOCKER_PG_CONTAINER" >/dev/null
    else
      info "Starting a new Postgres container ('$DOCKER_PG_CONTAINER') via Docker to match your DATABASE_URL..."
      docker run -d \
        --name "$DOCKER_PG_CONTAINER" \
        -e POSTGRES_USER="${DB_USER:-postgres}" \
        -e POSTGRES_PASSWORD="${DB_PASS:-postgres}" \
        -e POSTGRES_DB="${DB_NAME:-crypto_casino}" \
        -p "$DB_PORT:5432" \
        postgres:16-alpine >/dev/null
    fi
    STARTED_DOCKER_PG=true

    info "Waiting for Postgres to accept connections..."
    for i in $(seq 1 30); do
      if db_reachable; then break; fi
      sleep 1
    done
    if db_reachable; then
      ok "Postgres is up."
    else
      fail "Postgres in Docker didn't come up in time — check 'docker logs $DOCKER_PG_CONTAINER'."
      exit 1
    fi
  else
    fail "Docker isn't available either, so I can't start a database for you."
    echo "    Start whatever Postgres your DATABASE_URL points at, then re-run this script."
    echo "    (Or install Docker and re-run — I'll spin up a matching container automatically.)"
    exit 1
  fi
fi

# ---------- 2. install deps ----------

if [ ! -d "$ROOT_DIR/node_modules" ]; then
  info "Installing backend dependencies (npm install)..."
  (cd "$ROOT_DIR" && npm install) || { fail "Backend npm install failed."; exit 1; }
  ok "Backend deps installed."
else
  ok "Backend deps already installed."
fi

if [ ! -d "$FRONTEND_DIR/node_modules" ]; then
  info "Installing frontend dependencies (npm install)..."
  (cd "$FRONTEND_DIR" && npm install) || { fail "Frontend npm install failed."; exit 1; }
  ok "Frontend deps installed."
else
  ok "Frontend deps already installed."
fi

# ---------- 3. prisma ----------

info "Running prisma generate..."
(cd "$ROOT_DIR" && npx prisma generate) >>"$BACKEND_LOG" 2>&1 || { fail "prisma generate failed — see $BACKEND_LOG"; exit 1; }
ok "Prisma client generated."

info "Applying database migrations (prisma migrate deploy)..."
(cd "$ROOT_DIR" && npx prisma migrate deploy) >>"$BACKEND_LOG" 2>&1 || { fail "prisma migrate deploy failed — see $BACKEND_LOG"; exit 1; }
ok "Database schema up to date."

# ---------- 4. start everything ----------

info "Starting backend on :4000..."
(cd "$ROOT_DIR" && npm run dev) >"$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!

info "Starting frontend on :3000..."
(cd "$FRONTEND_DIR" && npm run dev) >"$FRONTEND_LOG" 2>&1 &
FRONTEND_PID=$!

sleep 2
if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
  fail "Backend crashed on startup — check $BACKEND_LOG"
  tail -n 30 "$BACKEND_LOG"
  cleanup
fi
if ! kill -0 "$FRONTEND_PID" 2>/dev/null; then
  fail "Frontend crashed on startup — check $FRONTEND_LOG"
  tail -n 30 "$FRONTEND_LOG"
  cleanup
fi

echo ""
ok "Solsino is running:"
echo "    Frontend:  http://localhost:3000"
echo "    Admin:     http://localhost:3000/admin"
echo "    Backend:   http://localhost:4000"
echo "    Logs:      $BACKEND_LOG , $FRONTEND_LOG"
echo ""
info "Press Ctrl+C to stop everything."
echo ""

tail -f "$BACKEND_LOG" "$FRONTEND_LOG" &
TAIL_PID=$!
wait "$BACKEND_PID" "$FRONTEND_PID"
kill "$TAIL_PID" 2>/dev/null
cleanup
