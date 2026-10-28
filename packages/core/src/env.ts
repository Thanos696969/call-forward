import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Load the nearest `.env` walking up from `startDir` into process.env without
 * overriding variables already set. Missing files are fine: every setting has a
 * local default.
 */
export function loadEnvFile(startDir: string = process.cwd()): string | null {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
