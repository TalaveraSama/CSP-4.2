#!/usr/bin/env bash
#
# CSP 4.2 — one-shot installer: the panel + NCam, no proxy.
#
#   curl -fsSL https://raw.githubusercontent.com/TalaveraSama/CSP-4.2/v0.6.0/install.sh | sudo bash
#
# With no arguments it installs the panel and NCam, configured so that **NCam
# attends your clients** over newcamd/cccam and the panel manages NCam. The
# CardServProxy java proxy is not installed (it is optional since 0.6.0: use
# --install-csp or --all if you want it in front).
#
# Any argument is passed straight to panel/packaging/install-ubuntu.sh, so:
#
#   sudo bash install.sh --backend mock --yes        # just look at the panel
#   sudo bash install.sh --no-ncam --backend oscam \
#        --url http://127.0.0.1:8888 --yes           # panel only, your softcam
#   sudo bash install.sh --all --yes                 # + the legacy proxy
#   sudo bash install.sh --help
#
# For the panel-only shape there is a script of its own: install-panel.sh
#
set -euo pipefail

REPO_RAW=${REPO_RAW:-https://raw.githubusercontent.com/TalaveraSama/CSP-4.2/v0.6.0}
INSTALLER=panel/packaging/install-ubuntu.sh

args=("$@")
# No arguments: panel + NCam, unattended (--only-ncam means exactly that: no
# proxy).
[ ${#args[@]} -eq 0 ] && args=(--only-ncam --yes)

# With arguments, --only-ncam is still the shape unless the caller picked
# another one: otherwise `install.sh --listen 0.0.0.0` would quietly install
# the panel without the softcam. --yes is only implied when there were no
# arguments at all, so an interactive run still asks.
mode_given=0
for a in "${args[@]}"; do
  case "$a" in
    --only-ncam|--no-ncam|--install-ncam|--with-ncam|--install-csp|--all|-h|--help) mode_given=1 ;;
  esac
done
[ "$mode_given" = 1 ] || args=(--only-ncam "${args[@]}")

here=""
if [ -n "${BASH_SOURCE[0]:-}" ]; then
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"
fi

# Running from a checkout: use the installer next to this file, so a local
# edit (or a different branch) is what actually runs.
if [ -n "$here" ] && [ -f "$here/$INSTALLER" ]; then
  exec bash "$here/$INSTALLER" "${args[@]}"
fi

# Piped from curl: fetch the installer, which then clones the rest itself.
command -v curl >/dev/null 2>&1 || { echo "install.sh: curl is required" >&2; exit 1; }
tmp="$(mktemp /tmp/csp-install.XXXXXX.sh)"
trap 'rm -f "$tmp"' EXIT
if ! curl -fsSL --connect-timeout 20 --retry 2 "$REPO_RAW/$INSTALLER" -o "$tmp"; then
  echo "install.sh: could not download $REPO_RAW/$INSTALLER" >&2
  echo "install.sh: clone the repository and run $INSTALLER instead" >&2
  exit 1
fi
exec bash "$tmp" "${args[@]}"
