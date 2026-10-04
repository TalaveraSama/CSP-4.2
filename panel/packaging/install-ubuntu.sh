#!/usr/bin/env bash
#
# csp-panel — one-shot installer for Ubuntu 20.04 / 22.04 / 24.04
# (also works on Debian 11/12 with --force).
#
#   sudo bash panel/packaging/install-ubuntu.sh
#   curl -fsSL <raw-url>/install-ubuntu.sh | sudo bash -s -- --backend mock -y
#   sudo bash install-ubuntu.sh --backend oscam --url http://127.0.0.1:8888 \
#                               --domain panel.example.com --yes
#
# It installs Node.js if needed, builds and installs the csp-panel .deb,
# writes /etc/csp-panel/panel.env, starts the service and (optionally)
# publishes it through nginx.
#
# Re-running it is safe: it upgrades the package and keeps your configuration.
set -euo pipefail

PKG=csp-panel
CONF_DIR=/etc/$PKG
CONF=$CONF_DIR/panel.env
NODE_MAJOR=${NODE_MAJOR:-22}       # Node.js line installed when the distro's is too old
NODE_FROM=${NODE_FROM:-auto}       # auto | nodesource | tarball | skip
NODE_MIRROR=${NODE_MIRROR:-https://nodejs.org/dist}
NET_TIMEOUT=${NET_TIMEOUT:-20}     # seconds to wait for a connection
NET_MAXTIME=${NET_MAXTIME:-600}    # seconds for a whole download
REPO_URL=${REPO_URL:-https://github.com/TalaveraSama/CSP-4.2.git}
REPO_BRANCH=${REPO_BRANCH:-arena/01a0f2ba-csp-4-2}   # branch that carries panel/
SERVICE=$PKG.service

# ---------------------------------------------------------------- options ---
BACKEND=""
TARGET_URL=""
PORT=""
LISTEN=""
DOMAIN=""
BASE_PATH=""
DEB_FILE=""
ASSUME_YES=0
FORCE=0
WANT_NGINX=auto
ACTION=install

usage() {
  cat <<EOF
csp-panel installer for Ubuntu 20.04 / 22.04 / 24.04

Usage: sudo bash install-ubuntu.sh [options]

  --backend oscam|ncam|csp|mock
                             which softcam to manage (mock = demo, no softcam)
  --url URL                  softcam web interface, e.g. http://127.0.0.1:8888
                             (OSCam/NCam httpport, or CSP status-web port 8082)
  --port N                   port the panel listens on            (default 8090)
  --listen ADDR              address the panel binds to      (default 127.0.0.1)
  --domain HOST              also configure an nginx vhost for HOST
  --base-path /csp/          serve the panel from a sub-directory instead
  --no-nginx                 never touch nginx
  --deb FILE                 install this prebuilt .deb instead of building
  --node-major N             Node.js line to install if missing   (default $NODE_MAJOR)
  --node-from WHERE          auto (default) | nodesource | tarball | skip
                             'tarball' downloads from $NODE_MIRROR (set
                             NODE_MIRROR=... for a local/geographic mirror),
                             'skip' trusts the Node.js already on the box
  -y, --yes                  non-interactive, accept the defaults
  --force                    run on a distribution that is not Ubuntu 20/22/24
  --uninstall                stop and remove the package (keeps the config)
  --purge                    remove everything, including /etc/csp-panel
  -h, --help                 this text

Examples:
  sudo bash install-ubuntu.sh                                   # guided
  sudo bash install-ubuntu.sh --backend mock -y                 # just try it
  sudo bash install-ubuntu.sh --backend oscam --url http://192.168.1.10:8888 \\
                              --domain panel.example.com -y
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --backend)     BACKEND="${2:?}"; shift 2 ;;
    --url)         TARGET_URL="${2:?}"; shift 2 ;;
    --port)        PORT="${2:?}"; shift 2 ;;
    --listen)      LISTEN="${2:?}"; shift 2 ;;
    --domain)      DOMAIN="${2:?}"; WANT_NGINX=yes; shift 2 ;;
    --base-path)   BASE_PATH="${2:?}"; shift 2 ;;
    --deb)         DEB_FILE="${2:?}"; shift 2 ;;
    --node-major)  NODE_MAJOR="${2:?}"; shift 2 ;;
    --node-from)   NODE_FROM="${2:?}"; shift 2 ;;
    --no-nginx)    WANT_NGINX=no; shift ;;
    -y|--yes)      ASSUME_YES=1; shift ;;
    --force)       FORCE=1; shift ;;
    --uninstall)   ACTION=uninstall; shift ;;
    --purge)       ACTION=purge; shift ;;
    -h|--help)     usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------- helpers ---
