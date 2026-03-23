#!/bin/bash

# Start backend and frontend concurrently
trap 'kill 0' EXIT

# Kill any existing processes on the ports
lsof -ti:8000 | xargs kill -9 2>/dev/null
lsof -ti:50003 | xargs kill -9 2>/dev/null

echo "Starting backend..."
conda run -n matchmaker-demo --live-stream bash -c "cd backend && uvicorn app.main:app --reload --port 8000" &

echo "Starting frontend..."
(cd frontend && npm start) &

echo ""
echo "Backend:  http://localhost:8000"
echo "Frontend: http://localhost:50003"
echo ""
echo "Press Ctrl+C to stop both."

wait
