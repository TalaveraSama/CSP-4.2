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
# $0 is "bash" when the script is piped from curl: use a name users can retype.
SELF="$(basename "${BASH_SOURCE[0]:-$0}")"
case "$SELF" in bash|sh|-bash|-sh|"") SELF="install-ubuntu.sh" ;; esac
CONF_DIR=/etc/$PKG
CONF=$CONF_DIR/panel.env
INSTALL_NCAM=0
INSTALL_CSP=0
READER_URL=""
READER_LABEL=""
READER_GROUP=""

ALL_IN_ONE=0
CACHE_PEERS_HINT=""
CACHE_NODE_PORT=""

CSP_WEB_PORT=""
CSP_USER=""
CSP_PASS=""
CSP_CLIENT_PORT=""
CSP_CAID=""
CSP_PREFIX=/opt/cardservproxy
CSP_CACHE_PORT=""
NCAM_CACHE_PORT=""
NCAM_NEWCAMD_PORT=""

NCAM_PORT=""
NCAM_USER=""
NCAM_PASS=""
NCAM_REPO=${NCAM_REPO:-https://github.com/fairbird/NCam.git}
NCAM_MAKE_FLAGS=${NCAM_MAKE_FLAGS:-}
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
  --all                      everything in one go: panel + NCam + CardServProxy
                             + cache peer, wired together and ready to use
                             (the panel then manages the proxy)
  --only-ncam                panel + NCam, no proxy: the panel manages NCam
  --install-ncam             also build and install NCam itself (from
                             vendor/ncam, GPL-3) as the ncam.service unit, with
                             its web interface enabled, and point the panel at it
  --ncam-port N              NCam web interface port              (default 8888)
  --ncam-user NAME           NCam web interface user              (default admin)
  --ncam-pass PASS           NCam web interface password      (default: random)
  --install-csp              also build and install the CardServProxy java
                             proxy, wire it to NCam (newcamd connector + CSP
                             cache link) and point the panel at it
  --csp-port N               CSP status-web port                  (default 8082)
  --csp-user NAME            CSP admin account                   (default admin)
  --csp-pass PASS            CSP admin password               (default: random)
  --csp-client-port N        newcamd port your clients connect to (default 10001)
  --csp-caid HEX             CA id of the profile CSP serves   (default 0x0B00)
  --cache-peers LIST         host:port,… of the CSP cache cluster to join; the
                             panel then shows a Cache tab (implied by --install-csp)
  --cache-port N             udp port of our own cache peer      (default 54280)
  --deb FILE                 install this prebuilt .deb instead of building
  --node-major N             Node.js line to install if missing   (default $NODE_MAJOR)
  --node-from WHERE          auto (default) | nodesource | tarball | skip
                             'tarball' downloads from $NODE_MIRROR (set
                             NODE_MIRROR=... for a local/geographic mirror),
                             'skip' trusts the Node.js already on the box
  -y, --yes                  non-interactive, accept the defaults
  --force                    run on a distribution that is not Ubuntu 20/22/24
  --migrate-users            move the proxy's client accounts out of proxy.xml
                             into users.xml (XmlUserManager), so adding an
                             account no longer reloads the proxy — do this
                             before you get to hundreds of accounts
  --credentials              show which accounts exist and where they live
  --reset-password [PASS]    give the panel admin account a new password
                             (random when PASS is omitted)
  --add-user NAME [PASS]     add a client account (CSP proxy.xml or ncam.user)
  --add-reader URL           add a card source to ncam.server, e.g.
                             cccam://user:pass@host:12000 or
                             newcamd://user:pass@host:10000?key=0102...14
                             (--reader-label NAME, --reader-group N)
  --uninstall                stop and remove the package (keeps the config)
  --purge                    remove everything, including /etc/csp-panel
  -h, --help                 this text

Examples:
  sudo bash install-ubuntu.sh                                   # guided
  sudo bash install-ubuntu.sh --backend mock -y                 # just try it
  sudo bash install-ubuntu.sh --backend oscam --url http://192.168.1.10:8888 \\
                              --domain panel.example.com -y
  sudo bash install-ubuntu.sh --install-ncam --backend ncam -y    # softcam + panel
  sudo bash install-ubuntu.sh --all -y                           # the whole stack
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
    --all)         ALL_IN_ONE=1; INSTALL_NCAM=1; INSTALL_CSP=1; shift ;;
    --only-ncam)   INSTALL_NCAM=1; INSTALL_CSP=0; BACKEND=ncam; shift ;;
    --add-reader)  ACTION=addreader; READER_URL="${2:?--add-reader needs a url like cccam://user:pass@host:port}"; shift 2 ;;
    --reader-label) READER_LABEL="${2:?}"; shift 2 ;;
    --reader-group) READER_GROUP="${2:?}"; shift 2 ;;
    --install-ncam) INSTALL_NCAM=1; shift ;;
    --ncam-port)   NCAM_PORT="${2:?}"; shift 2 ;;
    --ncam-user)   NCAM_USER="${2:?}"; shift 2 ;;
    --ncam-pass)   NCAM_PASS="${2:?}"; shift 2 ;;
    --install-csp) INSTALL_CSP=1; shift ;;
    --csp-port)    CSP_WEB_PORT="${2:?}"; shift 2 ;;
    --csp-user)    CSP_USER="${2:?}"; shift 2 ;;
    --csp-pass)    CSP_PASS="${2:?}"; shift 2 ;;
    --csp-client-port) CSP_CLIENT_PORT="${2:?}"; shift 2 ;;
    --csp-caid)    CSP_CAID="${2:?}"; shift 2 ;;
    --cache-peers) CACHE_PEERS_HINT="${2:?}"; shift 2 ;;
    --cache-port)  CACHE_NODE_PORT="${2:?}"; shift 2 ;;
    -y|--yes)      ASSUME_YES=1; shift ;;
    --force)       FORCE=1; shift ;;
    --credentials) ACTION=credentials; shift ;;
    --migrate-users) ACTION=migrate; shift ;;
    --reset-password) ACTION=reset; NEW_PASSWORD="${2:-}"; [ -n "${2:-}" ] && shift; shift ;;
    --add-user)    ACTION=adduser; NEW_USER="${2:?--add-user needs a name}"; NEW_PASSWORD="${3:-}"; shift 2; [ -n "${NEW_PASSWORD:-}" ] && shift || true ;;
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

