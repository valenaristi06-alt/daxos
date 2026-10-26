#!/usr/bin/env bash
# Arranca el servidor local para revisar la rama design-polish.
# Base de datos SEPARADA de producción (data-local-test/).
# Sin credenciales de Meta/WhatsApp → el server no envía mensajes reales.
# Uso: bash scripts/start-local.sh

set -e

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

TEST_EMAIL="test@local.dev"
TEST_PASS="prueba1234"

export DB_DIR="$REPO/data-local-test"
export NODE_ENV="development"
export PORT="3001"
export SESSION_SECRET="dev-only-not-for-prod-$(hostname)"

mkdir -p "$DB_DIR"

# ── Arranca el server en background ──────────────────────────────────────────
node src/server.js &
SRV_PID=$!
trap "kill $SRV_PID 2>/dev/null; exit" INT TERM EXIT

# Espera a que el server esté listo
for i in $(seq 1 20); do
  if curl -sf "http://localhost:$PORT/auth/me" -o /dev/null 2>/dev/null; then break; fi
  sleep 0.3
done

# ── Crea el usuario de prueba (silencioso si ya existe) ───────────────────────
curl -sf -X POST "http://localhost:$PORT/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$TEST_EMAIL\",\"password\":\"$TEST_PASS\"}" \
  -c "$DB_DIR/cookie.txt" -o /dev/null 2>/dev/null || true

# Si ya existía, loguea para obtener la cookie
curl -sf -X POST "http://localhost:$PORT/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$TEST_EMAIL\",\"password\":\"$TEST_PASS\"}" \
  -c "$DB_DIR/cookie.txt" -o /dev/null 2>/dev/null || true

BRANCH=$(git rev-parse --abbrev-ref HEAD)

echo ""
echo "  Rama:     $BRANCH"
echo "  URL:      http://localhost:$PORT/dashboard.html"
echo "  Email:    $TEST_EMAIL"
echo "  Password: $TEST_PASS"
echo "  DB local: $DB_DIR/daxos.db  (no es la de producción)"
echo ""
echo "  Para volver a main:  git checkout main"
echo "  Para detener:        Ctrl+C"
echo ""

open "http://localhost:$PORT/login.html?next=/dashboard.html"

# Mantiene el server vivo (el trap lo mata al salir)
wait $SRV_PID
