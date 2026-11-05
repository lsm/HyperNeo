import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const probe = fileURLToPath(
  new URL('../../../../../../scripts/bun-claim-lock-probe.ts', import.meta.url)
);
const invoke = (run: string, preload?: string) =>
  spawnSync('bun', [...(preload ? ['--preload', preload] : []), probe, run], {
    env: {
      PATH: process.env.PATH,
      HOME: join(run, 'home'),
      TMPDIR: run,
      NODE_ENV: 'test',
      HYPERNEO_DATA_DIR: join(run, 'data'),
    },
    encoding: 'utf8',
    timeout: 30000,
  });

describe('Bun claim lock parity probe', () => {
  test('waits for the native lock holder and claims the full payload once', () => {
    const run = realpathSync(mkdtempSync(join(tmpdir(), 'bun-claim-lock-')));
    try {
      const result = invoke(run);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(
        JSON.parse(readFileSync(join(run, 'evidence/bun-claim-lock.json'), 'utf8'))
      ).toMatchObject({
        runtime: 'bun',
        startupBodyCopyComplete: true,
        holderReady: true,
        lockOwned: true,
        claimWaitedForRelease: true,
        holderCommitted: true,
        singleClaimPayload: true,
        holderTerminated: true,
        gatewayClosed: true,
        databaseClosed: true,
        pass: true,
      });
      expect(existsSync(join(run, 'data/daemon.db.lock'))).toBe(false);
    } finally {
      rmSync(run, { recursive: true, force: true });
    }
  }, 45000);

  test('rejects a holder that signals ready without acquiring the write lock', () => {
    const run = realpathSync(mkdtempSync(join(tmpdir(), 'bun-claim-unheld-')));
    const preload = fileURLToPath(new URL('../../fixtures/bun-claim-unheld.mjs', import.meta.url));
    try {
      const result = invoke(run, preload);
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain('Native holder must own write lock');
      expect(
        JSON.parse(readFileSync(join(run, 'evidence/bun-claim-lock.json'), 'utf8'))
      ).toMatchObject({
        holderReady: true,
        lockOwned: false,
        claimWaitedForRelease: false,
        holderTerminated: true,
        gatewayClosed: true,
        databaseClosed: true,
        pass: false,
      });
      expect(existsSync(join(run, 'data/daemon.db.lock'))).toBe(false);
    } finally {
      rmSync(run, { recursive: true, force: true });
    }
  }, 45000);

  test('refuses existing data before opening or changing it', () => {
    const run = realpathSync(mkdtempSync(join(tmpdir(), 'bun-claim-lock-refuse-')));
    try {
      mkdirSync(join(run, 'data'));
      const marker = join(run, 'data/retained');
      writeFileSync(marker, 'unchanged');
      const result = invoke(run);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Probe requires fresh owned data');
      expect(readFileSync(marker, 'utf8')).toBe('unchanged');
      expect(existsSync(join(run, 'data/daemon.db'))).toBe(false);
    } finally {
      rmSync(run, { recursive: true, force: true });
    }
  }, 45000);
});