BOLD=''; DIM=''; RED=''; GREEN=''; YELLOW=''; OFF=''
if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'
  YELLOW=$'\033[33m'; OFF=$'\033[0m'
fi
say()  { printf '%s==>%s %s\n' "$BOLD" "$OFF" "$*"; }
ok()   { printf '%s  ok%s  %s\n' "$GREEN" "$OFF" "$*"; }
warn() { printf '%swarn%s %s\n' "$YELLOW" "$OFF" "$*" >&2; }
die()  { printf '%serr %s %s\n' "$RED" "$OFF" "$*" >&2; exit 1; }

ask() { # ask VAR "prompt" "default"
  local __var=$1 __prompt=$2 __default=$3 __reply=""
  if [ "$ASSUME_YES" = 1 ] || [ ! -t 0 ]; then
    printf -v "$__var" '%s' "$__default"
    return
  fi
  read -r -p "$__prompt [$__default]: " __reply || true
  printf -v "$__var" '%s' "${__reply:-$__default}"
}

have() { command -v "$1" >/dev/null 2>&1; }

systemd_running() { [ -d /run/systemd/system ] && systemctl is-system-running >/dev/null 2>&1; }

sctl() { # never abort the install because systemd is unhappy (containers, WSL)
  systemctl "$@" >/dev/null 2>&1 || { warn "systemctl $* failed"; return 1; }
}

set_kv() { # set_kv FILE KEY VALUE  — update in place, append when missing
  local file=$1 key=$2 value=$3
  if grep -Eq "^[#[:space:]]*${key}=" "$file"; then
    # Replace the first (commented or not) occurrence, comment out later ones.
    python3 - "$file" "$key" "$value" <<'PY'
import re, sys
path, key, value = sys.argv[1], sys.argv[2], sys.argv[3]
lines = open(path).read().splitlines()
done = False
out = []
for line in lines:
    if re.match(rf'^[#\s]*{re.escape(key)}=', line):
        if not done:
            out.append(f'{key}={value}')
            done = True
        elif not line.lstrip().startswith('#'):
            out.append('#' + line)
        else:
            out.append(line)
    else:
        out.append(line)
open(path, 'w').write('\n'.join(out) + '\n')
PY
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

# ------------------------------------------------------------ sanity check ---
if [ "$(id -u)" -ne 0 ]; then
  have sudo || die "run this script as root"
  say "re-running with sudo"
  exec sudo -E bash "$0" "$@"
fi

. /etc/os-release 2>/dev/null || die "cannot read /etc/os-release"
DISTRO="${ID:-unknown}"; RELEASE="${VERSION_ID:-unknown}"
case "$DISTRO:$RELEASE" in
  ubuntu:20.04|ubuntu:22.04|ubuntu:24.04)
    ok "$PRETTY_NAME" ;;
  *)
    if [ "$FORCE" = 1 ]; then
      warn "$PRETTY_NAME is not a supported target, continuing because of --force"
    else
      die "this installer targets Ubuntu 20.04 / 22.04 / 24.04 (found: $PRETTY_NAME).
     Use --force to try anyway (Debian 11/12 normally works)."
    fi ;;
esac

export DEBIAN_FRONTEND=noninteractive

# -------------------------------------------------------- uninstall / purge --
if [ "$ACTION" != install ]; then
  say "removing $PKG"
  if [ "$ACTION" = purge ]; then
    apt-get -y purge "$PKG" || dpkg -P "$PKG" || true
    rm -f /etc/nginx/sites-enabled/$PKG /etc/nginx/sites-available/$PKG
    have nginx && sctl reload nginx
    ok "purged (configuration and system user removed)"
  else
    apt-get -y remove "$PKG" || dpkg -r "$PKG" || true
    ok "removed ($CONF kept)"
  fi
  exit 0
