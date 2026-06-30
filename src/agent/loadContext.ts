import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const contextPath = join(dirname(fileURLToPath(import.meta.url)), 'context.md');

export function loadAgentContext(): string {
  return readFileSync(contextPath, 'utf-8').trim();
}
