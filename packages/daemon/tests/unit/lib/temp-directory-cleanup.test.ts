import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

test.each([
  { platform: 'win32', code: 'EPERM', failures: 2, attempts: 3, remaining: false },
  { platform: 'win32', code: 'EBUSY', failures: 10, attempts: 6, remaining: true },
  { platform: 'win32', code: 'EACCES', failures: 2, attempts: 1, remaining: true },
  { platform: 'darwin', code: 'EBUSY', failures: 2, attempts: 1, remaining: true },
])('temporary cleanup preserves bounded failure behavior %j', (scenario) => {
  const run = mkdtempSync(join(tmpdir(), 'hyperneo-temp-cleanup-'));
  const directory = join(run, 'owned');
  mkdirSync(directory);
  const bun = process.versions.bun
    ? process.execPath
    : join(process.env.BUN_INSTALL ?? join(homedir(), '.bun'), 'bin/bun');
  const module = new URL('../../../../../scripts/remove-temp-directory.ts', import.meta.url).href;
  const child = `
import { mock } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
const remove = rmSync;
const scenario = JSON.parse(process.argv[1]);
const directory = process.argv[2];
let attempts = 0;
mock.module('node:fs', () => ({
  rmSync(path, options) {
    attempts++;
    if (attempts <= scenario.failures) {
      throw Object.assign(new Error(scenario.code), { code: scenario.code });
    }
    remove(path, options);
  },
}));
Object.defineProperty(process, 'platform', { value: scenario.platform });
let code;
try {
  const { removeTempDirectory } = await import(${JSON.stringify(module)});
  await removeTempDirectory(directory);
} catch (error) {
  code = error.code;
}
console.log(JSON.stringify({ attempts, remaining: existsSync(directory), code }));
`;
  try {
    const result = JSON.parse(
      execFileSync(bun, ['-e', child, JSON.stringify(scenario), directory], {
        encoding: 'utf8',
        timeout: 10_000,
      })
    );
    expect(result.attempts).toBe(scenario.attempts);
    expect(result.remaining).toBe(scenario.remaining);
    expect(result.code).toBe(scenario.remaining ? scenario.code : undefined);
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
});
