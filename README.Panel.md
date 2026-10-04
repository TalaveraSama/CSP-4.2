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
sudo apt install ./build/csp-panel_0.3.0_all.deb
sudoedit /etc/csp-panel/panel.env && sudo systemctl start csp-panel
```

See [`panel/README.md`](panel/README.md) for the architecture, the REST API and
the mapping of every legacy artefact to its replacement, and
[`panel/packaging/README.md`](panel/packaging/README.md) for the `.deb`
([guía de instalación en español](panel/packaging/INSTALL.es.md)).

The old `web/` tree is left untouched, so existing deployments keep working.
