#!/usr/bin/env bash
#
# CSP 4.2 — one-shot installer.
#
#   curl -fsSL https://raw.githubusercontent.com/TalaveraSama/CSP-4.2/arena/01a0f2ba-csp-4-2/install.sh | sudo bash
#
# With no arguments it installs the whole stack: the web panel, NCam, the
# CardServProxy java proxy wired to it, and the cache cluster peer. Any
# argument is passed straight to panel/packaging/install-ubuntu.sh, so:
#
#   sudo bash install.sh --backend mock --yes        # just look at the panel
#   sudo bash install.sh --install-ncam --yes        # panel + softcam only
#   sudo bash install.sh --help
#
set -euo pipefail

REPO_RAW=${REPO_RAW:-https://raw.githubusercontent.com/TalaveraSama/CSP-4.2/arena/01a0f2ba-csp-4-2}
INSTALLER=panel/packaging/install-ubuntu.sh

args=("$@")
[ ${#args[@]} -eq 0 ] && args=(--all --yes)

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
