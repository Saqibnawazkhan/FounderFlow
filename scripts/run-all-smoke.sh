#!/usr/bin/env bash
# Full smoke suite runner. Runs the asserting scripts in scripts/ against ONE dev
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
  # Added 2026-09-23 with the Calendar view. Sits beside smoke-tasks; it
  # only reads, so its position is not load-bearing.
  smoke-tasks-calendar
  smoke-time
  smoke-comments
  # Added 2026-09-25 with the chat feature. After smoke-comments because it
  # reuses the same mention autocomplete; before the session-killing scripts.
  smoke-chat
  # Added 2026-09-25 with the DM + create-channel feature. Straight after
  # smoke-chat so a failure here reads as "DMs/creation broke" rather than
  # "chat broke" — smoke-chat has already proved the basics by this point.
  # Also before the session-killing scripts: it signs in as three users.
  smoke-chat-dm
  # Added 2026-09-25 with cross-content search (Phase H). AFTER the chat
  # scripts on purpose: it searches for message text, so it needs chat to have
  # already proved it can store a message. A failure here then means search,
  # not chat. Its highest-value assertions are the two negative ones -- a
  # member gets no finance group, and a term that exists only inside a private
  # channel returns nothing.
  smoke-search
  smoke-confirm
  smoke-member-roles
  smoke-recurring
  smoke-transactions
  smoke-team
  smoke-invite
  # Added 2026-09-23: these cover shipped features (per-workspace currency,
  # multi-admin, web push, JWT session invalidation) but were never wired in
  # when they landed. session-invalidation runs late because it deliberately
  # kills live sessions; rate-limit stays last because it trips the limiter.
  smoke-currency
  smoke-multi-admin
  smoke-push
  smoke-session-invalidation
  # Not a smoke-*.mjs, but it asserts (no horizontal overflow at <=375px) —
  # the landing/login/signup regression check.
  verify-ui
  smoke-rate-limit
)

for name in "${SCRIPTS[@]}"; do
  file="scripts/${name}.mjs"
  [ -f "$file" ] || { echo "SKIP    $name (missing)" | tee -a "$SUMMARY"; continue; }
  log="$OUT/${name}.log"
  if timeout 200 node "$file" > "$log" 2>&1; then rc=0; else rc=$?; fi
  # Count BOTH failure dialects. The older scripts print a literal ❌; the
  # newer ones print "  FAIL  " and set process.exitCode instead. Counting only
  # ❌ meant a Gen-2 assertion failure reported "fail=0" and was classified
  # EXIT1 -- caught, but reading as a crash rather than as a failed check, which
  # is exactly the wrong signal when you are triaging twenty scripts.
  fails=$(grep -cE "❌|^  FAIL " "$log" 2>/dev/null | head -1)
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