#!/usr/bin/env bash
# Build the CSP/OSCam panel for a production deployment (aaPanel, systemd, bare).
#
#   cd /www/wwwroot/csp-panel/panel
#   bash deploy/aapanel/install.sh
#   BASE_PATH=/csp/ bash deploy/aapanel/install.sh   # sub-directory deployment
set -euo pipefail

cd "$(dirname "$0")/../.."
PANEL_DIR="$(pwd)"

# aaPanel keeps node outside the default PATH; pick the newest it installed.
if ! command -v node >/dev/null 2>&1; then
  for candidate in /www/server/nodejs/v*/bin; do
    [ -d "$candidate" ] && PATH="$candidate:$PATH"
  done
  export PATH
fi

command -v node >/dev/null 2>&1 || { echo "ERROR: node not found. Install Node 20+ from the aaPanel App Store."; exit 1; }

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "ERROR: Node $(node -v) is too old, this panel needs Node 20 or newer."
  exit 1
fi

echo "==> panel:   $PANEL_DIR"
echo "==> node:    $(node -v)  ($(command -v node))"
echo "==> npm:     $(npm -v)"
[ -n "${BASE_PATH:-}" ] && echo "==> base:    $BASE_PATH"

echo "==> installing dependencies"
npm install --no-audit --no-fund

echo "==> building frontend + server"
npm run build

if [ ! -f .env ]; then
  cp .env.example .env
  echo "==> created .env from .env.example  --  EDIT IT before starting:"
  echo "    $PANEL_DIR/.env"
fi

cat <<EOF

Build finished.

  start manually : cd $PANEL_DIR && npm start
  start with pm2 : pm2 start $PANEL_DIR/deploy/aapanel/ecosystem.config.cjs && pm2 save
  health check   : curl http://127.0.0.1:\${PORT:-8090}/healthz

Next: point nginx at it (deploy/aapanel/nginx-subdomain.conf) and set your
backend in .env (BACKEND=oscam + OSCAM_URL=..., or BACKEND=csp + CSP_URL=...).
EOF
