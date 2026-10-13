#!/bin/bash
# Runs all test suites sequentially, kills ports between each, prints summary table.
# Usage: bash scripts/run-all-suites.sh
# Does NOT include test-claude or test-whatsapp (require live API keys/numbers).

PROJ="/Users/valearisti/Desktop/Daxos automatizar"
cd "$PROJ"

kill_ports() {
  for port in 3000 3096 3097 3098 3099; do
    pids=$(lsof -ti tcp:$port 2>/dev/null)
    [ -n "$pids" ] && kill -9 $pids 2>/dev/null
  done
  sleep 1
}

run_suite() {
  local name="$1"
  local script="$2"
  kill_ports
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

run_suite "test-db"            "scripts/test-db.js"
run_suite "test-billing"       "scripts/test-billing.js"
run_suite "test-trial-grace"   "scripts/test-trial-grace.js"
run_suite "test-wa-disconnect" "scripts/test-wa-disconnect.js"
run_suite "test-pause-keyword" "scripts/test-pause-keyword.js"
run_suite "test-silent-window" "scripts/test-silent-window.js"
run_suite "test-kapso-image"   "scripts/test-kapso-image.js"
run_suite "test-wa-health"     "scripts/test-wa-health-check.js"
run_suite "test-owner-view"    "scripts/test-owner-view.js"
run_suite "test-security"      "scripts/test-security.js"
run_suite "test-lote3"         "scripts/test-lote3.js"

echo "================================================================"
echo "Done."
