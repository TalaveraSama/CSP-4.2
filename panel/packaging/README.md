# Debian package (`csp-panel`)

Builds a single architecture-independent `.deb` that installs the panel as a
systemd service (backends: CardServProxy, OSCam and NCam, local or remote). All runtime dependencies are pure JavaScript and are vendored
into the package, so **installing needs no network and no `npm`** — only a
Node.js runtime.

## Ubuntu one-liner

For Ubuntu 20.04 / 22.04 / 24.04 there is an installer that does everything
(Node.js, build, install, `panel.env`, systemd, optional nginx vhost):

```bash
sudo bash packaging/install-ubuntu.sh                       # guided
sudo bash packaging/install-ubuntu.sh --backend oscam \
     --url http://127.0.0.1:8888 --domain panel.example.com --yes
sudo bash packaging/install-ubuntu.sh --backend ncam \
     --url http://192.168.1.10:8888 --yes     # NCam, here on another host
sudo bash packaging/install-ubuntu.sh --uninstall           # or --purge
```

It installs Node.js when the distro's is too old: first from NodeSource, and
if that host is unreachable (blocked, proxy, broken IPv6) it falls back to the
checksum-verified tarball from `nodejs.org` unpacked into `/opt/node`. Use
`--node-from nodesource|tarball|skip` and `NODE_MIRROR=...` to control it.

It can also install the softcam itself: `--install-ncam` (or `--with-ncam`)
builds the vendored NCam tree (`vendor/ncam`, GPL-3), installs
`/usr/local/bin/ncam` plus `ncam.service`, writes a minimal
`/etc/ncam/ncam.conf` with the web interface on port 8888 (random password
unless `--ncam-pass` is given) and configures the panel to manage it. On a
config the installer wrote itself it also opens the client ports (newcamd
`10000`, cccam `12000`, `--caid`, `--no-clients`), because with no proxy in
front NCam is what your clients connect to. An existing `ncam.conf` is never
touched.

**The CardServProxy java proxy is not installed by default any more** (0.6.0):
`--install-csp` builds it, wires it to NCam and points the panel at it, `--all`
adds it to the whole stack, and `--remove-csp` retires it and moves the panel
back to NCam. `--no-ncam` is the opposite shape: the panel alone, against a
softcam that already exists.

The one-liners at the repository root wrap this:
[`install.sh`](../../install.sh) is `--only-ncam` (panel + NCam, no proxy) and
[`install-panel.sh`](../../install-panel.sh) is `--no-ncam` (panel only).

The package also ships `csp-cache-node`, a standalone peer for the CSP cache
cluster (UDP, same protocol as CardServProxy's ClusteredCache and NCam's
`csp_port`), configured in `/etc/csp-panel/cache.env`. Point the panel at it
with `CACHE_NODE_URL=http://127.0.0.1:8099` and the Cache tab appears.

Spanish step-by-step guide: [`INSTALL.es.md`](INSTALL.es.md).

## Build

```bash
cd panel
bash packaging/build-deb.sh            # -> build/csp-panel_0.6.0_all.deb
VERSION=0.3.1 bash packaging/build-deb.sh   # needs a matching changelog entry
BASE_PATH=/csp/ bash packaging/build-deb.sh   # panel served under /csp/
```

Bumping the version means editing **both** `package.json` and
`packaging/debian/changelog`: the build refuses to package a version that has
no changelog entry, so `apt changelog csp-panel` always tells the truth.

Build host needs `node >= 20`, `npm` and `dpkg-deb` (`apt install dpkg-dev`).
No `fakeroot` required — the script uses `dpkg-deb --root-owner-group`.

## Install

```bash
sudo apt install ./csp-panel_0.6.0_all.deb     # or: sudo dpkg -i …
sudoedit /etc/csp-panel/panel.env              # BACKEND + OSCAM_URL/CSP_URL
sudo systemctl start csp-panel
curl http://127.0.0.1:8090/healthz
```

The unit is enabled on first install but **not started**, so it does not come up
pointing at nothing. Upgrades keep your `panel.env` (it is a dpkg conffile) and
restart the service only if it was already running.

Node.js is a *Recommends*, not a *Depends*: many hosts install Node from
nodesource, nvm or a tarball instead of the distro package. Any `node` (or
`nodejs`) >= 20 found in `PATH`, `/usr/bin`, `/usr/local/bin` or `/opt/node/bin`
works, or set `NODE_BIN=/path/to/node` in `panel.env`; `postinst` warns if it
finds none.

## Layout

| Path | Contents |
| --- | --- |
| `/usr/lib/csp-panel/server/dist` | compiled BFF |
| `/usr/lib/csp-panel/web/dist` | built SPA (default `WEB_ROOT`) |
| `/usr/lib/csp-panel/node_modules` | vendored runtime deps (express, cookie-parser, fast-xml-parser) |
| `/usr/bin/csp-panel` | launcher, resolves `node`/`nodejs` |
| `/etc/csp-panel/panel.env` | conffile, `root:csp-panel 0640` (holds softcam credentials) |
| `/lib/systemd/system/csp-panel.service` | unit: `User=csp-panel`, `ProtectSystem=strict`, no capabilities |
| `/usr/share/doc/csp-panel/examples/` | nginx snippets, `panel.env.example` |

`apt purge csp-panel` removes `/etc/csp-panel` and the system user; `apt remove`
keeps the configuration.

## Files here

| File | Purpose |
| --- | --- |
| `build-deb.sh` | build + stage + `dpkg-deb` |
| `debian/control` | package metadata |
| `debian/{postinst,prerm,postrm}` | user creation, systemd enable/stop, purge |
| `debian/conffiles`, `debian/copyright` | dpkg bookkeeping |
| `debian/changelog` | release history shipped as `changelog.Debian.gz`; its top entry must match the version being built (the build fails otherwise) |
| `csp-panel.service` | systemd unit shipped by the package |
| `panel.env` | default configuration installed to `/etc/csp-panel/` |
