import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const currentDir = dirname(fileURLToPath(import.meta.url));

export const APP_VERSION: string = require('../package.json').version;

// Written by scripts/write-git-sha.sh during `npm run build`; absent in dev
// (tsx runs src/ directly, so dist/GIT_SHA doesn't exist alongside it).
export const GIT_SHA: string = (() => {
  try {
    return readFileSync(join(currentDir, 'GIT_SHA'), 'utf8').trim();
  } catch {
    return 'unknown';
  }
})();