# Asking about accounts or removing the package works on any distribution;
# only an actual install cares which one this is.
. /etc/os-release 2>/dev/null || die "cannot read /etc/os-release"
DISTRO="${ID:-unknown}"; RELEASE="${VERSION_ID:-unknown}"
case "$([ "$ACTION" = install ] && echo "$DISTRO:$RELEASE" || echo ubuntu:22.04)" in
  ubuntu:20.04|ubuntu:22.04|ubuntu:24.04)
    [ "$ACTION" = install ] && ok "$PRETTY_NAME" ;;
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

# ------------------------------------------------------------- credentials ---
# Nothing in this stack has a password database of its own: the panel forwards
# the login to whatever it manages. So "what is my password" always means one
# of two files.
NCAM_CONF=/etc/ncam/ncam.conf
CSP_CONF=/etc/cardservproxy/proxy.xml

random_password() { head -c 12 /dev/urandom | base64 | tr -d '/+=' | head -c 14; }

panel_backend() { [ -f "$CONF" ] && sed -n 's/^[[:space:]]*BACKEND[[:space:]]*=[[:space:]]*//p' "$CONF" | tail -1; }

ini_get() { sed -n "s/^[[:space:]]*$2[[:space:]]*=[[:space:]]*//p" "$1" 2>/dev/null | tail -1 | tr -d '\r'; }

show_credentials() {
  local backend; backend="$(panel_backend)"
  echo
  echo "${BOLD}Where the passwords live${OFF}"
  echo

  if [ -f "$CSP_CONF" ]; then
    echo "  ${BOLD}CardServProxy${OFF}  $CSP_CONF"
    sed -n 's/.*<user \(.*\)\/>.*/\1/p' "$CSP_CONF" | while read -r line; do
      local name pass admin
      name=$(echo "$line" | sed -n 's/.*name="\([^"]*\)".*/\1/p')
      pass=$(echo "$line" | sed -n 's/.*password="\([^"]*\)".*/\1/p')
      admin=$(echo "$line" | grep -q 'admin="true"' && echo ' (admin)' || echo '')
      printf '    %-18s %s%s\n' "$name" "$pass" "$admin"
    done
    [ "$backend" = csp ] && echo "    ${DIM}the panel logs in here${OFF}"
    echo
  fi

  if [ -f "$NCAM_CONF" ]; then
    echo "  ${BOLD}NCam web interface${OFF}  $NCAM_CONF  [webif]"
    printf '    %-18s %s\n' "$(ini_get "$NCAM_CONF" httpuser)" "$(ini_get "$NCAM_CONF" httppwd)"
    { [ "$backend" = ncam ] || [ "$backend" = oscam ]; } && echo "    ${DIM}the panel logs in here${OFF}"
    echo
    if [ -f /etc/ncam/ncam.user ]; then
      local users; users="$(grep -c '^\[account\]' /etc/ncam/ncam.user 2>/dev/null || echo 0)"
      echo "  ${BOLD}NCam client accounts${OFF}  /etc/ncam/ncam.user  ($users)"
      awk '/^\[account\]/{u="";p=""} /^user/{sub(/^user[ \t]*=[ \t]*/,"");u=$0} /^pwd/{sub(/^pwd[ \t]*=[ \t]*/,"");p=$0; if(u!="") printf "    %-18s %s\n", u, p}' /etc/ncam/ncam.user
      echo
    fi
  fi

  if [ ! -f "$CSP_CONF" ] && [ ! -f "$NCAM_CONF" ]; then
    if [ "$(ini_get "$CONF" MOCK)" = 1 ]; then
      echo "  The panel is in demo mode: ${BOLD}any user and password works${OFF} (\"admin\" is an admin)."
    else
      echo "  No softcam configuration found here. The panel forwards the login to"
      echo "  $(ini_get "$CONF" OSCAM_URL)$(ini_get "$CONF" NCAM_URL)$(ini_get "$CONF" CSP_URL),"
      echo "  so the credentials are the ones configured on that machine."
    fi
    echo
  fi

  echo "  ${DIM}new password: sudo bash $SELF --reset-password${OFF}"
  echo "  ${DIM}new client:   sudo bash $SELF --add-user NAME [PASSWORD]${OFF}"
  echo
}

reset_password() {
  local pass="${NEW_PASSWORD:-$(random_password)}" backend; backend="$(panel_backend)"
  if [ "$backend" = csp ] && [ -f "$CSP_CONF" ]; then
    local user
    user=$(grep -o '<user [^>]*admin="true"[^>]*/>' "$CSP_CONF" | head -1 | sed -n 's/.*name="\([^"]*\)".*/\1/p')
    [ -n "$user" ] || die "no admin account in $CSP_CONF"
    python3 - "$CSP_CONF" "$user" "$pass" <<'PY'
import re, sys
path, user, pw = sys.argv[1:4]
text = open(path).read()
pattern = re.compile(r'(<user\b[^>]*name="%s"[^>]*?password=")[^"]*(")' % re.escape(user))
new, n = pattern.subn(lambda m: m.group(1) + pw.replace('&', '&amp;').replace('"', '&quot;') + m.group(2), text)
if not n:
    sys.exit(f"could not find the password of {user}")
open(path, 'w').write(new)
PY
    systemd_running && systemctl restart cardservproxy.service 2>/dev/null || true
    ok "CardServProxy admin: ${BOLD}$user / $pass${OFF}"
  elif [ -f "$NCAM_CONF" ]; then
    local user; user="$(ini_get "$NCAM_CONF" httpuser)"
    sed -i "s|^httppwd .*|httppwd                       = $pass|" "$NCAM_CONF"
    systemd_running && systemctl restart ncam.service 2>/dev/null || true
    ok "NCam web interface: ${BOLD}${user:-admin} / $pass${OFF}"
  else
    die "no $CSP_CONF and no $NCAM_CONF: nothing to reset on this machine"
  fi
  systemd_running && systemctl restart "$SERVICE" 2>/dev/null || true
}

