#!/bin/bash
# Cloud (Claude Code on the web) session setup for Bob. Makes a fresh
# container able to run the same gates a local machine runs:
#   - npm install (root workspace; the container caches node_modules after this)
#   - PlatformIO for `npm run device:compile` / the `validate` firmware step
#     (python3; apps/cardputer/scripts/run-pio.mjs uses python3 off Windows)
#   - a Docker daemon for the pg-template database suites in `npm run validate`
# Firmware host tests (`npm run test:firmware`) only need the g++ already in
# the image. A cloud session has no Cardputer attached: flashing and HIL stay
# with the device agent (docs/cardputer/hil.md).
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

echo "[session-start] npm install"
npm install --no-audit --no-fund --loglevel=error

if ! python3 -m platformio --version >/dev/null 2>&1; then
  echo "[session-start] installing PlatformIO"
  python3 -m pip install --quiet --disable-pip-version-check --root-user-action=ignore platformio
fi
python3 -m platformio --version

if command -v dockerd >/dev/null 2>&1 && ! docker info >/dev/null 2>&1; then
  echo "[session-start] starting dockerd"
  nohup dockerd >/tmp/dockerd.log 2>&1 &
  for _ in $(seq 1 30); do
    docker info >/dev/null 2>&1 && break
    sleep 1
  done
fi
if docker info >/dev/null 2>&1; then
  echo "[session-start] docker ready"
else
  echo "[session-start] docker unavailable: database suites in validate will fail (see /tmp/dockerd.log)"
fi

echo 'export BOB_PIO_PY=python3' >> "${CLAUDE_ENV_FILE:-/dev/null}"
