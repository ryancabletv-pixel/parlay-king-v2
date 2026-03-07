#!/bin/bash
# Parlay King — Always-On Server Startup Script
# Kills stale processes, sets timezone, starts server

set -e

export TZ="America/Halifax"
export NODE_ENV="${NODE_ENV:-production}"
export PORT="${PORT:-8080}"

echo "============================================"
echo " PARLAY KING — Gold Standard V3 Titan XII"
echo " Starting at $(date)"
echo " PORT=$PORT | TZ=$TZ | NODE_ENV=$NODE_ENV"
echo "============================================"

# Kill any stale node processes on the target port
echo "[start.sh] Killing stale processes on port $PORT..."
fuser -k "$PORT/tcp" 2>/dev/null || true
sleep 1

# Load environment variables from .env if present
if [ -f "$(dirname "$0")/../.env" ]; then
  echo "[start.sh] Loading .env file..."
  set -a
  source "$(dirname "$0")/../.env"
  set +a
fi

# Ensure server is built
if [ ! -f "server_dist/index.js" ]; then
  echo "[start.sh] server_dist/index.js not found, building..."
  npm run server:build
fi

echo "[start.sh] Starting Node.js server..."
exec node server_dist/index.js
