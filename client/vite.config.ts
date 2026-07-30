import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { themeBootstrapPlugin } from '../shared/vite-theme-bootstrap-plugin';

const clientRoot = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = path.resolve(clientRoot, '..');

const clientPackage = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8')
) as { version: string };

export default defineConfig({
  plugins: [react(), themeBootstrapPlugin()],
  define: {
    __APP_VERSION__: JSON.stringify(clientPackage.version),
  },
  resolve: {
    alias: {
      '@qtask/agent': path.resolve(repoRoot, 'src/agent'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/health': 'http://localhost:3000',
      '/oauth': 'http://localhost:3000',
      '/.well-known': 'http://localhost:3000',
    },
  },
});
