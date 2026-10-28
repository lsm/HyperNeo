import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCopilotAdapter } from '../../../../src/lib/drivers/copilot-adapter';
import type { WorkCallContext, WorkStarted } from '../../../../src/lib/drivers/types';

const context = { from: 'chat', caller: { source: 'rpc' } } as WorkCallContext;
const runs: { run: string; close: () => Promise<void> }[] = [];
function setup(flag = '') {
  const run = mkdtempSync(join(tmpdir(), 'copilot-withdraw-'));
  mkdirSync(join(run, 'home'));
  const source = fileURLToPath(new URL('../../../fixtures/copilot-sdk.ts', import.meta.url));
  const cliPath = join(run, 'copilot');
  writeFileSync(
    cliPath,
    `#!/usr/bin/env bun\nprocess.argv.push('--production-version', '--durable-inputs', ${JSON.stringify(flag)}); await import(${JSON.stringify(source)});\n`,
    { mode: 0o700 }
  );
  const deps = {
    cliPath,
    directory: join(run, 'owned'),
    machine: 'test',
    homeDir: join(run, 'home'),
    env: { HOME: join(run, 'home'), PATH: process.env.PATH ?? '' },
    timeoutMs: 1500,
    folderExists: existsSync,
    makeFolder: (folder: string) => mkdirSync(folder),
  };
  const discovery = { id: 'copilot-cli', capabilities: ['find'] as const, find: () => [] };
  let adapter = createCopilotAdapter(discovery, deps);
  runs.push({ run, close: () => adapter.close() });
  const calls = (): { method: string; params?: unknown }[] =>
    readFileSync(join(run, 'calls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  return {
    run,
    get adapter() {
      return adapter;
    },
    queueCalls: () => calls().filter((call) => call.method.startsWith('session.queue.')),
    async restart() {
      await adapter.close();
      adapter = createCopilotAdapter(discovery, deps);
    },
    async start(message: string) {
      const result = await adapter.start!(
        {
          place: { machine: 'test', folder: run, name: 'fixture' },
          title: 'Withdraw',
          model: 'synthetic-model',
          message,
        },
        context
      );
      if (!result.ok) throw new Error(JSON.stringify(result));
      return result.value;
    },
    async queue(work: WorkStarted, message: string) {
      const result = await adapter.queue!(work.ref, message, context);
      if (!result.ok || !result.value.receipt) throw new Error(JSON.stringify(result));
      return result.value.receipt.inputId;
    },
    withdraw: (work: WorkStarted, id: string) => adapter.withdraw!(work.ref, id, context),
  };
}
afterEach(async () => {
  for (const { run, close } of runs.splice(0)) {
    await close();
    rmSync(run, { recursive: true, force: true });
  }
});

describe('Copilot owned withdraw', () => {
  test('removes a still-queued input by its message id and lets the session settle', async () => {
    const f = setup();
    expect(f.adapter.capabilities).toContain('withdraw');
    const work = await f.start('serial:first');
    const queued = await f.queue(work, 'queued');
    expect(await f.withdraw(work, queued)).toEqual({
      ok: true,
      value: { queuedSubmissionId: queued, withdrawn: true },
    });
    expect(f.queueCalls().map((call) => [call.method, call.params])).toEqual([
      ['session.queue.pendingItems', { sessionId: work.ref.id }],
      ['session.queue.removeAt', { sessionId: work.ref.id, id: 'queue-item-2' }],
    ]);
    expect(await f.withdraw(work, queued)).toEqual({
      ok: true,
      value: { queuedSubmissionId: queued, withdrawn: false, reason: 'not_queued' },
    });
    writeFileSync(join(f.run, 'release-serial'), 'release');
    let status = '';
    for (let poll = 0; poll < 200 && status !== 'done'; poll++) {
      const result = await f.adapter.status!(work.ref);
      if (result.ok) status = result.value.status;
      await new Promise((done) => setTimeout(done, 5));
    }
    expect(status).toBe('done');
    expect(
      await f.adapter.status!(work.ref, undefined, { executionId: work.ref.id, inputId: queued })
    ).toMatchObject({
      ok: true,
      value: { status: 'stopped', inputEvidence: { state: 'pending' } },
    });
  });

  test('withdrawing the last unsettled input after the turn idles settles the session', async () => {
    const f = setup();
    const work = await f.start('serial:first');
    const queued = await f.queue(work, 'queued');
    writeFileSync(join(f.run, 'release-serial'), 'release');
    let first = '';
    for (let poll = 0; poll < 200 && first !== 'done'; poll++) {
      const result = await f.adapter.status!(work.ref, undefined, work.receipt);
      if (result.ok) first = result.value.inputEvidence?.state === 'observed' ? 'done' : '';
      await new Promise((done) => setTimeout(done, 5));
    }
    expect(await f.adapter.status!(work.ref)).toMatchObject({
      ok: true,
      value: { status: 'running' },
    });
    expect(await f.withdraw(work, queued)).toMatchObject({ ok: true, value: { withdrawn: true } });
    expect(await f.adapter.status!(work.ref)).toMatchObject({
      ok: true,
      value: { status: 'done' },
    });
  });

  test('reports an input Copilot already consumed as not queued without removing anything', async () => {
    const f = setup();
    const work = await f.start('serial:first');
    expect(await f.withdraw(work, work.receipt!.inputId)).toEqual({
      ok: true,
      value: { queuedSubmissionId: work.receipt!.inputId, withdrawn: false, reason: 'not_queued' },
    });
    expect(f.queueCalls().map((call) => call.method)).toEqual(['session.queue.pendingItems']);
  });

  test('refuses foreign inputs and work without a live owner before touching the queue', async () => {
    const f = setup();
    const work = await f.start('hold');
    const queued = await f.queue(work, 'queued');
    expect(await f.withdraw(work, 'input-99')).toMatchObject({ ok: false, reason: 'not_found' });
    await f.restart();
    expect(await f.withdraw(work, queued)).toMatchObject({ ok: false, reason: 'unreachable' });
    expect(f.queueCalls()).toEqual([]);
  });

  test('a lost removal reply fails closed instead of leaving the input pending', async () => {
    const f = setup('--lost-remove-ack');
    const work = await f.start('serial:first');
    const queued = await f.queue(work, 'queued');
    expect(await f.withdraw(work, queued)).toMatchObject({ ok: false, reason: 'unreachable' });
    expect(await f.adapter.status!(work.ref)).toMatchObject({ ok: false, reason: 'unreachable' });
    expect(await f.adapter.send!(work.ref, 'settled', context)).toMatchObject({
      ok: false,
      reason: 'unreachable',
    });
  });
});
