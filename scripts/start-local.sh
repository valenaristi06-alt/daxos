#!/usr/bin/env bash
# Arranca el servidor local para revisar la rama design-polish.
# Base de datos SEPARADA de producción (data-local-test/).
# Sin credenciales de Meta/WhatsApp → el server no envía mensajes reales.
# Uso: bash scripts/start-local.sh

set -e

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

# ── Confirmación de rama ──────────────────────────────────────────────────────
BRANCH=$(git rev-parse --abbrev-ref HEAD)
echo "Rama actual: $BRANCH"
if [ "$BRANCH" != "design-polish" ]; then
  echo ""
  echo "  Para revisar design-polish: git checkout design-polish"
  echo "  (Podés correrlo igual en cualquier rama.)"
  echo ""
fi

# ── Variables de entorno locales ──────────────────────────────────────────────
# DB propia, no toca ./data/daxos.db ni el volumen de Railway
export DB_DIR="$REPO/data-local-test"
export NODE_ENV="development"
export PORT="3001"
export SESSION_SECRET="dev-only-not-for-prod-$(hostname)"

# Sin estas claves, el webhook rechaza todo y el bot no llama a Claude.
# Ideal para revisar solo UI/config. Descomentá y completá si querés
# probar "Probá tu asistente" con respuestas reales de Claude.
# export ANTHROPIC_API_KEY="sk-ant-..."

# Sin claves de Meta → no se mandan mensajes reales a WhatsApp.
# export WHATSAPP_VERIFY_TOKEN=""
# export META_APP_SECRET=""

# Sin Resend → los emails se loguean en consola y no se envían.
# export RESEND_API_KEY=""

mkdir -p "$DB_DIR"
echo ""
echo "  DB local: $DB_DIR/daxos.db  (no es la de producción)"
echo "  Puerto:   $PORT"
echo "  URL:      http://localhost:$PORT"
echo ""
echo "  Si es la primera vez, abrí http://localhost:$PORT/register.html"
echo "  y creá una cuenta de prueba — no llega ningún email real."
echo ""
echo "  Para volver a main después:  git checkout main"
echo "  Para detener:                Ctrl+C"
echo ""

node src/server.js
