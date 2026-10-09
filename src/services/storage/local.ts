import fs from 'node:fs/promises';
import path from 'node:path';
import type { StorageProvider } from './types.js';

/** Writes files to a local folder served at /uploads. Development only. */
export function localStorageProvider(dir: string, publicUrl: string): StorageProvider {
  const root = path.resolve(dir);
  return {
    name: 'local',
    async put(key, body) {
      const target = path.resolve(root, key);
      if (!target.startsWith(root + path.sep)) throw new Error('Invalid storage key');
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, body);
      return `${publicUrl}/${key}`;
    },
  };
}
