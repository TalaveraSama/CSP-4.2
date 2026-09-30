# CSP Panel — modern, Java-free web panel for CardServProxy 4.2

A ground-up replacement for the legacy `cs-status.war` interface. The panel is a
TypeScript stack (Node BFF + React SPA); **nothing in this folder needs a JVM,
Ant, a `.war` container, browser XSLT, or the 2009-era `bowweb.js` framework.**

It can run in two modes:

| Mode | What it talks to | Java needed? |
| --- | --- | --- |
| `CSP_MOCK=1` (default when `CSP_URL` is unset) | built-in synthetic CSP node | **no** |
| `CSP_URL=http://host:8082` | a real CSP 4.2 node's HTTP/XML API | only the proxy itself |

---

## Quick start

```bash
cd panel
npm install

# 1) demo / development with synthetic data — no CSP node required
npm run dev            # API on :8090, UI on :5173 (proxies /api to the API)

# 2) against a real proxy
CSP_URL=https://proxy-host:8082 npm run dev

# 3) production: one process serving API + SPA
npm run build
CSP_URL=https://proxy-host:8082 npm start     # http://0.0.0.0:8090
```

In mock mode log in with **any** user/password; `admin` gets admin rights and
`root` gets superuser rights. Against a real node, use any account defined by
the proxy's user manager (the same credentials as the old panel).

Configuration is env-driven, see [`.env.example`](.env.example).

Docker: `docker build -t csp-panel panel && docker run -p 8090:8090 -e CSP_URL=... csp-panel`

---

## Architecture

```
browser ──HTTPS/JSON──> BFF (Node/TS, express)  ──HTTP/XML──> CSP node (Java)
  React SPA                 │                                  /xmlHandler
  no XML, no XSLT           ├── xml.ts     request builder + parser -> typed model
  cookie session only       ├── client.ts  HttpCspClient | MockCspClient
                            ├── sessions.ts  server-side credential store
                            └── routes.ts    REST API
```

Why a BFF instead of calling the proxy straight from the browser:

- **Credentials stay server-side.** The browser only holds an opaque `httpOnly`
  cookie; the old panel kept the CSP session id in a readable JS cookie.
- **No CORS / mixed-content headaches** with self-signed proxy certificates.
- **One place to normalise XML**, so the UI is plain JSON and fully typed.
- The panel can be hosted anywhere (nginx box, container, laptop) while the
  proxy stays on its own network.

### REST API (all under `/api`)

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/auth/login` `/auth/logout`, `GET /auth/me` | session cookie |
| `GET` | `/overview` | proxy-status + cache + profiles + connectors + plugins |
| `GET` | `/connectors`, `/sessions`, `/events`, `/channels`, `/seen`, `/failures` | `?profile=`, `?hideInactive=`, `?all=` |
| `GET` | `/commands` | ctrl-commands definitions (dynamic, plugin-aware) |
| `POST` | `/commands/:name` | run a control command (admin) |
| `GET`/`PUT` | `/config` | fetch/deploy `proxy.xml` (admin) |
| `GET` | `/status/:command` | escape hatch for *any* status command, incl. plugin ones — add `?format=xml` for the raw document |
| `GET` | `/healthz` | liveness, reports the active backend |

### Frontend sections

`Overview` · `Connectors` · `Sessions` · `Channels` · `Events` · `Logs`
(last-seen / login failures) · `Admin` (dynamic control-command forms) ·
`Config` (`proxy.xml` editor with well-formedness validation before deploy).

Global controls in the top bar: CA-profile filter and auto-refresh interval
(off / 2s / 5s / 15s / 60s), both persisted in `localStorage`.

---

## What was untangled, and where it went

| Legacy artefact | Status |
| --- | --- |
| `web/cs-status.html` + `js/bowutil.js` + `js/bowweb.js` | dropped — replaced by a React shell with hash routing |
| `web/xslt/cws-status-resp.xsl` (955 lines of browser XSLT) | dropped — XML is parsed once in `server/src/csp/xml.ts` into a typed model |
| `js/cs-status.js` section/query definitions + XML pre-processing hacks (hex ids, timestamp fixups, visibility attributes injected into the XML) | replaced by `routes.ts` (queries) and React state (view concerns) |
| CodeMirror 0.x bundled in `web/js/cm/` | replaced by a plain editor with `DOMParser` validation (no vendored library) |
| `build.xml` `build-web` target producing `cs-status.war` | replaced by `npm run build` → static `web/dist` + `server/dist` (or a Docker image) |
| `WEB-INF/web.xml`, servlet packaging | gone |
| `/xmlHandler` links opening raw XML in new tabs | replaced by `/api/status/:command?format=xml` |
| IE6-9 compatibility shims, `transformNode`, `document.all` branches | gone |

The legacy `web/` directory is intentionally left untouched so existing
deployments keep working; this panel is additive.

---

## Using it with a real CSP node

1. In `proxy.xml`, make sure the HTTP API is reachable:
   `<status-web enabled="true" port="8082"/>` (plus `rmi` as documented in
   `README.HttpXmlApi.txt`).
2. Point the panel at it: `CSP_URL=https://proxy-host:8082`.
   Self-signed certificates from the proxy's `gen-keystore` command are accepted
   by default (`CSP_INSECURE_TLS=1`); set it to `0` to enforce validation.
3. Optionally serve the panel behind nginx/caddy with TLS and set
   `secure` cookies by terminating HTTPS in front of it.

Everything the panel needs is the documented status/control API, so it also
works against older CSP releases — unknown sections simply render empty, and
any status command (including ones added by plugins) is reachable through
`/api/status/:command`.

## Development

```bash
npm run typecheck   # tsc for both workspaces
npm test            # parser / request-builder / mock round-trip tests
```

Layout:

```
panel/
├── server/   Node + Express BFF (TypeScript, ESM)
│   ├── src/csp/xml.ts     XML <-> typed model (the heart of the port)
│   ├── src/csp/client.ts  real CSP client
│   ├── src/csp/mock.ts    synthetic CSP node
│   └── src/routes.ts      REST API
└── web/      React 18 + Vite SPA (TypeScript, no UI framework deps)
```