fi

# ------------------------------------------------------------- apt basics ---
say "checking prerequisites"
APT_UPDATED=0
apt_update_once() { [ "$APT_UPDATED" = 1 ] || { apt-get update -qq || warn "apt-get update failed, using the cached indexes"; APT_UPDATED=1; }; }

apt_ensure() { # apt_ensure PKG [CMD] — install PKG unless CMD is already there
  local pkg=$1 cmd=${2:-$1}
  have "$cmd" && return 0
  dpkg -s "$pkg" >/dev/null 2>&1 && return 0
  apt_update_once
  apt-get install -y -qq "$pkg" >/dev/null 2>&1 || return 1
  have "$cmd" || dpkg -s "$pkg" >/dev/null 2>&1
}

for p in curl:curl ca-certificates:update-ca-certificates python3:python3; do
  apt_ensure "${p%%:*}" "${p##*:}" || warn "could not install ${p%%:*} (continuing)"
done
have curl    || die "curl is required (apt install curl)"
have python3 || die "python3 is required (apt install python3)"
ok "curl, ca-certificates, python3"

# ----------------------------------------------------------------- node.js ---
# Ubuntu ships Node 10 (20.04), 12 (22.04) and 18 (24.04): all too old, the
# panel needs >= 20. Two independent ways to get one, because NodeSource is
# blocked or unreachable on plenty of hosts:
#   1. the NodeSource apt repository (preferred: apt keeps it updated)
#   2. the official tarball from nodejs.org, unpacked into /opt/node
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
node_ok() { [ "$(node_major)" -ge 20 ] 2>/dev/null; }

# curl with sane timeouts; a second attempt forces IPv4, which is the usual
# cure for "Failed to connect ... after N ms: Connection timed out" on hosts
# with broken IPv6 routing.
fetch() {
  curl -fsSL --connect-timeout "$NET_TIMEOUT" --max-time "$NET_MAXTIME" --retry 2 --retry-delay 2 "$@" && return 0
  warn "download failed, retrying over IPv4"
  curl -4 -fsSL --connect-timeout "$NET_TIMEOUT" --max-time "$NET_MAXTIME" --retry 1 "$@"
}

install_node_nodesource() {
  say "trying NodeSource (deb.nodesource.com)"
  apt_ensure gnupg gpg || apt_ensure gnupg2 gpg || { warn "gnupg is not installed and apt cannot fetch it"; return 1; }
  install -d -m 0755 /usr/share/keyrings
  if ! fetch -o /tmp/nodesource.key https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key; then
    warn "cannot reach deb.nodesource.com"
    return 1
  fi
  gpg --dearmor --batch --yes -o /usr/share/keyrings/nodesource.gpg /tmp/nodesource.key || return 1
  rm -f /tmp/nodesource.key
  chmod 0644 /usr/share/keyrings/nodesource.gpg
  echo "deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  if apt-get update -qq -o Dir::Etc::sourcelist=/etc/apt/sources.list.d/nodesource.list \
       -o Dir::Etc::sourceparts=/dev/null -o APT::Get::List-Cleanup=0 \
     && apt-get install -y -qq nodejs; then
    APT_UPDATED=1
    node_ok && return 0
  fi
  # Never leave a dead repository behind: it would break every later apt call.
  warn "NodeSource did not work, removing its apt source again"
  rm -f /etc/apt/sources.list.d/nodesource.list
  return 1
}

