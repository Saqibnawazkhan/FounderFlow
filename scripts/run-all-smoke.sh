#!/usr/bin/env bash
# Full smoke suite runner. Runs the asserting scripts in scripts/ against ONE dev
# server. Order: `smoke` first (it mkdirs the shared screenshot dir the other
# scripts write into), then the rest; rate-limit last (it trips the login
# limiter). Records per-script ok/fail/pageerror counts to a summary.
#
# ── IT EXITS NON-ZERO NOW (audit harness-008) ────────────────────────────────
#
# This file had no `exit` statement anywhere in it and no accumulator, so every
# run ended 0 whatever it found. It classified each script as
# OK / ASSERT / EXITn / TIMEOUT, wrote that to a summary, and then reported
# success — which means wiring it into CI as it stood would have added a step
# that was green by construction: the smoke-rate-limit bug at suite scale.
# Reading the verdict required a human opening a 25-line file and scanning it.
#
# THREE OUTCOMES, not two, and the third is the interesting one:
#
#   OK        the script ran and asserted successfully.
#   NOTRUN    the script exited 78, its way of saying "this environment cannot
#             run this check" — smoke-push does it when the deployment has no
#             VAPID key. It is NOT counted as a failure, because a missing local
#             prerequisite is not a product bug; it IS printed on its own line
#             and in the final verdict, because a suite that quietly stops
#             checking things is the failure mode this whole file is about.
#   FAIL      anything else: a failure marker in the log, a PAGEERROR, a
#             non-zero exit, or a timeout.
#
# The exit status is the FAIL count, capped at 1. A run with only OK and NOTRUN
# exits 0.
set -uo pipefail

export BASE="${BASE:-http://localhost:3000}"
OUT="C:/Users/USER/AppData/Local/Temp/ff-smoke-full"
mkdir -p "$OUT"
# Pre-create the screenshot dir the scripts write into so the ones that don't
# mkdir it themselves don't ENOENT.
mkdir -p "C:/Users/USER/AppData/Local/Temp/ff-screenshots"
SUMMARY="$OUT/summary.txt"
: > "$SUMMARY"

# Exit code a script uses for "not runnable here"; see the header. Mirrors
# scripts/db-staging.mjs, which exits 78 for an unprovisioned environment.
NOTRUN_CODE=78

SCRIPTS=(
  smoke
  smoke-auth
  # Reads only, and it is a crash regression check on the first page anyone
  # lands on — a failure this early tells you not to trust anything after it.
  smoke-dashboard-crash
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
  # These two existed and were never listed here, so they only ran when someone
  # remembered them by name. Both assert and both exit non-zero, so there was
  # nothing to fix in them; the omission was the bug. They follow smoke-chat-dm
  # for the same reason it follows smoke-chat.
  smoke-chat-dm-entry
  smoke-chat-private-visibility
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

failures=0
notrun=0
passed=0
missing=0

for name in "${SCRIPTS[@]}"; do
  file="scripts/${name}.mjs"
  if [ ! -f "$file" ]; then
    # A named script that is not on disk is a broken list, not a pass. It used
    # to `continue` past a bare SKIP line and leave the run green.
    echo "MISSING $name (scripts/${name}.mjs is not on disk)" | tee -a "$SUMMARY"
    missing=$((missing + 1))
    failures=$((failures + 1))
    continue
  fi
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
  counts="(ok=$oks fail=$fails pageerr=$pageerr)"

  if [ "$rc" -eq 124 ]; then
    echo "TIMEOUT $name $counts" | tee -a "$SUMMARY"
    failures=$((failures + 1))
  elif [ "$rc" -eq "$NOTRUN_CODE" ]; then
    # Not a pass and not a failure. The reason is the last thing the script
    # printed, so surface it here rather than making someone open the log.
    reason=$(tail -n 2 "$log" | tr -d '\r' | tr '\n' ' ')
    echo "NOTRUN  $name $counts — $reason" | tee -a "$SUMMARY"
    notrun=$((notrun + 1))
  elif [ "$rc" -ne 0 ]; then
    echo "EXIT$rc   $name $counts" | tee -a "$SUMMARY"
    failures=$((failures + 1))
  elif [ "$fails" -gt 0 ] || [ "$pageerr" -gt 0 ]; then
    # Exited 0 but said it failed. Trust what it said.
    echo "ASSERT  $name $counts" | tee -a "$SUMMARY"
    failures=$((failures + 1))
  else
    echo "OK      $name $counts" | tee -a "$SUMMARY"
    passed=$((passed + 1))
  fi
done

{
  echo "=== DONE ==="
  echo "passed=$passed  failed=$failures  notrun=$notrun  missing=$missing"
  if [ "$failures" -gt 0 ]; then
    echo "RESULT: FAIL — $failures script(s) did not pass. Logs in $OUT."
  elif [ "$notrun" -gt 0 ]; then
    echo "RESULT: PASS, with $notrun script(s) NOT RUNNABLE in this environment."
    echo "        Those checks did not happen. See the NOTRUN lines above."
  else
    echo "RESULT: PASS — every script ran and asserted."
  fi
} | tee -a "$SUMMARY"

[ "$failures" -eq 0 ]
