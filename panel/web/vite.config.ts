import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiTarget = process.env.API_TARGET ?? 'http://127.0.0.1:8090';

// Set BASE_PATH when the panel is served from a sub-directory, e.g. /csp/
const base = (process.env.BASE_PATH ?? '/').replace(/\/*$/, '/');

export default defineConfig({
  base,
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: Number(process.env.PORT ?? 5173),
    strictPort: true,
    // The dev server is reached through an https reverse proxy in cloud sandboxes.
    allowedHosts: true,
    hmr: { clientPort: 443, protocol: 'wss' },
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
      '/healthz': { target: apiTarget, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
});
