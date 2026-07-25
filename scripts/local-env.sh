#!/usr/bin/env bash
# Bring up (or tear down) the dependencies the e2e suite needs on a laptop:
# NATS, a Selenium Grid, a Playwright server, a CDP Chromium, and the four
# AntiCapTrad services built from their sibling repos.
#
#   ./scripts/local-env.sh up      # start everything and print the env to export
#   ./scripts/local-env.sh env     # re-print the env for an already-running stack
#   ./scripts/local-env.sh status  # show what is listening
#   ./scripts/local-env.sh down    # stop everything
#
# Services are addressed from the test process on 127.0.0.1 and from the
# containerized browser on the host's LAN IP, which both can reach.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SIBLINGS="$(cd "$REPO_ROOT/.." && pwd)"
RUN_DIR="${ACT_E2E_RUN_DIR:-${TMPDIR:-/tmp}/act-e2e-local}"
PID_FILE="$RUN_DIR/pids"

API_PORT=${API_PORT:-8080}
WEB_PORT=${WEB_PORT:-8081}
MCP_PORT=${MCP_PORT:-8082}
AI_PORT=${AI_PORT:-3000}
PW_PORT=${PW_PORT:-3100}
CDP_PORT=${CDP_PORT:-9222}
JWT_SECRET=${JWT_SECRET:-local-e2e-secret}
SERVER_AUTH_SECRET=${SERVER_AUTH_SECRET:-local-e2e-server-auth}

lan_ip() {
  if command -v ipconfig >/dev/null 2>&1; then
    ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null
  else
    hostname -I 2>/dev/null | awk '{print $1}'
  fi
}

track() { echo "$1" >> "$PID_FILE"; }

# Launch a long-running process fully detached from this script's stdio.
# Without closing stdin/stdout the children keep the script's pipe open, so
# `local-env.sh up | tee` would never see EOF and appear to hang.
spawn() {
  local name=$1; shift
  nohup "$@" </dev/null >"$RUN_DIR/$name.log" 2>&1 &
  track $!
}

wait_for_http() {
  local url=$1 name=$2
  for _ in $(seq 1 60); do
    if curl -fsS -m 2 "$url" >/dev/null 2>&1; then echo "  ready: $name"; return 0; fi
    sleep 1
  done
  echo "  TIMEOUT waiting for $name ($url)" >&2
  return 1
}

up() {
  mkdir -p "$RUN_DIR"
  : > "$PID_FILE"

  echo "== dependencies =="
  docker rm -f act-e2e-nats act-e2e-selenium >/dev/null 2>&1 || true
  docker run -d --name act-e2e-nats -p 4222:4222 nats:2-alpine >/dev/null
  docker run -d --name act-e2e-selenium --shm-size=2g -p 4444:4444 \
    selenium/standalone-chromium:latest >/dev/null
  wait_for_http "http://127.0.0.1:4444/wd/hub/status" "selenium grid"

  echo "== browsers =="
  npx --yes playwright install chromium >/dev/null 2>&1
  spawn playwright npx --yes playwright run-server --port "$PW_PORT" --host 127.0.0.1
  # Search only the cache dirs that exist; `find` fails on a missing path and
  # would trip `set -e`.
  local shell_bin=""
  for cache in "$HOME/Library/Caches/ms-playwright" "$HOME/.cache/ms-playwright"; do
    [ -d "$cache" ] || continue
    shell_bin=$(find "$cache" -name 'headless_shell' -type f 2>/dev/null | head -1 || true)
    [ -n "$shell_bin" ] && break
  done
  if [ -z "$shell_bin" ]; then
    echo "  could not locate a headless_shell binary; run: npx playwright install chromium" >&2
    return 1
  fi
  spawn cdp "$shell_bin" --remote-debugging-port="$CDP_PORT" --headless --no-sandbox
  wait_for_http "http://127.0.0.1:$CDP_PORT/json/version" "cdp chromium"

  echo "== services =="
  PORT=$API_PORT NATS_URL=nats://127.0.0.1:4222 \
    spawn api "$SIBLINGS/act-api-server.rs/target/debug/act_api_server"
  PORT=$WEB_PORT SUPABASE_JWT_SECRET="$JWT_SECRET" \
    spawn web "$SIBLINGS/act-web-server.rs/target/debug/act_web_server"
  PORT=$MCP_PORT SERVER_AUTH_SECRET="$SERVER_AUTH_SECRET" \
    spawn mcp "$SIBLINGS/act-mcp-server.rs/target/debug/act_mcp_server"
  ( cd "$SIBLINGS/act-ai-server.ts" && PORT=$AI_PORT \
    SERVER_AUTH_SECRET="$SERVER_AUTH_SECRET" spawn ai node dist/index.js )

  for p in "$API_PORT api" "$WEB_PORT web" "$MCP_PORT mcp" "$AI_PORT ai"; do
    wait_for_http "http://127.0.0.1:${p%% *}/health" "${p##* } server"
  done

  echo
  env_block
}

env_block() {
  local lan cdp_ws
  lan=$(lan_ip)
  cdp_ws=$(curl -fsS -m 5 "http://127.0.0.1:$CDP_PORT/json/version" \
    | sed -n 's/.*"webSocketDebuggerUrl": *"\([^"]*\)".*/\1/p')
  cat <<EOF
# eval "\$(./scripts/local-env.sh env)" then: npm test
export ACT_API_URL=http://127.0.0.1:$API_PORT
export ACT_WEB_URL=http://127.0.0.1:$WEB_PORT
export ACT_AI_URL=http://127.0.0.1:$AI_PORT
export ACT_MCP_URL=http://127.0.0.1:$MCP_PORT
export BROWSER_ACT_API_URL=http://$lan:$API_PORT
export BROWSER_ACT_WEB_URL=http://$lan:$WEB_PORT
export BROWSER_ACT_AI_URL=http://$lan:$AI_PORT
export BROWSER_ACT_MCP_URL=http://$lan:$MCP_PORT
export NATS_URL=nats://127.0.0.1:4222
export SUPABASE_JWT_SECRET=$JWT_SECRET
export ACT_SERVER_AUTH_SECRET=$SERVER_AUTH_SECRET
export PLAYWRIGHT_WS_ENDPOINT=ws://127.0.0.1:$PW_PORT/
export PUPPETEER_WS_ENDPOINT=$cdp_ws
export SELENIUM_URL=http://127.0.0.1:4444/wd/hub
export E2E_TIMEOUT_MS=30000
EOF
}

status() {
  echo "== listening =="
  lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null \
    | grep -E ":($API_PORT|$WEB_PORT|$MCP_PORT|$AI_PORT|$PW_PORT|$CDP_PORT|4222|4444) " \
    | awk '{print "  " $1, $9}' | sort -u || echo "  nothing"
  echo "== containers =="
  docker ps --filter name=act-e2e --format '  {{.Names}} {{.Status}}' || true
}

down() {
  if [ -f "$PID_FILE" ]; then
    while read -r pid; do [ -n "$pid" ] && kill "$pid" 2>/dev/null || true; done < "$PID_FILE"
  fi
  pkill -f 'playwright.*run-server' 2>/dev/null || true
  pkill -f 'headless_shell' 2>/dev/null || true
  docker rm -f act-e2e-nats act-e2e-selenium >/dev/null 2>&1 || true
  echo "stopped"
}

case "${1:-up}" in
  up) up ;;
  env) env_block ;;
  status) status ;;
  down) down ;;
  *) echo "usage: $0 {up|env|status|down}" >&2; exit 2 ;;
esac