add_user() {
  local pass="${NEW_PASSWORD:-$(random_password)}" backend; backend="$(panel_backend)"
  if [ "$backend" = csp ] && [ -f "$CSP_CONF" ]; then
    grep -q "name=\"$NEW_USER\"" "$CSP_CONF" && die "the account \"$NEW_USER\" already exists"
    python3 - "$CSP_CONF" "$NEW_USER" "$pass" <<'PY'
import re, sys
path, user, pw = sys.argv[1:4]
text = open(path).read()
entry = '<user name="%s" password="%s"/>' % (user, pw.replace('&', '&amp;').replace('"', '&quot;'))
# SimpleUserManager reads user-manager/auth-config/user, so the account has to
# go inside <auth-config> whenever the file has one.
m = re.search(r'([ \t]*)<\/auth-config\s*>', text) or re.search(r'([ \t]*)<\/user-manager\s*>', text)
if not m:
    sys.exit('proxy.xml has no <user-manager> section')
text = text[:m.start()] + m.group(1) + '  ' + entry + '\n' + text[m.start():]
open(path, 'w').write(text)
PY
    systemd_running && systemctl restart cardservproxy.service 2>/dev/null || true
    ok "CardServProxy client: ${BOLD}$NEW_USER / $pass${OFF}  (newcamd port, profile from proxy.xml)"
  elif [ -f /etc/ncam/ncam.user ]; then
    grep -qE "^user[[:space:]]*=[[:space:]]*$NEW_USER$" /etc/ncam/ncam.user && die "the account \"$NEW_USER\" already exists"
    cat >> /etc/ncam/ncam.user <<EOF

[account]
user                          = $NEW_USER
pwd                           = $pass
group                         = 1
EOF
    systemd_running && systemctl restart ncam.service 2>/dev/null || true
    ok "NCam client: ${BOLD}$NEW_USER / $pass${OFF}"
  else
    die "neither $CSP_CONF nor /etc/ncam/ncam.user exists here"
  fi
}

migrate_users() {
  [ -f "$CSP_CONF" ] || die "no $CSP_CONF on this machine"
  local users=/etc/cardservproxy/users.xml
  cp -a "$CSP_CONF" "$CSP_CONF.bak-$(date +%Y%m%d%H%M%S)"
  python3 - "$CSP_CONF" "$users" <<'PY'
import re, sys

proxy_path, users_path = sys.argv[1:3]
text = open(proxy_path).read()

manager = re.search(r'<user-manager\b[\s\S]*?</user-manager\s*>', text)
if not manager:
    sys.exit('proxy.xml has no <user-manager> section')
block = manager.group(0)

# Admins keep working from proxy.xml: that is the panel login, and it must not
# depend on a file the panel itself rewrites.
users = [m.group(0) for m in re.finditer(r'[ \t]*<user\b[^>]*/>', block)]
moved = [u for u in users if 'admin="true"' not in u]
kept = [u for u in users if 'admin="true"' in u]

try:
    existing = open(users_path).read()
except FileNotFoundError:
    existing = '<?xml version="1.0" encoding="UTF-8"?>\n<xml-user-manager ver="1.0">\n</xml-user-manager>\n'

names = set(re.findall(r'<user\b[^>]*name="([^"]*)"', existing))
add = [u.strip() for u in moved if (re.search(r'name="([^"]*)"', u) or [None]) and re.search(r'name="([^"]*)"', u).group(1) not in names]
if add:
    existing = existing.replace('</xml-user-manager>', '  ' + '\n  '.join(add) + '\n</xml-user-manager>')
open(users_path, 'w').write(existing)

new_block = block
for u in moved:
    new_block = new_block.replace(u + '\n', '', 1)
    new_block = new_block.replace(u, '', 1)

new_block = re.sub(r'class="com\.bowman\.cardserv\.SimpleUserManager"',
                   'class="com.bowman.cardserv.XmlUserManager"', new_block)
if 'XmlUserManager' not in new_block:
    sys.exit('unexpected user-manager class, migrate by hand')

if 'user-file-url' not in new_block:
    anchor = re.search(r'([ \t]*)</auth-config\s*>', new_block)
    if not anchor:
        sys.exit('proxy.xml has no <auth-config> inside <user-manager>')
    indent = anchor.group(1) + '  '
    insert = f'{indent}<user-file-url>file:{users_path}</user-file-url>\n{indent}<update-interval>5</update-interval>\n'
    new_block = new_block[:anchor.start()] + insert + new_block[anchor.start():]

open(proxy_path, 'w').write(text.replace(block, new_block))
print(f'moved {len(moved)} account(s), kept {len(kept)} admin(s) in proxy.xml')
PY
  chmod 660 "$users"; chown root:$PKG "$users" 2>/dev/null || true
  systemd_running && systemctl restart cardservproxy.service 2>/dev/null || true
  ok "accounts now live in $users (backup: $CSP_CONF.bak-*)"
  ok "the panel writes that file directly and runs update-users: no more proxy reloads"
}

