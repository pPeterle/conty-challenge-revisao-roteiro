#!/usr/bin/env bash
# Sobe a API com banco temporário, roda o k6 via Docker e confere as invariantes no banco.
set -euo pipefail

PORT="${PORT:-3101}"
RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
DB="$TMP/carga.db"
export NODE_OPTIONS='--disable-warning=ExperimentalWarning'

cd "$RAIZ"
DB_PATH="$DB" PORT="$PORT" npx tsx src/index.ts >"$TMP/server.log" 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; rm -rf "$TMP"' EXIT

for _ in $(seq 1 50); do
  curl -sf "http://localhost:$PORT/health" >/dev/null && break
  sleep 0.2
done
curl -sf "http://localhost:$PORT/health" >/dev/null || { echo "API não subiu"; cat "$TMP/server.log"; exit 1; }

docker run --rm -i \
  --add-host=host.docker.internal:host-gateway \
  -e BASE_URL="http://host.docker.internal:$PORT" \
  grafana/k6:0.54.0 run --quiet - <load/revisao.js

npx tsx scripts/verify-load.ts "$DB"