install_node_tarball() {
  say "trying the official tarball ($NODE_MIRROR)"
  apt_ensure xz-utils xz || true
  local narch
  case "$(dpkg --print-architecture)" in
    amd64) narch=x64 ;;
    arm64) narch=arm64 ;;
    armhf) narch=armv7l ;;
    ppc64el) narch=ppc64le ;;
    s390x) narch=s390x ;;
    *) warn "no official Node build for $(dpkg --print-architecture)"; return 1 ;;
  esac

  local base="$NODE_MIRROR/latest-v${NODE_MAJOR}.x" sums file
  sums="$(fetch "$base/SHASUMS256.txt" || true)"
  [ -n "$sums" ] || { warn "cannot reach $base"; return 1; }
  file="$(echo "$sums" | awk -v pat="linux-$narch.tar.xz" '$2 ~ pat {print $2; exit}')"
  [ -n "$file" ] || { warn "no linux-$narch build listed at $base"; return 1; }

  local tmp; tmp="$(mktemp -d /tmp/node-dl.XXXXXX)"
  say "downloading $file"
  fetch -o "$tmp/$file" "$base/$file" || { rm -rf "$tmp"; warn "download failed"; return 1; }
  # Verify against the checksum file we already have.
  ( cd "$tmp" && echo "$sums" | grep " $file\$" | sha256sum -c - >/dev/null 2>&1 ) \
    || { rm -rf "$tmp"; warn "checksum mismatch for $file"; return 1; }

  rm -rf /opt/node && install -d -m 0755 /opt/node
  tar -xJf "$tmp/$file" -C /opt/node --strip-components=1 || { rm -rf "$tmp"; return 1; }
  rm -rf "$tmp"
  for bin in node npm npx; do
    [ -e "/opt/node/bin/$bin" ] && ln -sf "/opt/node/bin/$bin" "/usr/local/bin/$bin"
  done
  hash -r 2>/dev/null || true
  node_ok
}

say "checking Node.js"
if node_ok; then
  ok "node $(node -v) already installed"
elif [ "$NODE_FROM" = skip ]; then
  warn "no usable Node.js and --node-from skip was given; the panel will not start"
else
  say "installing Node.js ${NODE_MAJOR}.x (the distribution's version is too old)"
  INSTALLED=0
  case "$NODE_FROM" in
    nodesource) install_node_nodesource && INSTALLED=1 ;;
    tarball)    install_node_tarball && INSTALLED=1 ;;
    auto)       install_node_nodesource && INSTALLED=1 || { install_node_tarball && INSTALLED=1; } ;;
    *) die "--node-from must be auto, nodesource, tarball or skip" ;;
  esac
  if [ "$INSTALLED" != 1 ]; then
    cat >&2 <<EOF

Could not install Node.js automatically. This host cannot reach
deb.nodesource.com nor $NODE_MIRROR (firewall, proxy, DNS or IPv6 problem).

Options:
  * behind a proxy:   export https_proxy=http://proxy:3128 and run this again
  * pick a mirror:    NODE_MIRROR=https://mirrors.tuna.tsinghua.edu.cn/nodejs-release \
                        sudo -E bash $0 --node-from tarball ...
  * install Node 20+ by hand (apt/nvm/tarball), then re-run with --node-from skip
  * build the .deb on another machine and copy it over:
        bash panel/packaging/build-deb.sh      # on a machine with Node
        sudo bash install-ubuntu.sh --deb csp-panel_*_all.deb --node-from skip

EOF
    die "Node.js is required to build and run the panel"
  fi
  ok "node $(node -v)"
fi

# ----------------------------------------------------------- build the deb ---
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PANEL_DIR="$(dirname "$HERE")"

