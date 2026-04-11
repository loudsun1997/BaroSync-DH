#!/usr/bin/env bash
# Starts both: FastAPI backend (port 8000) and Vite frontend (dev server).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if [[ ! -f backend/.venv/bin/uvicorn ]]; then
  echo "Backend venv missing. Run:"
  echo "  cd backend && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt"
  exit 1
fi

if [[ ! -d frontend/node_modules ]]; then
  echo "Frontend deps missing. Run:"
  echo "  cd frontend && npm install"
  exit 1
fi

BACKEND_PID=""
FRONTEND_PID=""

cleanup() {
  [[ -n "${FRONTEND_PID}" ]] && kill "${FRONTEND_PID}" 2>/dev/null || true
  [[ -n "${BACKEND_PID}" ]] && kill "${BACKEND_PID}" 2>/dev/null || true
}

trap cleanup EXIT INT TERM

echo "BaroSync DH — starting backend + frontend"
echo "  • Backend:  http://127.0.0.1:8000  (FastAPI / uvicorn --reload)"
echo "  • Frontend: Vite dev server (URL below)"
echo ""

(
  cd "${ROOT}/backend"
  exec .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
) &
BACKEND_PID=$!

(
  cd "${ROOT}/frontend"
  exec npm run dev
) &
FRONTEND_PID=$!

echo "Backend PID ${BACKEND_PID}, frontend PID ${FRONTEND_PID} — Ctrl+C stops both"
echo ""

wait
