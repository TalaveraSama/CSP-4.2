# CSP Panel (modern web interface)

The legacy status web (`web/`, packaged as `cs-status.war` by `build.xml`) is a
client-side XSLT + `bowweb.js` application from 2009 that only runs inside the
proxy's servlet container.

A modern, **Java-free** replacement lives in [`panel/`](panel/):

- Node/TypeScript BFF that speaks the documented CSP HTTP/XML API and exposes
  clean JSON (`/api/...`),
- React + Vite single-page frontend (dark theme, sortable tables, auto-refresh,
  admin command forms, `proxy.xml` editor),
- a built-in mock CSP node so the panel can be run and demoed with **no JVM at
  all** (`CSP_MOCK=1`).

```bash
cd panel && npm install && npm run dev     # demo with synthetic data
cd panel && CSP_URL=https://proxy-host:8082 npm run dev   # real node
```

See [`panel/README.md`](panel/README.md) for the architecture, the REST API and
the mapping of every legacy artefact to its replacement.

The old `web/` tree is left untouched, so existing deployments keep working.
