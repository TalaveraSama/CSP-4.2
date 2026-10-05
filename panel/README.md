# CSP Panel — modern, Java-free web panel for CardServProxy, **OSCam and NCam**

A ground-up replacement for the legacy `cs-status.war` interface. The panel is a
TypeScript stack (Node BFF + React SPA); **nothing in this folder needs a JVM,
Ant, a `.war` container, browser XSLT, or the 2009-era `bowweb.js` framework.**

One UI, three backends — the BFF normalises every dialect into the same model:

| `BACKEND` | Talks to | Endpoint | Auth | Config files |
| --- | --- | --- | --- | --- |
| `csp` (default) | CardServProxy 4.2 | `/xmlHandler`, `/cfgHandler` | HTTP basic / xml session | `proxy.xml` |
| `oscam` | OSCam web interface | `/oscamapi.html?part=...` | **HTTP Digest** (MD5), basic fallback | `oscam.conf`, `oscam.user`, … |
| `ncam` | NCam (OSCam fork) | `/ncamapi.html?part=...` | **HTTP Digest** (MD5), basic fallback | `ncam.conf`, `ncam.user`, … |

NCam keeps OSCam's XML templates verbatim and only renames the endpoint, the
document root (`<ncam>`) and the config files, so it reuses the OSCam client
through a small "flavour" descriptor — every screen, command and the editor
work the same.

Any of them can run against a built-in synthetic node (`MOCK=1`), so the whole
panel is demoable with no CSP, no OSCam/NCam and no JVM anywhere.

---

## Quick start

```bash
cd panel
npm install

# 1) demo / development with synthetic data — nothing else required
npm run dev                                   # CSP mock,   API :8090, UI :5173
BACKEND=oscam MOCK=1 npm run dev              # OSCam mock
BACKEND=ncam MOCK=1 npm run dev               # NCam mock

# 2) against a real server
CSP_URL=https://proxy-host:8082 npm run dev                  # CardServProxy
BACKEND=oscam OSCAM_URL=http://192.168.1.10:8888 npm run dev # OSCam
BACKEND=ncam  NCAM_URL=http://192.168.1.10:8888 npm run dev  # NCam

# 3) production: one process serving API + SPA
npm run build
OSCAM_URL=http://192.168.1.10:8888 BACKEND=oscam npm start   # http://0.0.0.0:8090
```

In mock mode log in with **any** user/password; `admin` gets admin rights.
Against a real node use the credentials of the proxy's user manager (CSP) or
`httpuser`/`httppwd` from `[webif]` in `oscam.conf` / `ncam.conf`
(OSCam/NCam). The softcam may live on another machine: just point the URL at
it and add the panel's IP to `httpallowed`.

Configuration is env-driven, see [`.env.example`](.env.example).

Docker: `docker build -t csp-panel panel && docker run -p 8090:8090 -e BACKEND=oscam -e OSCAM_URL=... csp-panel`

### Deployment

| Target | How |
| --- | --- |
| **Accounts** | with the CSP backend, the *Accounts* tab creates, edits and deletes the `<user>` entries of proxy.xml (fetch-cfg → edit → /cfgHandler), so client accounts are managed from the panel instead of by hand |
| **Cache cluster** | `csp-cache-node` joins the CSP cache cluster over UDP and the Cache tab shows peers, round trip times and live entries |
| **Ubuntu + NCam from scratch** | `sudo bash packaging/install-ubuntu.sh --install-ncam --backend ncam --yes` — compiles the vendored NCam ([`vendor/ncam`](../vendor/README.md)), installs `ncam.service` with its web interface enabled and points the panel at it |
| **Ubuntu 20.04/22.04/24.04** | one command: `sudo bash packaging/install-ubuntu.sh --backend oscam\|ncam\|csp` — installs Node if needed, builds and installs the `.deb`, writes `/etc/csp-panel/panel.env`, starts systemd and can configure nginx ([guide in Spanish](packaging/INSTALL.es.md)) |
| Debian/Ubuntu `.deb` | `bash packaging/build-deb.sh` → `build/csp-panel_<ver>_all.deb`; installs to `/usr/lib/csp-panel` with a `csp-panel.service` unit, `/etc/csp-panel/panel.env` and an unprivileged `csp-panel` user — see [`packaging/README.md`](packaging/README.md) |
| **aaPanel** | Node project (PM2) + nginx reverse proxy — step by step in [`deploy/aapanel/README.md`](deploy/aapanel/README.md), with `install.sh`, `ecosystem.config.cjs` and ready nginx snippets |
| systemd (from source) | [`deploy/csp-panel.service`](deploy/csp-panel.service) |
| Docker | [`Dockerfile`](Dockerfile) |

