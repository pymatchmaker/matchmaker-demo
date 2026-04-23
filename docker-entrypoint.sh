#!/bin/sh
cleanup() {
    trap - INT TERM EXIT
    kill $BACKEND_PID $FRONTEND_PID 2>/dev/null
    wait
}
trap cleanup INT TERM EXIT

uvicorn app.main:app --host 0.0.0.0 --port 8000 --app-dir /app/backend &
BACKEND_PID=$!

BACKEND_INTERNAL_URL=http://localhost:8000 PORT=3000 HOSTNAME=0.0.0.0 node /app/frontend/server.js &
FRONTEND_PID=$!

wait
