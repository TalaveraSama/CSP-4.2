#!/usr/bin/env bash
# Build the csp-panel Debian package.
#
#   cd panel && bash packaging/build-deb.sh
#   VERSION=0.2.1 bash packaging/build-deb.sh        # override the version
#   BASE_PATH=/csp/ bash packaging/build-deb.sh      # sub-directory deployment
#
# Produces: panel/build/csp-panel_<version>_all.deb
#
# Requirements: node >= 20 and npm (to build), dpkg-deb (to package).
# The package itself is architecture independent: all runtime dependencies are
# pure JavaScript and get vendored, so installing needs no network.
set -euo pipefail

cd "$(dirname "$0")/.."
PANEL_DIR="$(pwd)"

PKG=csp-panel
VERSION="${VERSION:-$(node -p "require('./package.json').version")}"
CHANGELOG=packaging/debian/changelog
BUILD_DIR="$PANEL_DIR/build"
STAGE="$BUILD_DIR/${PKG}_${VERSION}_all"
LIB=/usr/lib/$PKG

command -v dpkg-deb >/dev/null || { echo "ERROR: dpkg-deb not found (apt install dpkg-dev)"; exit 1; }
command -v node     >/dev/null || { echo "ERROR: node not found (needs Node >= 20 to build)"; exit 1; }

# The changelog is the release history users see with `apt changelog`; keep it
# in sync with package.json so the two never drift apart.
if [ -f "$CHANGELOG" ]; then
  CHANGELOG_VERSION="$(sed -n '1s/^[^(]*(\([^)]*\)).*/\1/p' "$CHANGELOG")"
  if [ "$CHANGELOG_VERSION" != "$VERSION" ]; then
    echo "ERROR: $CHANGELOG top entry is $CHANGELOG_VERSION but the version is $VERSION."
    echo "       Add a changelog entry (or pass VERSION=$CHANGELOG_VERSION)."
    exit 1
  fi
fi

echo "==> building $PKG $VERSION"
npm install --no-audit --no-fund
npm run build

echo "==> staging $STAGE"
rm -rf "$STAGE"
install -d "$STAGE/DEBIAN" \
           "$STAGE$LIB/server" "$STAGE$LIB/web" \
           "$STAGE/etc/$PKG" \
           "$STAGE/lib/systemd/system" \
           "$STAGE/usr/bin" \
           "$STAGE/usr/share/doc/$PKG/examples"

cp -r server/dist "$STAGE$LIB/server/dist"
cp -r web/dist    "$STAGE$LIB/web/dist"

# Runtime dependencies only, vendored into the package.
node - "$VERSION" > "$STAGE$LIB/package.json" <<'NODE'
const pkg = require('./server/package.json');
process.stdout.write(
  JSON.stringify(
    { name: 'csp-panel', version: process.argv[2], private: true, type: 'module', dependencies: pkg.dependencies },
    null,
    2,
  ) + '\n',
);
NODE

echo "==> vendoring runtime dependencies"
( cd "$STAGE$LIB" && npm install --omit=dev --no-audit --no-fund --no-package-lock >/dev/null )
rm -rf "$STAGE$LIB"/node_modules/.package-lock.json

# Launcher: tolerate distros that still ship the binary as `nodejs`.
cat > "$STAGE/usr/bin/$PKG" <<'SH'
#!/bin/sh
# Starts the CSP/OSCam web panel.
# Node may come from the distro, nodesource, nvm or a tarball: look around.
# Set NODE_BIN in /etc/csp-panel/panel.env to force a specific interpreter.
for candidate in \
  "$NODE_BIN" \
  "$(command -v node 2>/dev/null)" \
  "$(command -v nodejs 2>/dev/null)" \
  /usr/bin/node /usr/local/bin/node /opt/node/bin/node \
  /usr/bin/nodejs /usr/local/bin/nodejs
do
  [ -n "$candidate" ] && [ -x "$candidate" ] && NODE="$candidate" && break