# ---------------------------------------------------------------- readers ---
# NCam is where the cards live: local readers, or remote cccam/newcamd lines.
# The proxy never talks to them directly, it only asks NCam.
add_reader() {
  local conf=/etc/ncam/ncam.server
  [ -f /etc/ncam/ncam.conf ] || die "no /etc/ncam/ncam.conf: install NCam first (--install-ncam)"
  [ -f "$conf" ] || printf '# card sources\n' > "$conf"

  python3 - "$conf" "$READER_URL" "${READER_LABEL:-}" "${READER_GROUP:-1}" <<'PY'
import re, sys
from urllib.parse import urlparse, parse_qs, unquote

path, url, label, group = sys.argv[1:5]
u = urlparse(url)
proto = (u.scheme or '').lower()
if proto in ('cccam', 'cccam2', 'cccam3'):
    proto = 'cccam'
elif proto in ('newcamd', 'newcamd525'):
    proto = 'newcamd'
else:
    sys.exit(f"protocol '{u.scheme}' is not supported here; use cccam:// or newcamd://")

if not u.hostname or not u.port:
    sys.exit('the url needs host and port, e.g. cccam://user:pass@host:12000')

user = unquote(u.username or '')
pwd = unquote(u.password or '')
if not user or not pwd:
    sys.exit('the url needs user and password, e.g. cccam://user:pass@host:12000')

qs = parse_qs(u.query)
key = (qs.get('key') or [''])[0]
if proto == 'newcamd' and not key:
    # Every newcamd line has a des key; this is the one everybody starts from.
    key = '0102030405060708091011121314'

label = label or re.sub(r'[^A-Za-z0-9_.-]', '_', f'{u.hostname}_{u.port}')

text = open(path).read()
if re.search(rf'^\s*label\s*=\s*{re.escape(label)}\s*$', text, re.M):
    sys.exit(f'a reader called "{label}" already exists in {path}')

lines = [
    '[reader]',
    f'label                         = {label}',
    f'protocol                      = {proto}',
    f'device                        = {u.hostname},{u.port}',
    f'user                          = {user}',
    f'password                      = {pwd}',
]
if proto == 'newcamd':
    lines.append(f'key                           = {key}')
else:
    lines += [
        'cccversion                    = 2.3.0',
        'cccmaxhops                    = 10',
        'cccwantemu                    = 0',
    ]
lines += [
    f'group                         = {group}',
    'inactivitytimeout             = 30',
    'reconnecttimeout              = 30',
    'audisabled                    = 1',
]

open(path, 'w').write(text.rstrip('\n') + '\n\n' + '\n'.join(lines) + '\n')
print(label, proto, f'{u.hostname}:{u.port}')
PY
  local added=$?
  [ $added -eq 0 ] || exit $added
  chmod 600 "$conf"
  systemd_running && systemctl restart ncam.service 2>/dev/null || true
  ok "reader added to $conf (NCam restarted)"
  ok "check it in the panel: Readers tab, or journalctl -u ncam -f"
}

case "$ACTION" in
  credentials) show_credentials; exit 0 ;;
  migrate)     migrate_users;   exit 0 ;;
  addreader)   add_reader;      exit 0 ;;
  reset)       reset_password;  exit 0 ;;
  adduser)     add_user;        exit 0 ;;
esac

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
                        sudo -E bash $SELF --node-from tarball ...
  * install Node 20+ by hand (apt/nvm/tarball), then re-run with --node-from skip
  * build the .deb on another machine and copy it over:
        bash panel/packaging/build-deb.sh      # on a machine with Node
        sudo bash install-ubuntu.sh --deb csp-panel_*_all.deb --node-from skip

EOF
    die "Node.js is required to build and run the panel"
  fi
  ok "node $(node -v)"
fi

