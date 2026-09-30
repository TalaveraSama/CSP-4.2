import express from 'express';
import cookieParser from 'cookie-parser';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import type { ProxyBackend } from './backend.js';
import { HttpCspClient } from './csp/client.js';
import { MockCspClient } from './csp/mock.js';
import { OscamClient } from './oscam/client.js';
import { HttpOscamTransport } from './oscam/http.js';
import { MockOscamTransport } from './oscam/mock.js';
import { createApiRouter } from './routes.js';
import { SessionStore } from './sessions.js';

const targetUrl = config.backend === 'oscam' ? config.oscamUrl : config.cspUrl;

if (config.insecureTls && targetUrl.startsWith('https:')) {
  // CSP nodes (gen-keystore) and OSCam (https_auto_create_cert) both use self-signed certs.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

function createBackend(): ProxyBackend {
  if (config.backend === 'oscam') {
    return config.mock ? new OscamClient(new MockOscamTransport(), true) : new OscamClient(new HttpOscamTransport(config.oscamUrl));
  }
  return config.mock ? new MockCspClient() : new HttpCspClient(config.cspUrl);
}

const backend = createBackend();
const sessions = new SessionStore(config.sessionTtlMs);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));
app.use(express.text({ type: ['text/xml', 'application/xml', 'text/plain'], limit: '8mb' }));

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, backend: backend.info.kind, mock: backend.info.mock, target: backend.info.target });
});

app.use('/api', createApiRouter(backend, sessions, false));

// Serve the built SPA when it exists (single-artifact deployment).
const webRoot = config.webRoot;
if (existsSync(join(webRoot, 'index.html'))) {
  app.use(express.static(webRoot, { index: false, maxAge: '1h' }));
  app.get('*', (_req, res) => res.sendFile(join(webRoot, 'index.html')));
} else {
  app.get('/', (_req, res) => {
    res
      .status(200)
      .type('text/plain')
      .send(
        [
          'CSP panel API is running.',
          `backend: ${backend.info.kind}${backend.info.mock ? ' (mock)' : ''} -> ${backend.info.target}`,
          '',
          'The frontend has not been built yet. Run `npm run build` in panel/,',
          'or use `npm run dev` and open the Vite dev server instead.',
        ].join('\n'),
      );
  });
}

app.listen(config.port, config.host, () => {
  console.log(`[csp-panel] api listening on http://${config.host}:${config.port}`);
  console.log(`[csp-panel] backend: ${backend.info.kind}${backend.info.mock ? ' (mock)' : ''} -> ${backend.info.target}`);
  if (backend.info.mock) console.log('[csp-panel] mock mode: log in with any user/password (use "admin" for admin rights)');
});
