# CSP Panel (modern web interface)

The legacy status web (`web/`, packaged as `cs-status.war` by `build.xml`) is a
client-side XSLT + `bowweb.js` application from 2009 that only runs inside the
proxy's servlet container.

A modern, **Java-free** replacement lives in [`panel/`](panel/), which also
speaks **OSCam**:

- Node/TypeScript BFF with two interchangeable backends — CardServProxy
  (`/xmlHandler`) and OSCam (`/oscamapi.html`, HTTP Digest auth) — both
  normalised to the same clean JSON API (`/api/...`),
- React + Vite single-page frontend (dark theme, sortable tables, auto-refresh,
  admin command forms, `proxy.xml` editor),
- built-in mock nodes for both backends, so the panel can be run and demoed with
  **no CSP, no OSCam and no JVM at all** (`MOCK=1`).

```bash
cd panel && npm install && npm run dev                 # demo, CSP mock data
cd panel && BACKEND=oscam MOCK=1 npm run dev           # demo, OSCam mock data
cd panel && CSP_URL=https://proxy-host:8082 npm run dev
cd panel && BACKEND=oscam OSCAM_URL=http://box:8888 npm run dev
```

See [`panel/README.md`](panel/README.md) for the architecture, the REST API and
the mapping of every legacy artefact to its replacement.

The old `web/` tree is left untouched, so existing deployments keep working.
