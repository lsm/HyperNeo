import { describe, expect, test } from 'bun:test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import {
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  existsSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

async function stopOwnedProbe(parent: ChildProcess, closed: Promise<unknown>) {
  if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGTERM');
  await closed.catch(() => undefined);
}

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
          timeout: 60000,
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
  }, 90000);
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
      const end = Date.now() + 30000;
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
      await stopOwnedProbe(parent, result);
      rmSync(run, { recursive: true, force: true });
    }
  }, 90000);
  test('startup-wait cleanup lets the probe stop and reap its daemon before data removal', async () => {
    const run = realpathSync(mkdtempSync(join(tmpdir(), 'bun-boot-timeout-')));
    const ready = join(run, 'daemon-ready'),
      stopped = join(run, 'daemon-stopped');
    const fixture = join(run, 'delayed-probe.mjs');
    const daemonCode =
      'import {writeFileSync} from "node:fs"; process.on("SIGTERM",()=>{writeFileSync(' +
      JSON.stringify(stopped) +
      ',"stopped");process.exit(0)});writeFileSync(' +
      JSON.stringify(ready) +
      ',String(process.pid));setInterval(()=>{},1000)';
    writeFileSync(
      fixture,
      'import {spawn} from "node:child_process"; const child=spawn(process.execPath,["-e",' +
        JSON.stringify(daemonCode) +
        '],{stdio:"ignore"});process.on("SIGTERM",()=>{child.once("close",()=>process.exit(143));child.kill("SIGTERM")});setInterval(()=>{},1000)'
    );
    const parent = spawn('bun', [fixture], {
      stdio: 'ignore',
      env: { PATH: process.env.PATH, HOME: run, TMPDIR: run, NODE_ENV: 'test' },
    });
    const closed = new Promise((done) => parent.once('close', done));
    let daemonPid: number | undefined;
    try {
      const end = Date.now() + 5000;
      while (!existsSync(ready)) {
        if (Date.now() > end) throw new Error('Delayed daemon fixture failed to start');
        await new Promise((done) => setTimeout(done, 5));
      }
      daemonPid = Number(readFileSync(ready, 'utf8'));
      expect(existsSync(join(run, 'data/local-rpc.credential'))).toBe(false);
      await stopOwnedProbe(parent, closed);
      expect(existsSync(stopped)).toBe(true);
      expect(() => process.kill(daemonPid!, 0)).toThrow();
    } finally {
      await stopOwnedProbe(parent, closed);
      if (daemonPid) {
        try {
          process.kill(daemonPid, 'SIGTERM');
          const deadline = Date.now() + 5000;
          for (;;) {
            try {
              process.kill(daemonPid, 0);
            } catch {
              break;
            }
            if (Date.now() > deadline) throw new Error('Synthetic daemon did not exit');
            await new Promise((done) => setTimeout(done, 5));
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
      rmSync(run, { recursive: true, force: true });
    }
  });
});
