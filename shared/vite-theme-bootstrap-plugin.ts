import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

export function themeBootstrapPlugin(): Plugin {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const source = readFileSync(path.join(repoRoot, 'shared/theme-bootstrap.js'), 'utf8');

  return {
    name: 'theme-bootstrap',
    configureServer(server) {
      server.middlewares.use('/theme-bootstrap.js', (_req, res) => {
        res.setHeader('Content-Type', 'application/javascript');
        res.end(source);
      });
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'theme-bootstrap.js',
        source,
      });
    },
  };
}
