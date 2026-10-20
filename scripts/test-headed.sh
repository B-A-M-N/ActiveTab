#!/usr/bin/env bash
# Headed test execution with explicit display modes (P1-1).
#
# Modes (choose one; there is no silent fallback):
#   current display (default): uses the existing authorized graphical
#     session (DISPLAY must already be set). Chrome is visible and
#     interactive on the operator's desktop. Never overwrites DISPLAY.
#   --xvfb: starts Xvfb WITHIN this invocation when no graphical session
#     is available. Chrome renders graphically, but it is NOT visible on
#     the operator's desktop — do not claim the user visually observed it.
#   ACTIVETAB_HEADLESS=1: explicit operator opt-in for constrained
#     environments (this is the only headless path, and it is never a
#     silent fallback).
set -euo pipefail

USE_XVFB=0
NODE_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --xvfb) USE_XVFB=1 ;;
    *) NODE_ARGS+=("$arg") ;;
  esac
done

if [[ "${ACTIVETAB_HEADLESS:-}" == "1" ]]; then
  echo "ACTIVETAB_HEADLESS=1: explicit operator opt-in for headless execution."
  unset DISPLAY
  node --test "${NODE_ARGS[@]}"
  exit $?
fi

cleanup() {
  if [[ -n "${XVFB_PID:-}" ]] && kill -0 "$XVFB_PID" 2>/dev/null; then
    kill "$XVFB_PID" 2>/dev/null || true
    wait "$XVFB_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

if [[ "$USE_XVFB" == "1" ]]; then
  # Virtual display: pick a free display number instead of clobbering :99.
  DISPLAY_NUM=99
  while xdpyinfo -display ":${DISPLAY_NUM}" >/dev/null 2>&1; do
    DISPLAY_NUM=$((DISPLAY_NUM + 1))
  done
  export DISPLAY=":${DISPLAY_NUM}"
  # Physical monitor offsets do not map onto this 1600x1000 virtual screen.
  # Keep the disposable browser fully inside Xvfb regardless of the desktop
  # display configured in .env.local.
  export ACTIVETAB_CHROME_DISPLAY=main
  export ACTIVETAB_CHROME_MAIN_POSITION=0,0
  echo "Starting Xvfb on ${DISPLAY} (graphical rendering; not visible on the operator's desktop)..."
  Xvfb "${DISPLAY}" -screen 0 1600x1000x24 -nolisten tcp &
  XVFB_PID=$!
  for _ in $(seq 1 40); do
    if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then break; fi
    sleep 0.25
  done
  if ! xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
    echo "Failed to start Xvfb on ${DISPLAY}." >&2
    exit 1
  fi
  echo "Xvfb ready on ${DISPLAY}."
else
  # Current desktop: require a valid pre-authorized display connection.
  if [[ -z "${DISPLAY:-}" ]]; then
    echo "No DISPLAY is set. Run inside the graphical session, pass --xvfb for a virtual display, or set ACTIVETAB_HEADLESS=1 as an explicit opt-in." >&2
    exit 2
  fi
  if ! xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
    echo "DISPLAY=$DISPLAY is not reachable. Authorize/attach the graphical session, pass --xvfb, or set ACTIVETAB_HEADLESS=1 explicitly." >&2
    exit 2
  fi
  echo "Using current display ${DISPLAY} (headed, desktop-visible)."
fi

node --test "${NODE_ARGS[@]}"
