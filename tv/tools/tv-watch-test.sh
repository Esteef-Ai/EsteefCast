#!/bin/sh
# Drives EsteefCast on a real TV over adb: opens the app, selects the PC whose
# line contains $2, waits $3 seconds, and prints the app's log (stats, route,
# candidates). Use with host/test/serve-pattern.mjs running.
# Usage: sh tv-watch-test.sh <adb-device> "<text on the PC's line>" [seconds]
export MSYS_NO_PATHCONV=1
ADB="${ADB:-adb}"
D="$1"; WANT="$2"; WAIT="${3:-20}"
"$ADB" -s "$D" shell am force-stop ai.esteef.esteefcast
"$ADB" -s "$D" logcat -c
"$ADB" -s "$D" shell am start -W -n ai.esteef.esteefcast/.MainActivity >/dev/null
sleep 6
"$ADB" -s "$D" shell uiautomator dump /sdcard/ec.xml >/dev/null
# Host items are the focusable rows before "Enter address"; find which one has our text.
idx=$("$ADB" -s "$D" shell cat /sdcard/ec.xml | grep -o 'text="[^"]*"' | grep -v 'text=""' | awk -v want="$WANT" '
  /Choose a PC|PCs? found|EsteefCast"|by Esteef/ {next}
  /Enter address/ {exit}
  { n++; if (index($0, want)) { print int((n-1)/2); exit } }')
[ -z "$idx" ] && { echo "PC with '$WANT' not listed"; exit 1; }
echo "selecting row $idx"
# Focus starts on the last PC used, so go to the top first.
for _ in 1 2 3 4 5 6; do "$ADB" -s "$D" shell input keyevent DPAD_UP; done
i=0; while [ "$i" -lt "$idx" ]; do "$ADB" -s "$D" shell input keyevent DPAD_DOWN; i=$((i+1)); done
"$ADB" -s "$D" shell input keyevent DPAD_CENTER
sleep "$WAIT"
P=$("$ADB" -s "$D" shell pidof ai.esteef.esteefcast)
"$ADB" -s "$D" logcat -d -v time | grep "($P)\|( $P)" | grep -E "I/EsteefCast|Frames received" | cut -c1-230
