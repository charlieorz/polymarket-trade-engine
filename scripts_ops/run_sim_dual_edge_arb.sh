#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/home/poly/polymarket-trade-engine}"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env.sim}"
BUN_EXECUTABLE="${BUN_EXECUTABLE:-/home/poly/.bun/bin/bun}"

cd "$APP_DIR"

mkdir -p logs state

export PATH="/home/poly/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  source "$ENV_FILE"
  set +a
else
  echo "Missing env file: $ENV_FILE" >&2
  exit 2
fi

if [[ ! -x "$BUN_EXECUTABLE" ]]; then
  echo "BUN_EXECUTABLE is not executable: $BUN_EXECUTABLE" >&2
  echo "Set BUN_EXECUTABLE to the output of: command -v bun" >&2
  exit 127
fi

if [[ -n "${TRADE_WINDOW_FONT_FILE:-}" && ! -f "$TRADE_WINDOW_FONT_FILE" ]]; then
  echo "Warning: TRADE_WINDOW_FONT_FILE does not exist: $TRADE_WINDOW_FONT_FILE" >&2
  echo "Install a CJK font, for example: sudo apt-get install fonts-noto-cjk" >&2
fi

export PROD=false
export FORCE_PROD=false

SLOT_OFFSET="${POLY_SLOT_OFFSET:-1}"

args=(
  "--strategy" "dual-edge-arb"
  "--slot-offset" "$SLOT_OFFSET"
  "--always-log"
)

if [[ -n "${POLY_ROUNDS:-}" ]]; then
  args+=("--rounds" "$POLY_ROUNDS")
fi

exec "$BUN_EXECUTABLE" run index.ts "${args[@]}"