The server reads `panel/.env` at startup (real env vars win), marks its session
cookie `Secure` automatically when it sees `X-Forwarded-Proto: https`
(`SECURE_COOKIES=auto`, `TRUST_PROXY=loopback`), and can be served from a
sub-directory by building with `BASE_PATH=/csp/ npm run build`.

---

## Architecture

```
browser ──HTTPS/JSON──> BFF (Node/TS, express) ──┬─HTTP/XML──> CSP node (Java)
  React SPA                 │                    │             /xmlHandler
  no XML, no XSLT           │                    └─HTTP/XML──> OSCam (C)
  cookie session only       │                                  /oscamapi.html
                            ├── backend.ts     ProxyBackend interface + model
                            ├── csp/           HttpCspClient  | MockCspClient
                            ├── oscam/         OscamClient (+ digest transport,
                            │                  MockOscamTransport)
                            ├── sessions.ts    server-side credential store
                            └── routes.ts      REST API
```

Adding another softcam means implementing one `ProxyBackend` (six methods) —
the REST API and the entire UI stay untouched.

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
| `GET`/`PUT` | `/config` | fetch/deploy config, `?file=` on OSCam (admin) |
| `GET` | `/status/:command` | escape hatch for *any* status command, incl. plugin ones — add `?format=xml` for the raw document |
| `GET` | `/healthz` | liveness, reports the active backend |

### Frontend sections

`Overview` · `Connectors` (labelled **Readers** on OSCam) · `Sessions` ·
`Channels` · `Events` · `Logs` (last-seen / login failures) · `Admin` (control
commands rendered from whatever the backend advertises) · `Config` (editor with
xml or ini validation before deploying).

The backend publishes feature flags and wording in `/api/meta`, so sections that
a given server cannot provide (e.g. the cache card on OSCam) are hidden instead
of showing empty boxes.

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

## OSCam mapping

OSCam has no CA profiles, no CSP-style control commands and a different data
model, so the backend translates:

| OSCam | Panel |
| --- | --- |
| clients of type `r` / `p` (`part=status`) | Connectors / **Readers** |
| clients of type `c` / `m` + `part=userstats` counters | Sessions (ECM/EMM, cache hits, rate) |
| distinct CAIDs seen in `<request>` | "profiles" used by the global filter |
| `<request srvid caid>` + channel name | Watched services / Channels |
| `<log>` CDATA from `part=status&appendlog=1` | Events, warnings and file log (severity inferred) |
| `part=failban` | Login failures |
| `part=userstats` users that are offline/disabled | Last seen |
| `part=status&action=kill|restart`, `part=readerlist&action=…`, `part=userstats&action=…`, `part=shutdown` | Admin command forms |
| `part=files&file=oscam.conf` (+ `action=Save`) | Config editor (ini) |

Notes:

- OSCam protects the webif with **HTTP Digest** auth, which `fetch` does not
  implement — `oscam/http.ts` performs the challenge/response itself (and falls
  back to basic auth, or none, if that is what the box answers with).
- *Kick user* is resolved to the client thread ids of that user, because OSCam
  kills threads rather than accounts.
- The single webif account maps to an admin identity unless `httpreadonly=1`,
  in which case the panel hides the write actions.
- Commands CSP has and OSCam does not (osd-message, cache resets…) return a
  clear "not supported by the OSCam backend" instead of silently doing nothing.

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

## Using it with a real OSCam box

1. In `oscam.conf`:
   ```ini
   [webif]
   httpport   = 8888
   httpuser   = admin
   httppwd    = secret
   httpallowed = 127.0.0.1,192.168.1.0-192.168.1.255   ; must include the panel host
   ```
   (`httpport = +8888` enables https; the panel accepts the self-signed cert.)
2. Start the panel with `BACKEND=oscam OSCAM_URL=http://box-ip:8888`.
3. Log in with `httpuser` / `httppwd`. If `httpreadonly = 1` the panel becomes
   read-only automatically.

Any `part=` of the OSCam api — including ones this build does not map — is
reachable raw through `/api/status/<part>?format=xml`.

## Development

```bash
npm run typecheck   # tsc for both workspaces
npm test            # parser / request-builder / mock round-trip tests
```

Layout:

```
panel/
├── server/   Node + Express BFF (TypeScript, ESM)
│   ├── src/backend.ts     ProxyBackend interface shared by both backends
│   ├── src/csp/           CardServProxy dialect (xml builder/parser + mock)
│   ├── src/oscam/         OSCam dialect (digest transport, mapper + mock)
│   └── src/routes.ts      REST API
└── web/      React 18 + Vite SPA (TypeScript, no UI framework deps)
```
