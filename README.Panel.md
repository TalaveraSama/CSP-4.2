# CSP Panel (modern web interface)

The legacy status web (`web/`, packaged as `cs-status.war` by `build.xml`) is a
client-side XSLT + `bowweb.js` application from 2009 that only runs inside the
proxy's servlet container.

A modern, **Java-free** replacement lives in [`panel/`](panel/), which also
speaks **OSCam** and its **NCam** fork:

- Node/TypeScript BFF with three interchangeable backends — CardServProxy
  (`/xmlHandler`), OSCam (`/oscamapi.html`, HTTP Digest auth) and NCam
  (`/ncamapi.html`, `ncam.*` config files) — all normalised to the same clean
  JSON API (`/api/...`); the softcam can be local or on another host,
- React + Vite single-page frontend (dark theme, sortable tables, auto-refresh,
  admin command forms, `proxy.xml` editor),
- built-in mock nodes for both backends, so the panel can be run and demoed with
  **no CSP, no OSCam and no JVM at all** (`MOCK=1`).

```bash
cd panel && npm install && npm run dev                 # demo, CSP mock data
cd panel && BACKEND=oscam MOCK=1 npm run dev           # demo, OSCam mock data
cd panel && BACKEND=ncam MOCK=1 npm run dev            # demo, NCam mock data
cd panel && CSP_URL=https://proxy-host:8082 npm run dev
cd panel && BACKEND=oscam OSCAM_URL=http://box:8888 npm run dev
cd panel && BACKEND=ncam NCAM_URL=http://box:8888 npm run dev
```

On Ubuntu 20.04 / 22.04 / 24.04 one command installs it as a system service —
no `.war`, no Tomcat (it also installs Node.js if the distro's is too old):

```bash
sudo bash panel/packaging/install-ubuntu.sh --backend oscam \
     --url http://127.0.0.1:8888 --domain panel.example.com --yes
```

or build the Debian package yourself:

```bash
cd panel && bash packaging/build-deb.sh
sudo apt install ./build/csp-panel_0.6.0_all.deb
sudoedit /etc/csp-panel/panel.env && sudo systemctl start csp-panel
```

See [`panel/README.md`](panel/README.md) for the architecture, the REST API and
the mapping of every legacy artefact to its replacement, and
[`panel/packaging/README.md`](panel/packaging/README.md) for the `.deb`
([guía de instalación en español](panel/packaging/INSTALL.es.md)).

NCam itself is vendored in [`vendor/ncam`](vendor/README.md) (copy of
`fairbird/NCam`, GPL-3), so a single command installs the softcam and the panel
on a clean Ubuntu box:

```bash
sudo bash panel/packaging/install-ubuntu.sh --install-ncam --backend ncam --yes
```

The Java proxy is in this repository too (`src/`, `plugins/`), and
`panel/packaging/build-csp.sh` builds it with plain javac — no Ant, no
`source=1.4`, no `rmic`. Since 0.6.0 it is **optional and not installed by
default**: NCam attends your clients itself. The two one-command installs are:

```bash
# panel + NCam (NCam opens newcamd 10000 / cccam 12000 for your clients)
curl -fsSL https://raw.githubusercontent.com/TalaveraSama/CSP-4.2/v0.6.0/install.sh | sudo bash

# panel only, against a softcam you already have (installs no NCam)
curl -fsSL https://raw.githubusercontent.com/TalaveraSama/CSP-4.2/v0.6.0/install-panel.sh \
     | sudo bash -s -- --backend ncam --url http://192.168.1.10:8888

# with the proxy in front (old topology, still supported)
sudo bash install.sh --all --yes
```

The old `web/` tree is left untouched, so existing deployments keep working.

Manual completo en español (uso, comandos, API): [`panel/docs/MANUAL.es.md`](panel/docs/MANUAL.es.md).
