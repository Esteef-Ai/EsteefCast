#!/bin/sh
# Drives EsteefCast on a real TV over adb: opens the app, selects the PC whose
# line contains $2, waits $3 seconds, and prints the app's log (stats, route,
# candidates). Use with host/test/serve-pattern.mjs running.
# Usage: sh tv-watch-test.sh <adb-device> "<text on the PC's line>" [seconds]
export MSYS_NO_PATHCONV=1
ADB="${ADB:-adb}"
D="$1"; WANT="$2"; WAIT="${3:-20}"
a() { "$ADB" -s "$D" "$@"; }

a shell input keyevent WAKEUP
a shell am force-stop ai.esteef.esteefcast
a logcat -c
a shell am start -W -n ai.esteef.esteefcast/.MainActivity >/dev/null
sleep 6

# The list can re-sort while PCs come and go, so move focus one row at a time
# and check the highlighted row's text before pressing OK.
focused_text() {
  a shell uiautomator dump /sdcard/ec.xml >/dev/null 2>&1
  # the focused row is a container; print the text of the nodes inside it
  a shell cat /sdcard/ec.xml | tr '>' '\n' | awk '
    /focused="true"/ { on = 1; depth = 0 }
    on && /<node/ { if (match($0, /text="[^"]*"/)) print substr($0, RSTART + 6, RLENGTH - 7) }
    on && /<\/node/ { depth++; if (depth > 2) exit }'
}

for _ in 1 2 3 4 5 6; do a shell input keyevent DPAD_UP; done
found=""
for step in 0 1 2 3 4 5 6; do
  t=$(focused_text)
  case "$t" in
    *"$WANT"*) found=1; break ;;
    *"Enter address"*) break ;;
  esac
  a shell input keyevent DPAD_DOWN
done
if [ -z "$found" ]; then echo "PC with '$WANT' not listed"; exit 1; fi
echo "selected: $(echo "$t" | tr '\n' ' ')"
a shell input keyevent DPAD_CENTER
sleep "$WAIT"
# Read by tag (the log was cleared at the start, so every line is from this run).
a logcat -d -v time -s EsteefCast:I | grep "I/EsteefCast" | cut -c1-230
