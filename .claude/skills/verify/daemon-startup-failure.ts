import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spyOn } from 'bun:test';
import { createDaemonApp, releaseStartupFileLogCapture } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { Database } from '../../../packages/daemon/src/storage/database.ts';
import { JobQueueProcessor } from '../../../packages/daemon/src/storage/job-queue-processor.ts';
import { SKILL_VALIDATE } from '../../../packages/daemon/src/lib/job-queue-constants.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'bin'), { recursive: true });
mkdirSync(join(run, 'evidence'), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
process.env.PATH = `${join(run, 'bin')}:${process.env.PATH}`;
const network = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('External HTTP is disabled'); }) as typeof fetch;
const report: Record<string, unknown> = { verified: false, cases: [] };
let exitCode = 0;
try {
  for (const stage of ['post-bind', 'processors-started']) {
    const path = join(run, 'data', `${stage}.db`);
    const failure = new Error(`Synthetic ${stage} startup rejection`);
    let database: Database | undefined;
    let listener: ReturnType<typeof Bun.serve> | undefined;
    const started: JobQueueProcessor[] = [];
    const initialize = Database.prototype.initialize;
    const register = JobQueueProcessor.prototype.register;
    const start = JobQueueProcessor.prototype.start;
    const serve = Bun.serve;
    const initSpy = spyOn(Database.prototype, 'initialize').mockImplementation(async function (this: Database, ...args: Parameters<Database['initialize']>) {
      database = this;
      return initialize.apply(this, args);
    });
    const serveSpy = spyOn(Bun, 'serve').mockImplementation((options) => {
      listener = serve(options);
      assert.notEqual(listener.port, 8399);
      return listener;
    });
    const registerSpy = spyOn(JobQueueProcessor.prototype, 'register').mockImplementation(function (this: JobQueueProcessor, ...args: Parameters<JobQueueProcessor['register']>) {
      if (stage === 'post-bind' && args[0] === SKILL_VALIDATE) throw failure;
      return register.apply(this, args);
    });
    const startSpy = spyOn(JobQueueProcessor.prototype, 'start').mockImplementation(function (this: JobQueueProcessor) {
      started.push(this);
      if (stage === 'processors-started' && started.length === 3) throw failure;
      start.call(this);
    });
    try {
      let rejected: unknown;
      try {
        await createDaemonApp({ config: getConfig({ host: '127.0.0.1', port: 0, dbPath: path }), verbose: false });
      } catch (error) { rejected = error; }
      assert.equal(rejected, failure);
      assert(listener, 'the failure must occur after a real listener binds');
      serveSpy.mockRestore();
      let portReleased = false;
      try {
        const probe = Bun.serve({ hostname: '127.0.0.1', port: listener.port, fetch: () => new Response('reused') });
        probe.stop(true);
        portReleased = true;
      } catch {}
      let databaseClosed = false;
      try { database!.getDatabase().prepare('SELECT 1').get(); }
      catch { databaseClosed = true; }
      (report.cases as unknown[]).push({ stage, portReleased, databaseClosed, lockReleased: !existsSync(`${path}.lock`), polling: started.map(processor => processor.snapshot().running) });
    } finally {
      initSpy.mockRestore(); serveSpy.mockRestore(); registerSpy.mockRestore(); startSpy.mockRestore();
      listener?.stop(true);
      await Promise.allSettled(started.map(processor => processor.stop()));
      await Promise.resolve(database?.close()).catch(() => {});
      await releaseStartupFileLogCapture();
    }
  }
  for (const result of report.cases as Array<{ portReleased: boolean; databaseClosed: boolean; lockReleased: boolean; polling: boolean[] }>) {
    assert(result.portReleased, 'the rejected daemon must release its listening port');
    assert(result.databaseClosed, 'the rejected daemon must close its database');
    assert(result.lockReleased, 'the rejected daemon must release its database lock');
    assert(result.polling.every(running => !running), 'processors must stop polling after startup rejects');
  }
  report.verified = true;
} catch (error) {
  exitCode = 1;
  report.error = String(error);
} finally {
  globalThis.fetch = network;
  writeFileSync(join(run, 'evidence/startup-failure.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report));
process.exit(exitCode);
