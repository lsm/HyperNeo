import { afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';

const directories = new Set<string>();

function cleanup() {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
    directories.delete(directory);
  }
}

process.once('exit', cleanup);
afterAll(() => {
  cleanup();
  process.off('exit', cleanup);
});

export function createTestDirectory(prefix: string): string {
  const directory = mkdtempSync(prefix);
  directories.add(directory);
  return directory;
}