if [ -z "$DEB_FILE" ]; then
  if [ -f "$PANEL_DIR/package.json" ] && [ -f "$HERE/build-deb.sh" ]; then
    say "building the package from source"
    have dpkg-deb || apt_ensure dpkg-dev dpkg-deb || die "dpkg-deb is required (apt install dpkg-dev)"
    # Build as the owner of the checkout, so npm does not leave root-owned
    # node_modules/dist behind in somebody's working copy.
    SRC_OWNER="$(stat -c %U "$PANEL_DIR" 2>/dev/null || echo root)"
    if [ "$SRC_OWNER" != root ] && have runuser && id "$SRC_OWNER" >/dev/null 2>&1; then
      SRC_HOME="$(getent passwd "$SRC_OWNER" | cut -d: -f6)"
      say "building as $SRC_OWNER"
      runuser -u "$SRC_OWNER" -- env HOME="${SRC_HOME:-$PANEL_DIR/.buildhome}" \
        BASE_PATH="${BASE_PATH}" bash -c "cd '$PANEL_DIR' && bash packaging/build-deb.sh"
    else
      ( cd "$PANEL_DIR" && HOME="${HOME:-$PANEL_DIR/.buildhome}" \
          BASE_PATH="${BASE_PATH}" bash packaging/build-deb.sh )
    fi
    DEB_FILE="$(ls -t "$PANEL_DIR"/build/${PKG}_*_all.deb | head -1)"
  else
    DEB_FILE="$(ls -t "$HERE"/${PKG}_*_all.deb "$PWD"/${PKG}_*_all.deb 2>/dev/null | head -1 || true)"
    if [ -z "$DEB_FILE" ]; then
      # Standalone run (curl | sudo bash): fetch the sources and build them.
      say "no sources here, cloning $REPO_URL ($REPO_BRANCH)"
      have git || apt_ensure git || die "git is required to fetch the sources (apt install git)"
      have dpkg-deb || apt_ensure dpkg-dev dpkg-deb || die "dpkg-deb is required (apt install dpkg-dev)"
      SRC_TMP="$(mktemp -d /tmp/csp-panel-src.XXXXXX)"
      trap 'rm -rf "${SRC_TMP:-}"' EXIT
      git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$SRC_TMP" >/dev/null 2>&1 \
        || die "cannot clone $REPO_URL (branch $REPO_BRANCH)"
      [ -f "$SRC_TMP/panel/package.json" ] || die "$REPO_BRANCH has no panel/ directory"
      PANEL_DIR="$SRC_TMP/panel"
      ( cd "$PANEL_DIR" && HOME="$PANEL_DIR/.buildhome" BASE_PATH="${BASE_PATH}" \
          bash packaging/build-deb.sh )
      DEB_FILE="$(ls -t "$PANEL_DIR"/build/${PKG}_*_all.deb | head -1)"
    fi
  fi
fi
[ -f "$DEB_FILE" ] || die "package not found: $DEB_FILE"
ok "package $(basename "$DEB_FILE")"

say "installing the package"
if ! apt-get install -y -qq "$DEB_FILE"; then
  warn "apt refused the package, falling back to dpkg"
  dpkg -i "$DEB_FILE" || { apt-get -y -f install; dpkg -i "$DEB_FILE"; }
fi
ok "$PKG $(dpkg-query -W -f='${Version}' $PKG) installed"

# ---------------------------------------------------------- configuration ---
say "configuring $CONF"
if [ -z "$BACKEND" ]; then
  echo "  Which softcam should the panel manage?"
  echo "    oscam  OSCam web interface (/oscamapi.html)"
  echo "    ncam   NCam, the OSCam fork (/ncamapi.html)"
  echo "    csp    CardServProxy status web (/xmlHandler)"
  echo "    mock   built-in demo data, no softcam needed"
  ask BACKEND "  backend" "oscam"
fi
case "$BACKEND" in
  oscam|ncam|csp|mock) ;;
  *) die "--backend must be oscam, ncam, csp or mock" ;;
esac

if [ "$BACKEND" != mock ] && [ -z "$TARGET_URL" ]; then
  if [ "$BACKEND" = oscam ]; then
    ask TARGET_URL "  OSCam web interface URL" "http://127.0.0.1:8888"
  elif [ "$BACKEND" = ncam ]; then
    ask TARGET_URL "  NCam web interface URL" "http://127.0.0.1:8888"
  else
    ask TARGET_URL "  CardServProxy status web URL" "http://127.0.0.1:8082"
  fi
fi
[ -n "$PORT" ]   || ask PORT   "  panel port" "8090"
[ -n "$LISTEN" ] || ask LISTEN "  bind address" "127.0.0.1"

case "$BACKEND" in
  mock)
    set_kv "$CONF" BACKEND oscam
    set_kv "$CONF" MOCK 1 ;;
  oscam)
    set_kv "$CONF" BACKEND oscam
    set_kv "$CONF" OSCAM_URL "$TARGET_URL"
    set_kv "$CONF" MOCK 0 ;;
  ncam)
    set_kv "$CONF" BACKEND ncam
    set_kv "$CONF" NCAM_URL "$TARGET_URL"
    set_kv "$CONF" MOCK 0 ;;
  csp)
    set_kv "$CONF" BACKEND csp
    set_kv "$CONF" CSP_URL "$TARGET_URL"
    set_kv "$CONF" MOCK 0 ;;
