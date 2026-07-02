#!/bin/bash
# Dev Proxy management script for HyperNeo tests
# Usage: ./scripts/dev-proxy.sh [start|stop|status|restart]

set -e

DEV_PROXY_DIR="$(cd "$(dirname "$0")/.." && pwd)/.devproxy"
PID_FILE="$DEV_PROXY_DIR/.devproxy.pid"
LOG_FILE="$DEV_PROXY_DIR/devproxy.log"
PORT="${DEV_PROXY_PORT:-8000}"

start_proxy() {
	if [ -f "$PID_FILE" ]; then
		PID=$(cat "$PID_FILE")
		if ps -p "$PID" > /dev/null 2>&1; then
			echo "Dev Proxy is already running (PID: $PID)"
			return 0
		else
			echo "Removing stale PID file"
			rm -f "$PID_FILE"
		fi
	fi

	echo "Starting Dev Proxy on port $PORT..."

	# Check if devproxy is installed
	if ! command -v devproxy &> /dev/null; then
		echo "Error: devproxy is not installed."
		echo ""
		echo "Install with Homebrew (macOS):"
		echo "  brew tap dotnet/dev-proxy"
		echo "  brew install dev-proxy"
		echo ""
		echo "Or follow instructions at:"
		echo "  https://learn.microsoft.com/en-us/microsoft-cloud/dev/dev-proxy/get-started/set-up"
		exit 1
	fi

	# Start Dev Proxy in detached mode (requires v2.2.0+)
	cd "$DEV_PROXY_DIR"
	nohup devproxy --no-first-run --record --log-level information --port "$PORT" > "$LOG_FILE" 2>&1 &
	PID=$!
	echo $PID > "$PID_FILE"

	# Wait a moment and check if it started successfully
	sleep 2
	if ps -p "$PID" > /dev/null 2>&1; then
		echo "Dev Proxy started successfully (PID: $PID)"
		echo "  Port: $PORT"
		echo "  Log: $LOG_FILE"
		echo ""
		echo "Environment variables for tests:"
		echo "  export HTTPS_PROXY=http://127.0.0.1:$PORT"
		echo "  export HTTP_PROXY=http://127.0.0.1:$PORT"
		echo "  export NODE_USE_ENV_PROXY=1"
		echo "  export NODE_EXTRA_CA_CERTS=~/.proxy/rootCA.pem"
	else
		echo "Error: Dev Proxy failed to start. Check log file: $LOG_FILE"
		rm -f "$PID_FILE"
		exit 1
	fi
}

stop_proxy() {
	if [ ! -f "$PID_FILE" ]; then
		echo "Dev Proxy is not running (no PID file found)"
		return 0
	fi

	PID=$(cat "$PID_FILE")
	if ps -p "$PID" > /dev/null 2>&1; then
		echo "Stopping Dev Proxy (PID: $PID)..."
		kill "$PID" 2>/dev/null || true

		# Wait for process to terminate
		for i in {1..10}; do
			if ! ps -p "$PID" > /dev/null 2>&1; then
				break
			fi
			sleep 0.5
		done

		# Force kill if still running
		if ps -p "$PID" > /dev/null 2>&1; then
			echo "Force killing Dev Proxy..."
			kill -9 "$PID" 2>/dev/null || true
		fi

		rm -f "$PID_FILE"
		echo "Dev Proxy stopped"
	else
		echo "Dev Proxy is not running (removing stale PID file)"
		rm -f "$PID_FILE"
	fi
}

status_proxy() {
	if [ ! -f "$PID_FILE" ]; then
		echo "Dev Proxy is not running"
		return 1
	fi

	PID=$(cat "$PID_FILE")
	if ps -p "$PID" > /dev/null 2>&1; then
		echo "Dev Proxy is running (PID: $PID, Port: $PORT)"
		return 0
	else
		echo "Dev Proxy is not running (stale PID file)"
		return 1
	fi
}

case "${1:-}" in
	start)
		start_proxy
		;;
	stop)
		stop_proxy
		;;
	status)
		status_proxy
		;;
	restart)
		stop_proxy
		start_proxy
		;;
	*)
		echo "Usage: $0 {start|stop|status|restart}"
		echo ""
		echo "Environment variables:"
		echo "  DEV_PROXY_PORT  Port to run Dev Proxy on (default: 8000)"
		exit 1
		;;
esac