# --------------------------------------------------------------- csp build ---
# Optional: build and install the java proxy, with NCam behind it.
#
# Topology this produces:
#
#   clients --newcamd--> CSP :10001 --newcamd--> NCam :10000 --> cards
#                         |                        |
#                         +---- CSP cache (udp) ---+
#                        54278                   54279
#
# CSP owns the accounts (proxy.xml, editable from the panel's Accounts tab)
# and NCam only ever sees one user: the proxy itself.
install_csp() {
  local web="${CSP_WEB_PORT:-8082}" user="${CSP_USER:-admin}" pass="$CSP_PASS"
  local client_port="${CSP_CLIENT_PORT:-10001}" caid="${CSP_CAID:-0x0B00}"
  local cache_local="${CSP_CACHE_PORT:-54278}" cache_remote="${NCAM_CACHE_PORT:-54279}"
  local ncamd_port="${NCAM_NEWCAMD_PORT:-10000}"
  local src="" conf=/etc/cardservproxy prefix="$CSP_PREFIX"
  local deskey=0102030405060708091011121314

  say "installing CardServProxy (java)"
  apt_ensure default-jdk-headless || apt_ensure default-jdk || true
  if ! have javac; then
    warn "no JDK available (apt could not install default-jdk), cannot build the proxy"
    return 1
  fi

  for candidate in "$PANEL_DIR/.." "$HERE/../.." "${SRC_TMP:-}"; do
    [ -n "$candidate" ] && [ -f "$candidate/src/com/bowman/cardserv/CardServProxy.java" ] && { src="$(cd "$candidate" && pwd)"; break; }
  done
  if [ -z "$src" ]; then
    warn "no CardServProxy sources found (expected src/com/bowman/cardserv next to panel/)"
    return 1
  fi

  say "compiling $src"
  if ! bash "$src/panel/packaging/build-csp.sh" --out "$src/lib/cardservproxy.jar"; then
    warn "the proxy did not compile"
    return 1
  fi

  # ---- install the runtime tree -------------------------------------------
  id -u cardservproxy >/dev/null 2>&1 || useradd --system --home "$prefix" --shell /usr/sbin/nologin cardservproxy
  install -d -m 755 "$prefix" "$prefix/lib" "$prefix/log" "$prefix/etc" "$prefix/cache" "$conf"
  install -m 644 "$src"/lib/*.jar "$prefix/lib/"
  [ -f "$src/etc/protocol.txt" ] && install -m 644 "$src/etc/protocol.txt" "$prefix/etc/" || true
  chown -R cardservproxy:cardservproxy "$prefix"

  # ---- proxy.xml -----------------------------------------------------------
  if [ ! -f "$conf/proxy.xml" ]; then
    [ -n "$pass" ] || pass="$(head -c 9 /dev/urandom | base64 | tr -d '/+=' | head -c 12)"
    NCAM_PROXY_PASS="$(head -c 9 /dev/urandom | base64 | tr -d '/+=' | head -c 12)"
    cat > "$conf/proxy.xml" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!--
  Written by the csp-panel installer. Accounts are managed from the panel
  (Accounts tab), which posts this file back through /cfgHandler.
-->
<cardserv-proxy ver="1.0">

  <ca-profiles>
    <profile name="ncam" ca-id="$caid">
      <newcamd listen-port="$client_port">
        <des-key>$deskey</des-key>
      </newcamd>
    </profile>
  </ca-profiles>

  <logging log-ecm="false" log-emm="false" log-zapping="false">
    <log-file rotate-count="3" rotate-max-size="4096">log/cardservproxy.log</log-file>
    <log-level>i</log-level>
  </logging>

  <!--
    XmlUserManager, not SimpleUserManager: the client accounts live in their
    own file, so adding or editing one does not rewrite proxy.xml and does not
    reload the proxy. That is what keeps a thousand accounts manageable. The
    panel writes users.xml and then runs the update-users command.
    The admin below stays here so you can always log into the panel.
  -->
  <user-manager class="com.bowman.cardserv.XmlUserManager" log-failures="true">
    <auth-config>
      <user name="$user" password="$pass" admin="true"/>
      <user-file-url>file:$conf/users.xml</user-file-url>
      <update-interval>5</update-interval>
    </auth-config>
  </user-manager>

  <connection-manager>
    <cws-connectors>
      <!-- The softcam behind the proxy. -->
      <newcamd-connector name="ncam" profile="ncam">
        <host>127.0.0.1</host>
        <port>$ncamd_port</port>
        <user>csp</user>
        <password>$NCAM_PROXY_PASS</password>
        <des-key>$deskey</des-key>
      </newcamd-connector>
    </cws-connectors>
  </connection-manager>

  <!-- Cache shared with NCam over the CSP protocol (udp). -->
  <cache-handler class="com.bowman.cardserv.ClusteredCache">
    <cache-config>
      <cw-max-age>19</cw-max-age>
      <max-cache-wait>50%</max-cache-wait>
      <local-port>$cache_local</local-port>
      <remote-host>127.0.0.1</remote-host>
      <remote-port>$cache_remote</remote-port>
    </cache-config>
  </cache-handler>

  <rmi enabled="true">
    <status-web enabled="true">
      <listen-port>$web</listen-port>
      <bind-ip>127.0.0.1</bind-ip>
      <super-users>$user</super-users>
      <log-file rotate-count="2" rotate-max-size="2048">log/web-access.log</log-file>
    </status-web>
  </rmi>

</cardserv-proxy>
EOF
    chmod 640 "$conf/proxy.xml"
    chown root:cardservproxy "$conf/proxy.xml"
    if [ ! -f "$conf/users.xml" ]; then
      cat > "$conf/users.xml" <<'EOF2'
<?xml version="1.0" encoding="UTF-8"?>
<!-- Client accounts. Managed from the panel (Accounts tab). -->
<xml-user-manager ver="1.0">
</xml-user-manager>
EOF2
    fi
    chmod 660 "$conf/users.xml"
    chown root:$PKG "$conf/users.xml" 2>/dev/null || true
    CSP_CREDENTIALS="$user / $pass"
    ok "wrote $conf/proxy.xml (clients on newcamd $client_port, status-web $web)"
  else
    web="$(sed -n 's:.*<listen-port>\([0-9]*\)</listen-port>.*:\1:p' "$conf/proxy.xml" | head -1)"
    web="${web:-8082}"
    ok "keeping the existing $conf/proxy.xml (status-web $web)"
  fi
  CSP_WEB_PORT="$web"

  # Started by hand, the proxy looks for config/proxy.xml under its working
  # directory (ProxyConfig.DEFAULT_CONFIG); the unit passes the path instead.
  install -d -m 755 "$prefix/config"
  ln -sfn "$conf/proxy.xml" "$prefix/config/proxy.xml"
  chown -h cardservproxy:cardservproxy "$prefix/config/proxy.xml"

  # ---- teach NCam about the proxy ------------------------------------------
  if [ -f /etc/ncam/ncam.conf ]; then
    configure_ncam_for_csp "$ncamd_port" "$cache_remote" "$cache_local" "$deskey" "$caid"
  else
    warn "no /etc/ncam/ncam.conf: add a newcamd port and 'csp_port = $cache_remote' to your softcam by hand"
  fi

  install -m 644 "$HERE/cardservproxy.service" /lib/systemd/system/cardservproxy.service 2>/dev/null \
    || install -m 644 "$PANEL_DIR/packaging/cardservproxy.service" /lib/systemd/system/cardservproxy.service
  if systemd_running; then
    sctl daemon-reload
    sctl enable cardservproxy.service
    systemctl restart cardservproxy.service || warn "cardservproxy.service did not start: journalctl -u cardservproxy -n 40"
    for _ in $(seq 1 30); do
      ss -lnt 2>/dev/null | grep -q ":${web}\b" && break
      sleep 0.5
    done
    if ss -lnt 2>/dev/null | grep -q ":${web}\b"; then
      ok "cardservproxy.service listening on 127.0.0.1:${web}"
      CSP_READY=1
    else
      warn "CSP is installed but its status-web never came up on ${web}"
      warn "  journalctl -u cardservproxy -n 40 --no-pager"
      warn "  tail -40 $prefix/log/cardservproxy.log"
    fi
  else
    warn "systemd is not running here; start it with: java -jar $prefix/lib/cardservproxy.jar"
  fi
  # Only claim success when the proxy is actually answering: pointing the
  # panel at a dead status-web is how you end up locked out of your own panel.
  [ "${CSP_READY:-0}" = 1 ] || return 1
  INSTALL_CSP_DONE=1
}

# Add the newcamd server port, the proxy account and the CSP cache port to an
# existing ncam.conf/ncam.user, without disturbing anything already there.
configure_ncam_for_csp() {
  local ncamd_port="$1" csp_port="$2" csp_peer="$3" deskey="$4" caid="${5:-0x0000}"
  local conf=/etc/ncam/ncam.conf users=/etc/ncam/ncam.user changed=0
  # newcamd ports are declared as port@caid:provid; a port with caid 0000
  # answers nothing useful to the proxy.
  local caid_hex="${caid#0x}"; caid_hex="${caid_hex#0X}"

  if ! grep -q '^\[newcamd\]' "$conf"; then
    cat >> "$conf" <<EOF

[newcamd]
port                          = ${ncamd_port}@${caid_hex}:000000
key                           = $deskey
EOF
    changed=1
  fi

  if ! grep -q '^csp_port' "$conf"; then
    if grep -q '^\[cache\]' "$conf"; then
      sed -i "/^\[cache\]/a csp_port                      = ${csp_port}\ncsp_serverip                  = 127.0.0.1" "$conf"
    else
      cat >> "$conf" <<EOF

[cache]
csp_port                      = ${csp_port}
csp_serverip                  = 127.0.0.1
EOF
    fi
    changed=1
  fi

  if [ -n "${NCAM_PROXY_PASS:-}" ] && ! grep -q '^user *= *csp$' "$users" 2>/dev/null; then
    cat >> "$users" <<EOF

[account]
user                          = csp
pwd                           = $NCAM_PROXY_PASS
group                         = 1
EOF
    changed=1
  fi

  if [ "$changed" = 1 ]; then
    ok "ncam.conf/ncam.user updated: newcamd ${ncamd_port}, csp cache port ${csp_port}"
    systemd_running && systemctl restart ncam.service 2>/dev/null || true
  else
    ok "ncam already has a newcamd port and a csp cache port"
  fi
}

# -------------------------------------------------------------- ncam build ---
# Optional: build and install the softcam itself from vendor/ncam (or straight
# from upstream when this script runs standalone).
install_ncam() {
  local port="${NCAM_PORT:-8888}" user="${NCAM_USER:-admin}" pass="$NCAM_PASS"
  local src="" conf=/etc/ncam bin=/usr/local/bin/ncam

  say "installing NCam (softcam)"
  for p in build-essential pkg-config libssl-dev libusb-1.0-0-dev libpcsclite-dev zlib1g-dev; do
    apt_ensure "$p" || warn "could not install $p (the build may fail)"
  done

  # Sources: the vendored tree, the clone made earlier, or a fresh clone.
  for candidate in "$PANEL_DIR/../vendor/ncam" "$HERE/../../vendor/ncam" "${SRC_TMP:-}/vendor/ncam"; do
    [ -n "$candidate" ] && [ -f "$candidate/Makefile" ] && { src="$candidate"; break; }
  done
  if [ -z "$src" ]; then
    say "no vendored sources, cloning $NCAM_REPO"
    have git || apt_ensure git || die "git is required to fetch NCam"
    NCAM_TMP="$(mktemp -d /tmp/ncam-src.XXXXXX)"
    git clone --depth 1 "$NCAM_REPO" "$NCAM_TMP" >/dev/null 2>&1 || die "cannot clone $NCAM_REPO"
    src="$NCAM_TMP"
  fi

  say "compiling $src (this takes a few minutes)"
  # Build out of tree-ish: NCam writes into build/ and Distribution/ only.
  # shellcheck disable=SC2086
  if ! ( cd "$src" && make -j"$(nproc)" CONF_DIR="$conf" $NCAM_MAKE_FLAGS >/tmp/ncam-build.log 2>&1 ); then
    tail -20 /tmp/ncam-build.log >&2
    die "NCam did not compile (full log: /tmp/ncam-build.log)"
  fi

  local built
  built="$(ls -t "$src"/Distribution/ncam-*-linux-gnu* 2>/dev/null | grep -v '\.debug$' | head -1)"
  [ -n "$built" ] || die "the build produced no binary in $src/Distribution"
  install -m 755 "$built" "$bin"
  ok "$bin installed ($(basename "$built"))"

  # Minimal configuration, created only once: never touch an existing setup.
  install -d -m 755 "$conf"
  if [ ! -f "$conf/ncam.conf" ]; then
    [ -n "$pass" ] || pass="$(head -c 9 /dev/urandom | base64 | tr -d '/+=' | head -c 12)"
    cat > "$conf/ncam.conf" <<EOF
# Minimal configuration written by the csp-panel installer.
# Everything else can be edited from the panel (Config tab).
[global]
logfile                       = /var/log/ncam.log
nice                          = -1
preferlocalcards              = 1

[webif]
httpport                      = $port
# The panel runs on this same machine and is the intended front end, so the
# web interface only listens on loopback. Delete serverip (and widen
# httpallowed) if you also want to reach NCam's own pages from the LAN.
serverip                      = 127.0.0.1
httpuser                      = $user
httppwd                       = $pass
httpallowed                   = 127.0.0.1,::1
httprefresh                   = 5
EOF
    chmod 600 "$conf/ncam.conf"
    [ -f "$conf/ncam.user" ] || printf '# add your accounts here, or from the panel\n' > "$conf/ncam.user"
    [ -f "$conf/ncam.server" ] || printf '# add your readers here, or from the panel\n' > "$conf/ncam.server"
    NCAM_CREDENTIALS="$user / $pass"
    ok "wrote $conf/ncam.conf (webif on port $port, user $user)"
  else
    # Reuse what is already configured so the panel can log in.
    port="$(sed -n 's/^[[:space:]]*httpport[[:space:]]*=[[:space:]]*+\?//p' "$conf/ncam.conf" | tail -1 | tr -d '[:space:]')"
    port="${port:-8888}"
    ok "keeping the existing $conf/ncam.conf (webif port $port)"
  fi
  NCAM_PORT="$port"

  install -m 644 "$HERE/ncam.service" /lib/systemd/system/ncam.service 2>/dev/null \
    || install -m 644 "$PANEL_DIR/packaging/ncam.service" /lib/systemd/system/ncam.service
  if systemd_running; then
    sctl daemon-reload
    sctl enable ncam.service
    systemctl restart ncam.service || warn "ncam.service did not start, check: journalctl -u ncam -n 40"
    for _ in $(seq 1 20); do
      curl -fsS -m 2 "http://127.0.0.1:${port}/" >/dev/null 2>&1 && break
      curl -fsS -m 2 -o /dev/null -w '' "http://127.0.0.1:${port}/ncamapi.html" 2>/dev/null && break
      sleep 0.5
    done
    if ss -lnt 2>/dev/null | grep -q ":${port}\b"; then
      ok "ncam.service listening on 127.0.0.1:${port}"
    else
      warn "NCam is installed but its web interface is not answering on ${port} yet"
    fi
  else
    warn "systemd is not running here; start NCam with: $bin -c $conf"
  fi
}

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

# --------------------------------------------------------------------- ncam ---
if [ "$INSTALL_NCAM" = 1 ]; then
  install_ncam
  # The panel should obviously manage the softcam we just installed.
  BACKEND="${BACKEND:-ncam}"
  [ "$BACKEND" = ncam ] && TARGET_URL="${TARGET_URL:-http://127.0.0.1:${NCAM_PORT:-8888}}"
fi

if [ "$INSTALL_CSP" = 1 ]; then
  if ! install_csp; then
    # Half a stack beats no stack: keep the panel on the softcam and say so.
    warn "CardServProxy is not usable; leaving the panel on the softcam"
    warn "fix it, then: sudo bash $SELF --backend csp --url http://127.0.0.1:${CSP_WEB_PORT:-8082} --yes"
    CSP_FAILED=1
    INSTALL_CSP=0
  fi
fi
if [ "${INSTALL_CSP_DONE:-0}" = 1 ]; then
  # With the proxy in front, the panel manages the proxy (that is where the
  # accounts and the client sessions are).
  BACKEND=csp
  TARGET_URL="http://127.0.0.1:${CSP_WEB_PORT:-8082}"
fi
if [ "${CSP_FAILED:-0}" = 1 ]; then
  # Fall back to managing the softcam directly, which at least works.
  BACKEND="${BACKEND:-ncam}"
  [ "$BACKEND" = ncam ] && TARGET_URL="${TARGET_URL:-http://127.0.0.1:${NCAM_PORT:-8888}}"
  # The cache peer is still useful on its own: NCam can share its cache with
  # us even with no proxy in front.
  if [ -f /etc/ncam/ncam.conf ] && [ -z "$CACHE_PEERS_HINT" ]; then
    if ! grep -q '^csp_port' /etc/ncam/ncam.conf; then
      printf '\n[cache]\ncsp_port                      = %s\ncsp_serverip                  = 127.0.0.1\n' \
        "${NCAM_CACHE_PORT:-54279}" >> /etc/ncam/ncam.conf
      systemd_running && systemctl restart ncam.service 2>/dev/null || true
    fi
    CACHE_PEERS_HINT="127.0.0.1:${NCAM_CACHE_PORT:-54279}"
  fi
fi

# ---------------------------------------------------------- configuration ---
say "configuring $CONF"

# Re-running the installer must not silently change an existing setup, so the
# defaults come from the current panel.env whenever the flag was not given.
conf_get() { [ -f "$CONF" ] && sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$CONF" | tail -1; }
CUR_BACKEND="$(conf_get BACKEND)"
CUR_MOCK="$(conf_get MOCK)"
DEF_BACKEND="${CUR_BACKEND:-oscam}"
[ "$CUR_MOCK" = 1 ] && DEF_BACKEND=mock
DEF_PORT="$(conf_get PORT)"
DEF_HOST="$(conf_get HOST)"
case "${BACKEND:-$DEF_BACKEND}" in
  ncam) DEF_URL="$(conf_get NCAM_URL)" ;;
  csp)  DEF_URL="$(conf_get CSP_URL)" ;;
  *)    DEF_URL="$(conf_get OSCAM_URL)" ;;
esac

if [ -z "$BACKEND" ]; then
  echo "  Which softcam should the panel manage?"
  echo "    oscam  OSCam web interface (/oscamapi.html)"
  echo "    ncam   NCam, the OSCam fork (/ncamapi.html)"
  echo "    csp    CardServProxy status web (/xmlHandler)"
  echo "    mock   built-in demo data, no softcam needed"
  ask BACKEND "  backend" "$DEF_BACKEND"
fi
case "$BACKEND" in
  oscam|ncam|csp|mock) ;;
  *) die "--backend must be oscam, ncam, csp or mock" ;;
esac

if [ "$BACKEND" != mock ] && [ -z "$TARGET_URL" ]; then
  if [ "$BACKEND" = oscam ]; then
    ask TARGET_URL "  OSCam web interface URL" "${DEF_URL:-http://127.0.0.1:8888}"
  elif [ "$BACKEND" = ncam ]; then
    ask TARGET_URL "  NCam web interface URL" "${DEF_URL:-http://127.0.0.1:8888}"
  else
    ask TARGET_URL "  CardServProxy status web URL" "${DEF_URL:-http://127.0.0.1:8082}"
  fi
fi
[ -n "$PORT" ]   || ask PORT   "  panel port" "${DEF_PORT:-8090}"
if [ -z "$LISTEN" ]; then
  echo "  Bind address: 127.0.0.1 = only this machine (publish it with nginx),"
  echo "                0.0.0.0   = reachable from your LAN at http://<ip>:$PORT/"
  ask LISTEN "  bind address" "${DEF_HOST:-127.0.0.1}"
fi

case "$BACKEND" in
  mock)
    # Keep whichever dialect was configured; MOCK just swaps in fake data.
    set_kv "$CONF" BACKEND "${CUR_BACKEND:-oscam}"
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

# The cache peer is a separate daemon; enable it when we know who to talk to.
if [ "$INSTALL_CSP" = 1 ] || [ -n "$CACHE_PEERS_HINT" ]; then
  CACHE_CONF=/etc/$PKG/cache.env
  if [ -f "$CACHE_CONF" ]; then
    set_kv "$CACHE_CONF" CACHE_PORT "${CACHE_NODE_PORT:-54280}"
    set_kv "$CACHE_CONF" CACHE_PEERS "${CACHE_PEERS_HINT:-127.0.0.1:${CSP_CACHE_PORT:-54278},127.0.0.1:${NCAM_CACHE_PORT:-54279}}"
    chown root:$PKG "$CACHE_CONF" 2>/dev/null || true
    chmod 640 "$CACHE_CONF"
    set_kv "$CONF" CACHE_NODE_URL "http://127.0.0.1:8099"
    if systemd_running; then
      sctl enable csp-cache-node.service
      systemctl restart csp-cache-node.service 2>/dev/null \
        && ok "cache peer on udp/${CACHE_NODE_PORT:-54280} (Cache tab in the panel)" \
        || warn "csp-cache-node did not start: journalctl -u csp-cache-node -n 30"
    fi
  fi
fi
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
LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
# 0.0.0.0 is not an address anybody can type in a browser: show the real one.
case "$LISTEN" in
  0.0.0.0|'' ) OPEN_HOST="${LAN_IP:-127.0.0.1}" ;;
  '::'|'[::]') OPEN_HOST="${LAN_IP:-127.0.0.1}" ;;
  *          ) OPEN_HOST="$LISTEN" ;;
esac
cat <<EOF

${BOLD}csp-panel is installed.${OFF}

  open       ${DOMAIN:+http://$DOMAIN/   (or }http://${OPEN_HOST}:${PORT}/${DOMAIN:+)}
  log in     $([ "$BACKEND" = mock ] && echo 'any user/password works in mock mode ("admin" grants admin rights)' || echo "with your $BACKEND web interface credentials")
  config     sudoedit $CONF   ${DIM}then: sudo systemctl restart $SERVICE${OFF}
  status     systemctl status $SERVICE
  logs       journalctl -u $SERVICE -f
  remove     sudo bash $SELF --uninstall   ${DIM}(--purge to drop the config too)${OFF}
${CSP_CREDENTIALS:+
  ${BOLD}CSP login: ${CSP_CREDENTIALS}${OFF}
  ${DIM}(admin account in /etc/cardservproxy/proxy.xml — use it to log into the panel)${OFF}
}${NCAM_CREDENTIALS:+
  ${BOLD}NCam webif login: ${NCAM_CREDENTIALS}${OFF}
  ${DIM}(stored in /etc/ncam/ncam.conf — use it to log into the panel)${OFF}
}
EOF

# The default bind address is loopback: say so, because "it does not open" from
# another machine is otherwise a very confusing first experience.
if [ -z "$DOMAIN" ] && { [ "$LISTEN" = 127.0.0.1 ] || [ "$LISTEN" = localhost ]; }; then
  cat <<EOF
  ${YELLOW}Note:${OFF} the panel is listening on loopback only, so it opens from THIS
  machine (http://127.0.0.1:${PORT}/ or an ssh tunnel), not from your laptop.

  To reach it from your LAN at ${BOLD}http://${LAN_IP:-<server-ip>}:${PORT}/${OFF}:

      sudo bash $SELF --listen 0.0.0.0 --yes
      sudo ufw allow ${PORT}/tcp        ${DIM}# only if ufw is enabled${OFF}

  Or publish it properly with nginx (recommended, allows TLS):

      sudo bash $SELF --domain panel.example.com --yes

  Quick peek without changing anything, from your laptop:

      ssh -L ${PORT}:127.0.0.1:${PORT} root@${LAN_IP:-<server-ip>}   ${DIM}# then open http://127.0.0.1:${PORT}/${OFF}

EOF
fi
# Not worth saying when this very script just wrote a working ncam.conf.
if [ "$INSTALL_NCAM" != 1 ] && { [ "$BACKEND" = oscam ] || [ "$BACKEND" = ncam ]; }; then
  CONF_NAME=$([ "$BACKEND" = ncam ] && echo ncam.conf || echo oscam.conf)
  cat <<EOF
  ${DIM}Reminder: in $CONF_NAME [webif] set httpport, httpuser, httppwd and add this
  machine's IP to httpallowed, otherwise the panel gets 403.${OFF}

EOF
fi
