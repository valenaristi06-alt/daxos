#!/bin/bash
# Runs all test suites sequentially, kills ports between each, prints summary table.
# Usage: bash scripts/run-all-suites.sh
# Does NOT include test-claude or test-whatsapp (require live API keys/numbers).

PROJ="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJ"

kill_ports() {
  for port in 3000 3091 3095 3096 3097 3098 3099 3100 3105 3106 3107 3109 3110 3215 3216 3222 3225; do
    pids=$(lsof -ti tcp:$port 2>/dev/null)
    [ -n "$pids" ] && kill -9 $pids 2>/dev/null
  done
  sleep 1
}

cleanup_dbs() {
  rm -rf /tmp/test-agenda-access /tmp/test-agenda-activation /tmp/test-agenda-api \
         /tmp/test-agenda-assistant /tmp/test-agenda-booking-direct /tmp/test-agenda-booking-e2e \
         /tmp/test-agenda-booking-server /tmp/test-agenda-db /tmp/test-agenda-db-partial \
         /tmp/test-agenda-panel /tmp/test-agenda-slots /tmp/test-billing /tmp/test-cortes-bot \
         /tmp/test-excluded-contacts /tmp/test-harness-sec /tmp/test-kapso-image /tmp/test-lote3 \
         /tmp/test-mailtest-a /tmp/test-mailtest-b /tmp/test-mailtest-c /tmp/test-mark-read \
         /tmp/test-owner-view /tmp/test-panel-send /tmp/test-pause-keyword /tmp/test-reset-conv \
         /tmp/test-runtime-config /tmp/test-sale-intent-booking /tmp/test-sale-intent-db \
         /tmp/test-security /tmp/test-security-prod /tmp/test-silent-window /tmp/test-spending-cap \
         /tmp/test-trial-grace /tmp/test-wa-disconnect /tmp/test-wa-health-check \
         2>/dev/null || true
}

run_suite() {
  local name="$1"
  local script="$2"
  kill_ports
  cleanup_dbs
  result=$(node "$script" 2>&1)
  exit_code=$?
  # Extract final results line
  summary=$(echo "$result" | grep -E "passed|failed|tests —" | tail -1)
  # Determine status: rely on exit code + explicit failure markers
  if [ $exit_code -ne 0 ]; then
    status="FAIL"
  elif echo "$result" | grep -qiE "[1-9][0-9]* failed"; then
    status="FAIL"
  else
    status="PASS"
  fi
  printf "%-22s %-6s %s\n" "$name" "$status" "$summary"
}

echo ""
echo "Running all test suites..."
echo "================================================================"
printf "%-22s %-6s %s\n" "Suite" "Status" "Summary"
echo "----------------------------------------------------------------"

run_suite "test-db"              "scripts/test-db.js"
run_suite "test-billing"         "scripts/test-billing.js"
run_suite "test-spending-cap"    "scripts/test-spending-cap.js"
run_suite "test-trial-grace"     "scripts/test-trial-grace.js"
run_suite "test-wa-disconnect"   "scripts/test-wa-disconnect.js"
run_suite "test-pause-keyword"   "scripts/test-pause-keyword.js"
run_suite "test-silent-window"   "scripts/test-silent-window.js"
run_suite "test-kapso-image"     "scripts/test-kapso-image.js"
run_suite "test-wa-health"       "scripts/test-wa-health-check.js"
run_suite "test-owner-view"      "scripts/test-owner-view.js"
run_suite "test-security"        "scripts/test-security.js"
run_suite "test-lote3"           "scripts/test-lote3.js"
run_suite "test-baileys"         "scripts/test-baileys.js"
run_suite "test-bh-real"         "scripts/test-bh-real.js"
run_suite "test-business-hours"  "scripts/test-business-hours.js"
run_suite "test-excluded"        "scripts/test-excluded-contacts.js"
run_suite "test-horario"         "scripts/test-horario.js"
run_suite "test-inicio-estados"  "scripts/test-inicio-estados.js"
run_suite "test-mark-read"       "scripts/test-mark-read.js"
run_suite "test-partial-put"     "scripts/test-partial-put.js"
run_suite "test-reset-conv"      "scripts/test-reset-conv.js"
run_suite "test-urgent-alert"    "scripts/test-urgent-alert.js"
run_suite "test-urgent-keywords" "scripts/test-urgent-keywords.js"
run_suite "test-urgent-toggle"   "scripts/test-urgent-toggle.js"
run_suite "test-split-messages"      "scripts/test-split-messages.js"
run_suite "test-client-queue"        "scripts/test-client-queue.js"
run_suite "test-mark-read-typing"    "scripts/test-mark-read-typing.js"
run_suite "test-panel-send"          "scripts/test-panel-send.js"
run_suite "test-cortes-bot"          "scripts/test-cortes-bot.js"
run_suite "test-runtime-config"      "scripts/test-runtime-config.js"
run_suite "test-sale-intent"         "scripts/test-sale-intent.js"
run_suite "test-mail-prueba"         "scripts/test-mail-prueba.js"
run_suite "test-cancel-booking"      "scripts/test-cancel-booking.js"
run_suite "test-agenda-db"           "scripts/test-agenda-db.js"
run_suite "test-agenda-slots"        "scripts/test-agenda-slots.js"
run_suite "test-agenda-assistant"    "scripts/test-agenda-assistant.js"
run_suite "test-agenda-panel"        "scripts/test-agenda-panel.js"
run_suite "test-agenda-api"          "scripts/test-agenda-api.js"
run_suite "test-agenda-booking"      "scripts/test-agenda-booking.js"
run_suite "test-agenda-access"       "scripts/test-agenda-access.js"
run_suite "test-agenda-activation"   "scripts/test-agenda-activation.js"

echo "================================================================"
echo "Done."
