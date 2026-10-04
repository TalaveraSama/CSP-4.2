import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Version reported by /api/meta.
 *
 * Resolved from the nearest package.json so it is always the real one:
 *   dev   -> panel/package.json          (src/version.ts -> ../../)
 *   .deb  -> /usr/lib/csp-panel/package.json (dist/version.js -> ../../)
 */
function readVersion(): string {
  for (const candidate of ['../../package.json', '../package.json']) {
    try {
      const path = fileURLToPath(new URL(candidate, import.meta.url));
      const pkg = JSON.parse(readFileSync(path, 'utf8')) as { name?: string; version?: string };
      if (pkg.version) return pkg.version;
    } catch {
      /* try the next location */
    }
  }
  return '0.0.0';
}

export const PANEL_VERSION = readVersion();
