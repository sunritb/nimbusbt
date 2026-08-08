#!/usr/bin/env bash
# NimbusBT production deploy/start script.
# Usage:
#   ./deploy.sh start          start (or restart) the server in the background
#   ./deploy.sh stop           stop the running server
#   ./deploy.sh status         show health + URL
#   ./deploy.sh launchd        install + start as a macOS LaunchAgent (auto-start on login)
#   ./deploy.sh launchd-off    uninstall the LaunchAgent
#   ./deploy.sh logs [-f]      tail server logs
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PIDFILE="$ROOT/data/nimbusbt.pid"
LOGFILE="$ROOT/data/nimbusbt.log"
LAUNCHD_LABEL="com.nimbusbt.server"
PLIST="$HOME/Library/LaunchAgents/$LAUNCHD_LABEL.plist"
HOST="${NIMBUSBT_HOST:-127.0.0.1}"
PORT="${NIMBUSBT_PORT:-5050}"

cd "$ROOT"

start_server () {
  mkdir -p data downloads
  [ -f package-lock.json ] && npm ci --omit=dev || npm install --omit=dev
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "Already running (pid $(cat "$PIDFILE")). Use '$0 restart'."
    return 0
  fi
  nohup node src/server.js --host "$HOST" --port "$PORT" >> "$LOGFILE" 2>&1 &
  echo $! > "$PIDFILE"
  sleep 1
  if kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "Started pid $(cat "$PIDFILE"). Logs: $LOGFILE"
  else
    echo "Failed to start. See $LOGFILE"; exit 1
  fi
}

stop_server () {
  [ -f "$PIDFILE" ] || { echo "Not running."; return 0; }
  kill "$(cat "$PIDFILE")" 2>/dev/null || true
  sleep 1
  pkill -f "src/server.js" 2>/dev/null || true
  rm -f "$PIDFILE"
  echo "Stopped."
}

case "${1:-start}" in
  start)    start_server ;;
  stop)     stop_server ;;
  restart)  stop_server; start_server ;;
  status)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "Running (pid $(cat "$PIDFILE"))"
    else
      echo "Not running"; exit 1
    fi
    curl -fsS "http://$HOST:$PORT/api/health" && echo " — HTTP OK"
    echo "Web UI: http://$HOST:$PORT/"
    ;;
  launchd)
    stop_server
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LAUNCHD_LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$(command -v node)</string><string>$ROOT/src/server.js</string><string>--host</string><string>$HOST</string><string>--port</string><string>$PORT</string></array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict><key>NIMBUSBT_DATA_DIR</key><string>$ROOT/data</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOGFILE</string>
  <key>StandardErrorPath</key><string>$LOGFILE</string>
</dict></plist>
EOF
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load "$PLIST"
    sleep 2
    echo "LaunchAgent installed (auto-starts on login)."
    ;;
  launchd-off)
    launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "LaunchAgent removed."
    ;;
  logs)    tail -n 50 "${2:+-f}" "$LOGFILE" 2>/dev/null || echo "no logs yet" ;;
  *)       echo "usage: $0 start|stop|restart|status|launchd|launchd-off|logs" ;;
esac
