#!/bin/bash
# bin/yomi in the first-run lane's fresh copy of the checkout: the real helper
# ($YOMI_REAL), except in the ways a first run can go wrong. Every call is
# appended to $YOMI_FAKE_LOG, so the lane can count restarts.
#
# Capture is always aimed at $YOMI_TEST_WINDOW, a window on the invisible
# display: a first run has no config, so the app asks for its default target,
# and that is the user's own Kindle if it is open.
#
#   YOMI_FAKE=wrap         the real helper
#   YOMI_FAKE=denied       no Screen Recording: the check says so, capture fails
#   YOMI_FAKE=refuse-once  the first capture is refused, as a rebuilt helper's is
#   YOMI_FAKE=slow         the first read waits $YOMI_FAKE_DELAY s, as a new
#                          helper's does while Vision compiles its model
set -u
echo "$*" >> "${YOMI_FAKE_LOG:-/dev/null}"
MODE="${YOMI_FAKE:-wrap}"
DECLINED="SCStreamErrorDomain Code=-3801 \"The user declined TCCs for application, window, display capture\""

watching=0
for a in "$@"; do [ "$a" = --watch ] && watching=1; done

if [ "$MODE" = denied ]; then
  case " $* " in
    *" --check-permission "*) echo '{"screenRecording":false}'; exit 3 ;;
  esac
  if [ $watching = 1 ]; then echo "capture failed (1x): $DECLINED" >&2; exit 1; fi
fi

if [ $watching = 1 ]; then
  if [ "$MODE" = refuse-once ] && [ ! -e "$YOMI_FAKE_LOG.refused" ]; then
    touch "$YOMI_FAKE_LOG.refused"
    echo "capture failed (1x): $DECLINED" >&2
    exit 1
  fi
  if [ "$MODE" = slow ] && [ ! -e "$YOMI_FAKE_LOG.slow" ]; then
    touch "$YOMI_FAKE_LOG.slow"
    sleep "${YOMI_FAKE_DELAY:-8}"
  fi
  # The target the app asked for, replaced by the stage window.
  args=()
  skip=0
  for a in "$@"; do
    if [ $skip = 1 ]; then skip=0; continue; fi
    case "$a" in --bundle|--app|--window) skip=1; continue ;; esac
    args+=("$a")
  done
  exec "$YOMI_REAL" "${args[@]}" --window "$YOMI_TEST_WINDOW"
fi
exec "$YOMI_REAL" "$@"
