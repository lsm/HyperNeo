import { describe, expect, test } from 'bun:test';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('Bun daemon boot probe construction', () => {
  test('source daemon serves real boot/read probes and exits gracefully on SIGTERM', () => {
    const run = realpathSync(mkdtempSync(join(tmpdir(), 'bun-boot-probe-')));
    try {
      execFileSync(
        'bun',
        [
          fileURLToPath(
            new URL('../../../../../../scripts/bun-daemon-boot-probe.ts', import.meta.url)
          ),
          run,
        ],
        {
          env: {
            PATH: process.env.PATH,
            HOME: join(run, 'home'),
            TMPDIR: run,
            NODE_ENV: 'test',
            HYPERNEO_DATA_DIR: join(run, 'data'),
          },
          timeout: 30000,
          stdio: 'pipe',
        }
      );
      const evidence = JSON.parse(readFileSync(join(run, 'evidence/bun-daemon-boot.json'), 'utf8'));
      expect(evidence).toMatchObject({
        pass: true,
        httpStatus: 200,
        health: 'ok',
        statusEmpty: true,
        pageEmpty: true,
        liveEmpty: true,
        shutdownCode: 0,
        shutdownSignal: null,
        gracefulShutdown: true,
        childExited: true,
      });
      expect(evidence.port).toBeGreaterThan(0);
      expect(evidence.port).not.toBe(8399);
      expect(evidence.tables).toBeGreaterThan(80);
      expect(readFileSync(join(run, 'evidence/daemon.log'), 'utf8')).toContain(
        'Graceful shutdown complete'
      );
    } finally {
      rmSync(run, { recursive: true, force: true });
    }
  });
  test('external cancellation returns 143 and waits for its owned daemon child', async () => {
    const run = realpathSync(mkdtempSync(join(tmpdir(), 'bun-boot-cancel-')));
    const parent = spawn(
      'bun',
      [
        fileURLToPath(
          new URL('../../../../../../scripts/bun-daemon-boot-probe.ts', import.meta.url)
        ),
        run,
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: join(run, 'home'),
          TMPDIR: run,
          NODE_ENV: 'test',
          HYPERNEO_DATA_DIR: join(run, 'data'),
        },
        stdio: 'ignore',
      }
    );
    const result = new Promise<number | null>((done, reject) => {
      parent.once('close', done);
      parent.once('error', reject);
    });
    result.catch(() => undefined);
    const until = async (ready: () => boolean) => {
      const end = Date.now() + 10000;
      while (!ready()) {
        if (Date.now() > end) throw new Error('Owned cancellation fixture timed out');
        await new Promise((done) => setTimeout(done, 5));
      }
    };
    try {
      await until(
        () => existsSync(join(run, 'data/local-rpc.credential')) || parent.exitCode !== null
      );
      expect(parent.exitCode).toBeNull();
      expect(parent.kill('SIGTERM')).toBe(true);
      await until(() => parent.exitCode !== null || parent.signalCode !== null);
      expect(await result).toBe(143);
      const evidence = JSON.parse(readFileSync(join(run, 'evidence/bun-daemon-boot.json'), 'utf8'));
      expect(evidence.childExited).toBe(true);
      expect(evidence.pass).not.toBe(true);
      expect(() => process.kill(evidence.pid, 0)).toThrow();
    } finally {
      if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL');
      await result.catch(() => undefined);
      rmSync(run, { recursive: true, force: true });
    }
  });
});
