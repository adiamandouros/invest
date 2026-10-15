#!/bin/bash
# Deploy the latest main on the server, in one command from cPanel → Terminal:
#
#   bash ~/repositories/invest/scripts/deploy.sh
#
# 1. Pulls the latest code from GitHub.
# 2. Installs packages, only if package.json or package-lock.json changed
#    (with scripts/cpanel-deploy.sh, which knows where cPanel keeps them).
# 3. Stops this app's running processes, including one stuck at startup, which
#    cPanel's Restart button doesn't replace. LiteSpeed starts a fresh one on
#    the next request. Other apps' processes are left alone.
# 4. Loads /health and says whether the app answers.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_ROOT="${APP_DIR#"$HOME"/}"
HEALTH_URL="${HEALTH_URL:-https://invest.sonovabitc.win/health}"
cd "$APP_DIR"

# ── 1. Code ─────────────────────────────────────────────────────────────────
before="$(git rev-parse HEAD)"
git pull --ff-only --quiet
after="$(git rev-parse HEAD)"
if [ "$before" = "$after" ]; then
    echo "[deploy] Already at the latest commit: $(git log --oneline -1)"
else
    echo "[deploy] Updated to: $(git log --oneline -1)"
fi

# ── 2. Packages ─────────────────────────────────────────────────────────────
if [ "$before" != "$after" ] && ! git diff --quiet "$before" "$after" -- package.json package-lock.json; then
    echo "[deploy] Packages changed: installing"
    bash scripts/cpanel-deploy.sh
fi

# ── 3. Restart ──────────────────────────────────────────────────────────────
# This app's processes: named "lsnode:<app folder>/" once started, or still
# "node …/lsnode.js" with their working folder in this app's nodevenv if stuck
pids=()
while read -r pid args; do
    if [ "${args%% *}" = "lsnode:$APP_DIR/" ]; then
        pids+=("$pid")
    elif [[ "$args" == *lsnode.js* ]] && [[ "$(readlink "/proc/$pid/cwd" 2>/dev/null)" == "$HOME/nodevenv/$APP_ROOT/"* ]]; then
        pids+=("$pid")
    fi
done < <(ps -u "$(id -u)" -o pid=,args=)

if [ "${#pids[@]}" -gt 0 ]; then
    echo "[deploy] Stopping the app's processes: ${pids[*]}"
    kill "${pids[@]}" 2>/dev/null || true
    sleep 2
    for pid in "${pids[@]}"; do
        kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
    done
else
    echo "[deploy] No app process running"
fi
# Also tell the app server, in case it looks for this file
mkdir -p tmp
touch tmp/restart.txt

# ── 4. Check ────────────────────────────────────────────────────────────────
echo "[deploy] Loading $HEALTH_URL"
if body="$(curl -sS -m 60 "$HEALTH_URL")"; then
    echo "[deploy] $body"
    if [[ "$body" == *'"status":"ok"'* ]]; then
        echo "[deploy] Done: the app is up."
        exit 0
    fi
    echo "[deploy] The app answers but isn't healthy: see stderr.log in $APP_DIR" >&2
else
    echo "[deploy] No answer from the app: see stderr.log in $APP_DIR" >&2
fi
exit 1