esac
set_kv "$CONF" PORT "$PORT"
set_kv "$CONF" HOST "$LISTEN"
chown root:$PKG "$CONF" 2>/dev/null || true
chmod 640 "$CONF"
ok "backend=$BACKEND${TARGET_URL:+ -> $TARGET_URL}, listening on $LISTEN:$PORT"

# ----------------------------------------------------------------- service ---
say "starting the service"
if systemd_running; then
  sctl daemon-reload
  sctl enable "$SERVICE"
  systemctl restart "$SERVICE" || true
  for _ in $(seq 1 20); do
    if curl -fsS "http://${LISTEN}:${PORT}/healthz" >/dev/null 2>&1; then break; fi
    sleep 0.5
  done
  if curl -fsS "http://${LISTEN}:${PORT}/healthz" >/dev/null 2>&1; then
    ok "$(curl -fsS "http://${LISTEN}:${PORT}/healthz")"
  else
    warn "the panel did not answer on http://${LISTEN}:${PORT}/healthz"
    warn "check it with: journalctl -u $SERVICE -n 50 --no-pager"
  fi
else
  warn "systemd is not running here (container/WSL?) — start the panel manually:"
  warn "  env \$(grep -v '^#' $CONF | xargs) /usr/bin/$PKG"
fi

# ------------------------------------------------------------------- nginx ---
if [ "$WANT_NGINX" = auto ] && [ "$ASSUME_YES" != 1 ] && [ -t 0 ]; then
  ask REPLY_NGINX "  publish the panel with nginx? (domain, or empty to skip)" ""
  if [ -n "${REPLY_NGINX:-}" ]; then DOMAIN="$REPLY_NGINX"; WANT_NGINX=yes; fi
fi

if [ "$WANT_NGINX" = yes ] && [ -n "$DOMAIN" ]; then
  say "configuring nginx for $DOMAIN"
  have nginx || { apt_update_once; apt-get install -y -qq nginx; }
  cat > /etc/nginx/sites-available/$PKG <<EOF
# Managed by the csp-panel installer. Run certbot --nginx -d $DOMAIN for TLS.
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    # The panel keeps credentials in a server-side session; still, serve it
    # over https in production (certbot rewrites this block for you).
    location / {
        proxy_pass http://${LISTEN}:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 90s;
    }
}
EOF
  ln -sf /etc/nginx/sites-available/$PKG /etc/nginx/sites-enabled/$PKG
  if nginx -t >/dev/null 2>&1; then
    sctl reload nginx || sctl restart nginx
    ok "http://$DOMAIN/ -> ${LISTEN}:${PORT}"
    echo "    TLS: sudo apt install certbot python3-certbot-nginx && sudo certbot --nginx -d $DOMAIN"
  else
    warn "nginx -t failed, the vhost was written but not activated:"
    nginx -t 2>&1 | sed 's/^/     /' >&2
  fi
fi

# ----------------------------------------------------------------- summary ---
cat <<EOF

${BOLD}csp-panel is installed.${OFF}

  open       ${DOMAIN:+http://$DOMAIN/   (or }http://${LISTEN}:${PORT}/${DOMAIN:+)}
  log in     $([ "$BACKEND" = mock ] && echo 'any user/password works in mock mode ("admin" grants admin rights)' || echo "with your $BACKEND web interface credentials")
  config     sudoedit $CONF   ${DIM}then: sudo systemctl restart $SERVICE${OFF}
  status     systemctl status $SERVICE
  logs       journalctl -u $SERVICE -f
  remove     sudo bash $(basename "$0") --uninstall   ${DIM}(--purge to drop the config too)${OFF}

EOF
if [ "$BACKEND" = oscam ] || [ "$BACKEND" = ncam ]; then
  CONF_NAME=$([ "$BACKEND" = ncam ] && echo ncam.conf || echo oscam.conf)
  cat <<EOF
  ${DIM}Reminder: in $CONF_NAME [webif] set httpport, httpuser, httppwd and add this
  machine's IP to httpallowed, otherwise the panel gets 403.${OFF}

EOF
fi
