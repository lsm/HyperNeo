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
export function testDirectories(): (prefix: string) => string {
  afterAll(cleanup);
  return (prefix) => {
    const directory = mkdtempSync(prefix);
    directories.add(directory);
    return directory;
  };
}
