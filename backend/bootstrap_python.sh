#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_ROOT"

VENV_DIR="$APP_ROOT/.venv"
UVICORN_BIN="$VENV_DIR/bin/uvicorn"

if [ ! -x "$UVICORN_BIN" ] || ! "$VENV_DIR/bin/python" -c "import fastapi, uvicorn, yt_dlp" >/dev/null 2>&1; then
  rm -rf "$VENV_DIR"
  python3 -m venv --without-pip "$VENV_DIR"
  curl -fsSL https://bootstrap.pypa.io/get-pip.py | "$VENV_DIR/bin/python" >/dev/null
  "$VENV_DIR/bin/pip" install --no-cache-dir -q -r "$APP_ROOT/backend/requirements.txt"
fi

exec env PYTHONPATH="$APP_ROOT" "$UVICORN_BIN" backend.main:app --host 127.0.0.1 --port 8001
