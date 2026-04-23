#!/bin/bash

cleanup() {
    trap - INT TERM EXIT
    local pids
    pids=$(jobs -p)
    [ -n "$pids" ] && kill $pids 2>/dev/null
    wait 2>/dev/null
}
trap cleanup INT TERM EXIT

# Load .env if present
if [ -f "$(dirname "$0")/.env" ]; then
    set -a
    source "$(dirname "$0")/.env"
    set +a
fi

# Ports and hostname can be overridden via environment variables or .env file.
HOST_NAME="${HOST_NAME:-localhost}"
BACKEND_PORT_INTERNAL="${BACKEND_PORT_INTERNAL:-8000}"
FRONTEND_PORT_INTERNAL="${FRONTEND_PORT_INTERNAL:-3000}"
BACKEND_PORT_EXTERNAL="${BACKEND_PORT_EXTERNAL:-$BACKEND_PORT_INTERNAL}"
FRONTEND_PORT_EXTERNAL="${FRONTEND_PORT_EXTERNAL:-$FRONTEND_PORT_INTERNAL}"

# HTTPS is enabled by exporting SSL_KEY and SSL_CERT (e.g. in .env);
# server.js reads them directly. Here we only derive the scheme for the banner.
SCHEME=http
[ -n "$SSL_KEY" ] && [ -n "$SSL_CERT" ] && SCHEME=https

# Kill any existing processes on the internal ports
for PORT in $BACKEND_PORT_INTERNAL $FRONTEND_PORT_INTERNAL; do
    PIDS=$(ss -tlnpH 2>/dev/null "sport = :$PORT" | grep -oP 'pid=\K[0-9]+' | sort -u)
    [ -n "$PIDS" ] && kill -9 $PIDS 2>/dev/null
done

echo "Starting backend..."
conda run -n matchmaker-demo --live-stream bash -c "cd backend && uvicorn app.main:app --reload --host 0.0.0.0 --port $BACKEND_PORT_INTERNAL" &

echo "Starting frontend (${SCHEME} + WS proxy)..."
conda run -n matchmaker-demo --live-stream bash -c "cd frontend && PORT=$FRONTEND_PORT_INTERNAL HOSTNAME=0.0.0.0 BACKEND_INTERNAL_URL=http://localhost:${BACKEND_PORT_INTERNAL} NEXT_PUBLIC_BACKEND_URL=/api node server.js" &

echo ""
echo "Backend:  http://localhost:${BACKEND_PORT_INTERNAL} (internal only)"
echo "Frontend: ${SCHEME}://${HOST_NAME}:${FRONTEND_PORT_EXTERNAL} (public)"
echo ""
echo "Press Ctrl+C to stop both."

wait
