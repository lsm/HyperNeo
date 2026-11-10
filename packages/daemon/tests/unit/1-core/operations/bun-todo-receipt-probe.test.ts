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
  new URL('../../../../../../scripts/bun-todo-receipt-probe.ts', import.meta.url)
);
const invoke = (run: string) =>
  spawnSync('bun', [probe, run], {
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

describe('Bun todo receipt parity probe', () => {
  test('preserves recovery, live status, dispatch rollback and reader snapshot receipts', () => {
    const run = realpathSync(mkdtempSync(join(tmpdir(), 'bun-todo-receipt-')));
    try {
      const result = invoke(run);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(
        JSON.parse(readFileSync(join(run, 'evidence/bun-todo-receipt.json'), 'utf8'))
      ).toMatchObject({
        runtime: 'bun',
        startupBodyCopyComplete: true,
        bootstrapReceipt: true,
        liveStatus: true,
        dispatchReceipt: true,
        dispatchRollback: true,
        readerSnapshots: true,
        gatewayClosed: true,
        databaseClosed: true,
        pass: true,
      });
      expect(existsSync(join(run, 'data/daemon.db.lock'))).toBe(false);
    } finally {
      rmSync(run, { recursive: true, force: true });
    }
  }, 45000);

  test('refuses existing data before opening or changing it', () => {
    const run = realpathSync(mkdtempSync(join(tmpdir(), 'bun-todo-receipt-refuse-')));
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