done
if [ -z "${NODE:-}" ]; then
  echo "csp-panel: no node interpreter found." >&2
  echo "csp-panel: install Node.js >= 20, or set NODE_BIN=/path/to/node in /etc/csp-panel/panel.env" >&2
  exit 1
fi
exec "$NODE" /usr/lib/csp-panel/server/dist/index.js "$@"
SH
chmod 755 "$STAGE/usr/bin/$PKG"

# Second entry point: the cache cluster peer. Same interpreter lookup.
sed 's:server/dist/index.js:server/dist/cache/node.js:; s:^# Starts the CSP/OSCam web panel.$:# Starts the CSP cache cluster peer.:' \
  "$STAGE/usr/bin/$PKG" > "$STAGE/usr/bin/csp-cache-node"
chmod 755 "$STAGE/usr/bin/csp-cache-node"

install -m 644 packaging/csp-panel.service "$STAGE/lib/systemd/system/$PKG.service"
install -m 644 packaging/csp-cache-node.service "$STAGE/lib/systemd/system/csp-cache-node.service"
install -m 640 packaging/panel.env         "$STAGE/etc/$PKG/panel.env"
install -m 640 packaging/cache.env         "$STAGE/etc/$PKG/cache.env"

install -m 644 README.md                                    "$STAGE/usr/share/doc/$PKG/README.md"
install -m 644 packaging/debian/copyright                   "$STAGE/usr/share/doc/$PKG/copyright"
install -m 644 deploy/aapanel/nginx-subdomain.conf          "$STAGE/usr/share/doc/$PKG/examples/"
install -m 644 deploy/aapanel/nginx-subdirectory.conf       "$STAGE/usr/share/doc/$PKG/examples/"
install -m 644 .env.example                                 "$STAGE/usr/share/doc/$PKG/examples/panel.env.example"
install -m 644 packaging/INSTALL.es.md                      "$STAGE/usr/share/doc/$PKG/INSTALL.es.md"

if [ -f "$CHANGELOG" ]; then
  gzip -9nc "$CHANGELOG" > "$STAGE/usr/share/doc/$PKG/changelog.Debian.gz"
else
  printf '%s (%s) unstable; urgency=medium\n\n  * CSP/OSCam/NCam web panel %s.\n\n -- CSP Panel contributors <noreply@example.com>  %s\n' \
    "$PKG" "$VERSION" "$VERSION" "$(date -R)" | gzip -9n > "$STAGE/usr/share/doc/$PKG/changelog.Debian.gz"
fi
chmod 644 "$STAGE/usr/share/doc/$PKG/changelog.Debian.gz"

# Control files: fill in version and installed size.
SIZE=$(du -ks --exclude=DEBIAN "$STAGE" | cut -f1)
sed -e "s/@VERSION@/$VERSION/" -e "s/@SIZE@/$SIZE/" -e "s/\${misc:Depends}, //" \
    packaging/debian/control > "$STAGE/DEBIAN/control"
install -m 644 packaging/debian/conffiles "$STAGE/DEBIAN/conffiles"
install -m 755 packaging/debian/postinst  "$STAGE/DEBIAN/postinst"
install -m 755 packaging/debian/prerm     "$STAGE/DEBIAN/prerm"
install -m 755 packaging/debian/postrm    "$STAGE/DEBIAN/postrm"

# md5sums help `debsums` and apt verify the install.
( cd "$STAGE" && find . -type f ! -path './DEBIAN/*' -printf '%P\0' | sort -z | xargs -0 md5sum > DEBIAN/md5sums )
chmod 644 "$STAGE/DEBIAN/md5sums"

echo "==> packaging"
DEB="$BUILD_DIR/${PKG}_${VERSION}_all.deb"
dpkg-deb --root-owner-group --build "$STAGE" "$DEB" >/dev/null

echo
echo "Built: $DEB  ($(du -h "$DEB" | cut -f1))"
echo
echo "  install : sudo apt install $DEB      # or: sudo dpkg -i $DEB"
echo "  config  : sudoedit /etc/csp-panel/panel.env"
echo "  start   : sudo systemctl start csp-panel"
