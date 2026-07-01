#!/usr/bin/env bash
# Full smoke suite runner. Runs every scripts/smoke-*.mjs against ONE dev
# server. Order: `smoke` first (it mkdirs the shared screenshot dir the other
# scripts write into), then the rest; rate-limit last (it trips the login
# limiter). Records per-script ok/fail/pageerror counts to a summary.
export BASE="http://localhost:3000"
OUT="C:/Users/USER/AppData/Local/Temp/ff-smoke-full"
mkdir -p "$OUT"
# Pre-create the screenshot dir the scripts write into so the ones that don't
# mkdir it themselves (smoke-auth, etc.) don't ENOENT.
mkdir -p "C:/Users/USER/AppData/Local/Temp/ff-screenshots"
SUMMARY="$OUT/summary.txt"
: > "$SUMMARY"

SCRIPTS=(
  smoke
  smoke-auth
  smoke-loading
  smoke-i18n
  smoke-settings
  smoke-projects
  smoke-tasks
  smoke-time
  smoke-comments
  smoke-confirm
  smoke-member-roles
  smoke-recurring
  smoke-transactions
  smoke-team
  smoke-invite
  smoke-rate-limit
)

for name in "${SCRIPTS[@]}"; do
  file="scripts/${name}.mjs"
  [ -f "$file" ] || { echo "SKIP    $name (missing)" | tee -a "$SUMMARY"; continue; }
  log="$OUT/${name}.log"
  if timeout 200 node "$file" > "$log" 2>&1; then rc=0; else rc=$?; fi
  fails=$(grep -c "❌" "$log" 2>/dev/null | head -1)
  oks=$(grep -cE "✅|  ok " "$log" 2>/dev/null | head -1)
  pageerr=$(grep -c "PAGEERROR" "$log" 2>/dev/null | head -1)
  if [ "$rc" -eq 124 ]; then
    echo "TIMEOUT $name (ok=$oks fail=$fails pageerr=$pageerr)" | tee -a "$SUMMARY"
  elif [ "$rc" -ne 0 ]; then
    echo "EXIT$rc   $name (ok=$oks fail=$fails pageerr=$pageerr)" | tee -a "$SUMMARY"
  elif [ "$fails" -gt 0 ] || [ "$pageerr" -gt 0 ]; then
    echo "ASSERT  $name (ok=$oks fail=$fails pageerr=$pageerr)" | tee -a "$SUMMARY"
  else
    echo "OK      $name (ok=$oks fail=$fails pageerr=$pageerr)" | tee -a "$SUMMARY"
  fi
done

echo "=== DONE ===" | tee -a "$SUMMARY"