#!/usr/bin/env bash
# Arranca Daxos en entorno local aislado (data-local-test/, sin secrets reales).
#
# Uso:
#   npm run local-seguro                           # activo por defecto (4 convs, WA conectado)
#   npm run local-seguro -- --estado=activo        # WA conectado, plan activo, 4 conversaciones de ejemplo
#   npm run local-seguro -- --estado=vacio         # WA conectado, plan activo, sin conversaciones
#   npm run local-seguro -- --estado=desconectado  # WA desconectado, plan activo, sin conversaciones
#   npm run local-seguro -- --estado=prueba        # WA conectado, prueba terminada, sin conversaciones
set -e

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

# ── Parseo de --estado ────────────────────────────────────────────────────────
ESTADO="activo"
for arg in "$@"; do
  case "$arg" in
    --estado=*) ESTADO="${arg#--estado=}" ;;
  esac
done
ESTADOS_VALIDOS="activo vacio desconectado prueba"
if ! echo "$ESTADOS_VALIDOS" | grep -qw "$ESTADO"; then
  echo "ERROR: --estado=\"$ESTADO\" no válido. Opciones: $ESTADOS_VALIDOS"
  exit 1
fi
export SEED_ESTADO="$ESTADO"

TEST_EMAIL="test@local.dev"
TEST_PASS="prueba1234"

# ── Aislamiento de producción ─────────────────────────────────────────────────
# Estas exportaciones ocurren ANTES de que node cargue .env.local,
# entonces process.env ya tiene los valores y dotenv los respeta (no sobreescribe).
export DB_DIR="$REPO/data-local-test"
export NODE_ENV="development"
export PORT="3001"
export SESSION_SECRET="dev-only-not-for-prod-$(hostname)"

# Silenciar todas las integraciones externas que podrían enviar mensajes reales
export KAPSO_API_KEY=""
export KAPSO_WEBHOOK_SECRET=""
export KAPSO_PLATFORM_WEBHOOK_SECRET=""
export RESEND_API_KEY=""
export R2_ACCOUNT_ID=""
export R2_BUCKET_NAME=""
export R2_ACCESS_KEY_ID=""
export R2_SECRET_ACCESS_KEY=""
export META_SYSTEM_TOKEN=""
export META_APP_SECRET=""
export META_WEBHOOK_VERIFY_TOKEN=""
export WHATSAPP_VERIFY_TOKEN=""
export WA_HEALTH_ALERTS=""
export MERCADOPAGO_ACCESS_TOKEN=""
export MERCADOPAGO_WEBHOOK_SECRET=""
export ELEVENLABS_API_KEY=""

mkdir -p "$DB_DIR"

# ── Arranca el server en background ──────────────────────────────────────────
node src/server.js &
SRV_PID=$!
trap "kill $SRV_PID 2>/dev/null; exit" INT TERM EXIT

# Espera a que el server esté listo (máx 12 segundos)
# /auth/me devuelve 401 cuando no hay sesión — eso es "listo"
READY=0
for i in $(seq 1 30); do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT/auth/me" 2>/dev/null || true)
  if [ "$STATUS" = "401" ] || [ "$STATUS" = "200" ]; then
    READY=1; break
  fi
  sleep 0.4
done

if [ "$READY" -eq 0 ]; then
  echo "ERROR: el servidor no respondió en 12 s. Revisá los logs arriba."
  exit 1
fi

# ── Crea el usuario de prueba (silencioso si ya existe) ───────────────────────
curl -s -X POST "http://localhost:$PORT/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$TEST_EMAIL\",\"password\":\"$TEST_PASS\"}" \
  -c "$DB_DIR/cookie.txt" -o /dev/null 2>/dev/null || true

# Login real — guarda cookie de sesión
LOGIN_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "http://localhost:$PORT/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$TEST_EMAIL\",\"password\":\"$TEST_PASS\"}" \
  -c "$DB_DIR/cookie.txt" 2>/dev/null || echo "000")

if [ "$LOGIN_STATUS" != "200" ]; then
  echo "ERROR: login falló (HTTP $LOGIN_STATUS). Eliminá data-local-test/ y volvé a intentar."
  exit 1
fi

# ── Seed: 4 conversaciones de ejemplo ────────────────────────────────────────
node scripts/seed-local.js

BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "?")

echo ""
echo "  ┌─────────────────────────────────────────────┐"
echo "  │  Daxos local — base SEPARADA de producción  │"
echo "  ├─────────────────────────────────────────────┤"
echo "  │  Rama:      $BRANCH"
echo "  │  Estado:    $ESTADO"
echo "  │  URL:       http://localhost:$PORT/inicio.html"
echo "  │  Email:     $TEST_EMAIL"
echo "  │  Password:  $TEST_PASS"
echo "  │  DB:        data-local-test/daxos.db"
echo "  │  Secrets:   Meta/Kapso/Resend/R2 = vacíos"
echo "  ├─────────────────────────────────────────────┤"
echo "  │  Para detener: Ctrl+C                       │"
echo "  └─────────────────────────────────────────────┘"
echo ""

open "http://localhost:$PORT/inicio.html" 2>/dev/null || true

# Mantiene el server vivo (el trap lo mata al salir)
wait $SRV_PID
