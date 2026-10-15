#!/bin/bash
# Run by cPanel's "Git Version Control" on deploy (see .cpanel.yml):
# installs dependencies and restarts the Node.js app.
#
# cPanel's "Setup Node.js App" (CloudLinux Node.js Selector) keeps an app's
# packages outside the app: node_modules in the app folder is a symlink to
# ~/nodevenv/<app folder>/<version>/lib/node_modules. Running npm in the app
# folder would replace that symlink with a plain folder the app server
# doesn't use, so packages are installed where the symlink points instead.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_ROOT="${APP_DIR#"$HOME"/}"
cd "$APP_DIR"
echo "[deploy] App folder: $APP_DIR"

# 1. CloudLinux's own tool — the same thing the "Run NPM Install" and "Restart" buttons do
if command -v cloudlinux-selector >/dev/null; then
    echo "[deploy] Using cloudlinux-selector"
    # --skip-web-check: the tool otherwise compares the app's response before and
    # after, and reports an error whenever it changes — e.g. when a broken app
    # starts working again
    if cloudlinux-selector install-modules --json --interpreter nodejs --app-root "$APP_ROOT" --skip-web-check \
        && cloudlinux-selector restart --json --interpreter nodejs --app-root "$APP_ROOT" --skip-web-check; then
        echo "[deploy] Done."
        exit 0
    fi
    echo "[deploy] cloudlinux-selector failed — installing with npm instead"
fi

# 2. npm from the app's environment (the newest Node.js version set up for it)
ACTIVATE="$(ls -d "$HOME/nodevenv/$APP_ROOT"/*/bin/activate 2>/dev/null | sort -V | tail -n 1 || true)"
if [ -n "$ACTIVATE" ]; then
    echo "[deploy] Using $ACTIVATE"
    # shellcheck disable=SC1090
    source "$ACTIVATE"
fi
if ! command -v npm >/dev/null; then
    echo "[deploy] npm not found. Use \"Run NPM Install\" on the app's page in cPanel → Setup Node.js App." >&2
    exit 1
fi
echo "[deploy] node $(node -v), npm $(npm -v)"

if [ -L node_modules ]; then
    # Install next to the symlink's target, with this app's package files
    TARGET="$(readlink node_modules)"
    INSTALL_DIR="$(dirname "$TARGET")"
    mkdir -p "$TARGET"
    ln -sf "$APP_DIR/package.json" "$INSTALL_DIR/package.json"
    ln -sf "$APP_DIR/package-lock.json" "$INSTALL_DIR/package-lock.json"
    echo "[deploy] node_modules -> $TARGET; installing in $INSTALL_DIR"
else
    INSTALL_DIR="$APP_DIR"
fi
(cd "$INSTALL_DIR" && npm install --omit=dev --no-audit --no-fund)

# Passenger (which runs Node.js apps on cPanel) restarts the app when this file changes
mkdir -p tmp
touch tmp/restart.txt
echo "[deploy] Done — the app restarts on its next request."
