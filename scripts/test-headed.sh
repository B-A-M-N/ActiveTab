#!/usr/bin/env bash
# Start a virtual X display for headed Chrome integration tests.
# This is not headless mode: Chrome renders into a real X server.
set -euo pipefail

DISPLAY_NUM=${ACTIVETAB_TEST_DISPLAY:-99}
export DISPLAY=":${DISPLAY_NUM}"

cleanup() {
  if [[ -n "${XVFB_PID:-}" ]] && kill -0 "$XVFB_PID" 2>/dev/null; then
    kill "$XVFB_PID" 2>/dev/null || true
    wait "$XVFB_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# Check if the display is already in use.
if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
  echo "Display ${DISPLAY} is already available."
else
  echo "Starting Xvfb on ${DISPLAY}..."
  Xvfb ":${DISPLAY_NUM}" -screen 0 1280x720x24 -nolisten tcp &
  XVFB_PID=$!
  # Wait for the display to become ready.
  for _ in $(seq 1 20); do
    if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then break; fi
    sleep 0.25
  done
  if ! xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
    echo "Failed to start Xvfb on ${DISPLAY}." >&2
    exit 1
  fi
  echo "Xvfb ready on ${DISPLAY}."
fi

npm test
