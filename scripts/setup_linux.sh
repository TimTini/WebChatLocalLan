#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
PYTHON_VERSION="${PYTHON_VERSION:-3.11}"

export PATH="${HOME}/.local/bin:${HOME}/.cargo/bin:${PATH}"

install_uv_if_missing() {
  if command -v uv >/dev/null 2>&1; then
    echo "[setup] uv found: $(command -v uv)"
    return
  fi

  echo "[setup] uv not found, installing..."
  if command -v curl >/dev/null 2>&1; then
    curl -LsSf https://astral.sh/uv/install.sh | sh
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- https://astral.sh/uv/install.sh | sh
  else
    echo "[setup] ERROR: need curl or wget to install uv." >&2
    exit 1
  fi

  export PATH="${HOME}/.local/bin:${HOME}/.cargo/bin:${PATH}"
  if ! command -v uv >/dev/null 2>&1; then
    echo "[setup] ERROR: uv installed but not found in PATH." >&2
    exit 1
  fi
  echo "[setup] uv installed: $(command -v uv)"
}

install_uv_if_missing

cd "${PROJECT_DIR}"
echo "[setup] syncing dependencies with uv (python ${PYTHON_VERSION})..."
uv sync --python "${PYTHON_VERSION}"

echo "[setup] running health check..."
uv run python -c "from app.web import app; print('ok', app.title)"

echo "[setup] done. Start app with:"
echo "uv run python main.py"

