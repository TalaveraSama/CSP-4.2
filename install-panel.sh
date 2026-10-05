#!/usr/bin/env bash
#
# CSP Panel — one-shot installer for the panel alone (no NCam, no proxy).
#
#   curl -fsSL https://raw.githubusercontent.com/TalaveraSama/CSP-4.2/v0.6.0/install-panel.sh | sudo bash -s -- \
#        --backend ncam --url http://192.168.1.10:8888
#
# Use this when the softcam already exists (on this machine or another one) and
# you only want the web panel in front of it. It never touches NCam and never
# installs CardServProxy: the panel talks to the softcam you point it at with
# --backend/--url (OSCam or NCam web interface, or the proxy's status-web).
#
# Without --backend/--url it assumes OSCam at http://127.0.0.1:8888; with no
# arguments at all the prompts are answered with those defaults (stdin is the
# curl pipe), so pass what you need:
#
#   sudo bash install-panel.sh --backend ncam --url http://127.0.0.1:8888 --yes
#   sudo bash install-panel.sh --backend mock --yes      # demo, no softcam
#   sudo bash install-panel.sh --help
#
# To also install the softcam on this machine, use install.sh instead.
#
set -euo pipefail

REPO_RAW=${REPO_RAW:-https://raw.githubusercontent.com/TalaveraSama/CSP-4.2/v0.6.0}
INSTALLER=panel/packaging/install-ubuntu.sh

args=("$@")
if [ ${#args[@]} -eq 0 ]; then
  echo "==> panel only (no NCam, no proxy): assuming OSCam on http://127.0.0.1:8888"
  echo "    pass --backend/--url for anything else, or --help for the full list"
  args=(--no-ncam --yes)
fi

# Unless the caller picked a mode of their own (including --help), this script
# means "panel only": --no-ncam is added so NCam is never installed or touched.
mode_given=0
for a in "${args[@]}"; do
  case "$a" in
    --no-ncam|--install-ncam|--with-ncam|--only-ncam|--install-csp|--all|-h|--help) mode_given=1 ;;
  esac
done
[ "$mode_given" = 1 ] || args=(--no-ncam "${args[@]}")

here=""
if [ -n "${BASH_SOURCE[0]:-}" ]; then
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"
fi

if [ -n "$here" ] && [ -f "$here/$INSTALLER" ]; then
  exec bash "$here/$INSTALLER" "${args[@]}"
fi

command -v curl >/dev/null 2>&1 || { echo "install-panel.sh: curl is required" >&2; exit 1; }
tmp="$(mktemp /tmp/csp-install.XXXXXX.sh)"
trap 'rm -f "$tmp"' EXIT
if ! curl -fsSL --connect-timeout 20 --retry 2 "$REPO_RAW/$INSTALLER" -o "$tmp"; then
  echo "install-panel.sh: could not download $REPO_RAW/$INSTALLER" >&2
  echo "install-panel.sh: clone the repository and run $INSTALLER instead" >&2
  exit 1
fi
exec bash "$tmp" "${args[@]}"
