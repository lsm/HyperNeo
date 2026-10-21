import { afterEach, describe, expect, test } from 'bun:test';
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCopilotAdapter } from '../../../../src/lib/drivers/copilot-adapter';
import type { WorkCallContext, WorkStarted } from '../../../../src/lib/drivers/types';

const context = { from: 'chat', caller: { source: 'rpc' } } as WorkCallContext;
const fixtures: ReturnType<typeof setup>[] = [];
function setup() {
  const run = mkdtempSync(join(tmpdir(), 'copilot-inputs-'));
  mkdirSync(join(run, 'home'));
  const fixture = fileURLToPath(new URL('../../../fixtures/copilot-sdk.ts', import.meta.url));
  const cliPath = join(run, 'copilot');
  const install = (flag = '') =>
    writeFileSync(
      cliPath,
      `#!/usr/bin/env bun\nprocess.argv.push('--production-version', '--durable-inputs', ${JSON.stringify(flag)}); await import(${JSON.stringify(fixture)});\n`,
      { mode: 0o700 }
    );
  install();
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
  const calls = () =>
    readFileSync(join(run, 'calls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  return {
    run,
    install,
    calls,
    get adapter() {
      return adapter;
    },
    async restart() {
      await adapter.close();
      adapter = createCopilotAdapter(discovery, deps);
    },
    async start(message: string) {
      const result = await adapter.start!(
        {
          place: { machine: 'test', folder: run, name: 'fixture' },
          title: 'Inputs',
          model: 'synthetic-model',
          message,
        },
        context
      );
      if (!result.ok) throw new Error(JSON.stringify(result));
      return result.value;
    },
    send(work: WorkStarted, message: string, queue = false) {
      const method = queue ? adapter.queue : adapter.send;
      return (
        method?.(work.ref, message, context) ??
        Promise.resolve({ ok: false as const, reason: 'unsupported' as const, detail: 'not wired' })
      );
    },
  };
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.adapter.close();
    rmSync(f.run, { recursive: true, force: true });
  }
});
function fixture() {
  const f = setup();
  fixtures.push(f);
  return f;
}
async function settled(f: ReturnType<typeof setup>, work: WorkStarted, receipt = work.receipt) {
  for (let poll = 0; poll < 200; poll++) {
    const result = await f.adapter.status!(work.ref, undefined, receipt);
    if (result.ok && ['done', 'failed', 'stopped'].includes(result.value.status)) return result;
    await new Promise((done) => setTimeout(done, 5));
  }
  throw new Error('no terminal evidence');
}

describe('Copilot owned input delivery', () => {
  test('resumes a reaped session for new input, preserving earlier receipt evidence across restart', async () => {
    const f = fixture();
    const work = await f.start('settled');
    const first = await settled(f, work);
    rmSync(join(f.run, 'owned/receipts'), { recursive: true });
    await f.restart();
    const result = await f.send(work, 'settled');
    expect(result).toMatchObject({
      ok: true,
      value: { delivered: true, receipt: { executionId: work.ref.id } },
    });
    if (!result.ok) throw new Error(JSON.stringify(result));
    expect(result.value.receipt?.inputId).not.toBe(work.receipt?.inputId);
    const second = await settled(f, work, result.value.receipt);
    expect(await f.adapter.status!(work.ref)).toMatchObject({
      ok: true,
      value: { lastReply: 'REPLY_2', startReceipt: work.receipt },
    });
    expect(second).toMatchObject({
      value: { lastReply: 'REPLY_2', inputEvidence: { replyAvailability: 'complete' } },
    });
    expect(await settled(f, work)).toMatchObject({
      value: { lastReply: 'REPLY_1', inputEvidence: first.value.inputEvidence },
    });
    await f.restart();
    expect(await settled(f, work, result.value.receipt)).toEqual(second);
    const calls = f.calls();
    expect(calls.filter((c) => c.method === 'session.create')).toHaveLength(1);
    const resume = calls.find((c) => c.method === 'session.resume');
    expect(resume?.params).toMatchObject({
      sessionId: work.ref.id,
      availableTools: [],
      continuePendingWork: false,
      model: 'synthetic-model',
    });
    expect(calls.filter((c) => c.method === 'session.send')).toHaveLength(2);
  });

  test('legacy snapshot-only status works before any resume or follow-up', async () => {
    const f = fixture();
    const completed = await f.start('settled');
    const active = await f.start('hold');
    const before = await settled(f, completed);
    rmSync(join(f.run, 'owned/receipts'), { recursive: true });
    expect(await f.adapter.status!(completed.ref)).toEqual(before);
    expect(await f.adapter.status!(completed.ref, undefined, completed.receipt)).toEqual(before);
    expect(await f.adapter.status!(active.ref)).toMatchObject({
      ok: true,
      value: {
        status: 'running',
        inputEvidence: { state: 'observed', replyAvailability: 'incomplete' },
      },
    });
    expect(await f.adapter.status!(active.ref, undefined, active.receipt)).toMatchObject({
      ok: true,
      value: { status: 'running' },
    });
    await f.restart();
    expect(await f.adapter.status!(completed.ref)).toEqual(before);
    expect(await f.adapter.status!(completed.ref, undefined, completed.receipt)).toEqual(before);
    expect(await f.adapter.status!(active.ref, undefined, active.receipt)).toMatchObject({
      ok: false,
      reason: 'unreachable',
    });
    expect(existsSync(join(f.run, 'owned/receipts'))).toBe(false);
    expect(f.calls().filter((c) => c.method === 'session.resume')).toHaveLength(0);
    expect(f.calls().filter((c) => c.method === 'session.send')).toHaveLength(2);
  });

  test('busy send and explicit queue remain pending, then receive only their own full reports', async () => {
    const f = fixture();
    const work = await f.start('serial:first');
    const second = await f.send(work, 'serial:second');
    const third = await f.send(work, 'serial:long', true);
    for (const result of [second, third])
      expect(result).toMatchObject({
        ok: true,
        value: {
          delivered: false,
          queuedSubmissionId: expect.any(String),
          receipt: { executionId: work.ref.id },
        },
      });
    if (!second.ok || !third.ok) throw new Error('missing queue receipts');
    for (const delivery of [second.value, third.value])
      expect(await f.adapter.status!(work.ref, undefined, delivery.receipt)).toMatchObject({
        ok: true,
        value: { status: 'running', inputEvidence: { state: 'pending' } },
      });
    writeFileSync(join(f.run, 'release-serial'), 'release');
    expect(await settled(f, work)).toMatchObject({ value: { lastReply: 'REPLY_serial:first' } });
    expect(await settled(f, work, second.value.receipt)).toMatchObject({
      value: { lastReply: 'REPLY_serial:second' },
    });
    expect(await settled(f, work, third.value.receipt)).toMatchObject({
      value: {
        lastReply: 'LONG_REPLY'.repeat(3000),
        inputEvidence: { replyAvailability: 'complete' },
      },
    });
    await f.restart();
    expect(await settled(f, work, third.value.receipt)).toMatchObject({
      value: { lastReply: 'LONG_REPLY'.repeat(3000) },
    });
    expect(
      f
        .calls()
        .filter((c) => c.method === 'session.send')
        .map((c) => c.params.mode)
    ).toEqual(['enqueue', 'enqueue', 'enqueue']);
    expect(f.adapter.capabilities).not.toContain('steer');
  });

  test('streaming changes only the affected durable receipts', async () => {
    const f = fixture();
    const work = await f.start('hold');
    const completed = await f.send(work, 'settled');
    const pending = await f.send(work, 'queued', true);
    if (!completed.ok || !pending.ok) throw new Error('missing receipts');
    const file = (id: string) =>
      join(f.run, 'owned/receipts', work.ref.id, `${encodeURIComponent(id)}.json`);
    const completePath = file(completed.value.receipt!.inputId);
    const pendingPath = file(pending.value.receipt!.inputId);
    const completeFd = openSync(completePath, 'r');
    const pendingFd = openSync(pendingPath, 'r');
    try {
      expect((await f.send(work, 'fragments')).ok).toBe(true);
      const report = Array.from({ length: 12 }, (_, index) => `FRAGMENT_${index};`).join('');
      expect(await f.adapter.status!(work.ref, undefined, work.receipt)).toMatchObject({
        ok: true,
        value: {
          inputEvidence: {
            state: 'observed',
            replyReport: report,
            replyAvailability: 'incomplete',
          },
        },
      });
      expect(statSync(completePath).ino).toBe(fstatSync(completeFd).ino);
      expect(statSync(pendingPath).ino).toBe(fstatSync(pendingFd).ino);
      expect(await f.adapter.stop!(work.ref, context)).toEqual({
        ok: true,
        value: { stopped: true },
      });
      expect(statSync(completePath).ino).toBe(fstatSync(completeFd).ino);
      expect(statSync(pendingPath).ino).not.toBe(fstatSync(pendingFd).ino);
      expect(await f.adapter.status!(work.ref, undefined, completed.value.receipt)).toMatchObject({
        ok: true,
        value: { lastReply: 'REPLY_2', inputEvidence: { replyAvailability: 'complete' } },
      });
      await f.restart();
      expect(await settled(f, work, completed.value.receipt)).toMatchObject({
        value: { lastReply: 'REPLY_2' },
      });
    } finally {
      closeSync(completeFd);
      closeSync(pendingFd);
    }
  });

  test('durable receipts outlive the bounded worker cache', async () => {
    const f = fixture();
    const work = await f.start('hold');
    const first = await f.send(work, 'settled');
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('missing receipt');
    for (let index = 0; index < 66; index++) expect((await f.send(work, 'settled')).ok).toBe(true);
    expect(await f.adapter.status!(work.ref, undefined, first.value.receipt)).toMatchObject({
      ok: true,
      value: { lastReply: 'REPLY_2', inputEvidence: { replyAvailability: 'complete' } },
    });
    expect(await f.adapter.stop!(work.ref, context)).toEqual({
      ok: true,
      value: { stopped: true },
    });
    await settled(f, work);
    await f.restart();
    expect(await settled(f, work, first.value.receipt)).toMatchObject({
      value: { lastReply: 'REPLY_2' },
    });
  });

  test('refuses blocked, external and unfinished orphaned work without runtime sends', async () => {
    const f = fixture();
    const blocked = await f.start('permission');
    expect(await f.send(blocked, 'settled')).toMatchObject({ ok: false, reason: 'busy' });
    const active = await f.start('hold');
    await f.restart();
    const before = f.calls().length;
    expect(await f.send(active, 'settled')).toMatchObject({ ok: false, reason: 'unreachable' });
    expect(
      await f.send(
        { ...active, ref: { adapter: 'copilot-cli', id: crypto.randomUUID() } },
        'settled'
      )
    ).toMatchObject({ ok: false, reason: 'not_found' });
    expect(f.calls()).toHaveLength(before);
  });

  test('receipt persistence failure rejects new input and still closes its runtime', async () => {
    const f = fixture();
    const work = await f.start('settled');
    await settled(f, work);
    mkdirSync(join(f.run, 'owned/receipts', work.ref.id, 'input-2.json.tmp'));
    expect(await f.send(work, 'settled')).toMatchObject({ ok: false, reason: 'unreachable' });
    for (const pid of new Set<number>(f.calls().map((c) => c.pid)))
      expect(() => process.kill(pid, 0)).toThrow();
    await f.restart();
    expect(await f.send(work, 'settled')).toMatchObject({ ok: false, reason: 'unreachable' });
    expect(await settled(f, work)).toMatchObject({ value: { lastReply: 'REPLY_1' } });
    for (const pid of new Set<number>(f.calls().map((c) => c.pid)))
      expect(() => process.kill(pid, 0)).toThrow();
    expect(f.calls().filter((c) => c.method === 'session.send')).toHaveLength(2);
  });

  test('late receipt persistence failure fails closed and reaps without a status poll', async () => {
    const f = fixture();
    const work = await f.start('late-settled');
    mkdirSync(join(f.run, 'owned/receipts', work.ref.id, `${work.receipt!.inputId}.json.tmp`));
    const pid = f.calls().find((c) => c.method === 'session.send').pid;
    writeFileSync(join(f.run, 'release-settlement'), 'release');
    for (let poll = 0; poll < 200; poll++) {
      try {
        process.kill(pid, 0);
      } catch {
        break;
      }
      await new Promise((done) => setTimeout(done, 5));
    }
    expect(() => process.kill(pid, 0)).toThrow();
    expect(await f.adapter.status!(work.ref, undefined, work.receipt)).toMatchObject({
      ok: false,
      reason: 'unreachable',
    });
    await f.restart();
    expect(await f.send(work, 'settled')).toMatchObject({ ok: false, reason: 'unreachable' });
    expect(f.calls().filter((c) => c.method === 'session.send')).toHaveLength(1);
  });

  test('full admission capacity returns busy without consuming another send', async () => {
    const f = fixture();
    const work = await f.start('queued');
    for (let index = 1; index < 64; index++)
      expect((await f.send(work, 'queued', true)).ok).toBe(true);
    expect(await f.send(work, 'queued', true)).toMatchObject({ ok: false, reason: 'busy' });
    expect(f.calls().filter((c) => c.method === 'session.send')).toHaveLength(64);
    expect(await f.adapter.status!(work.ref, undefined, work.receipt)).toMatchObject({
      ok: true,
      value: { inputEvidence: { state: 'pending' } },
    });
  });

  test('unknown prototype-like receipt never fabricates consumption evidence', async () => {
    const f = fixture();
    const work = await f.start('settled');
    await settled(f, work);
    expect(
      await f.adapter.status!(work.ref, undefined, {
        executionId: work.ref.id,
        inputId: '__proto__',
      })
    ).toMatchObject({ ok: false, reason: 'not_found' });
  });

  test('resume model admission refuses before resume or send and preserves old evidence', async () => {
    const f = fixture();
    const work = await f.start('settled');
    await settled(f, work);
    f.install('--no-models');
    expect(await f.send(work, 'settled')).toMatchObject({ ok: false, reason: 'unsupported_model' });
    expect(await settled(f, work)).toMatchObject({ value: { lastReply: 'REPLY_1' } });
    expect(f.calls().filter((c) => c.method === 'session.resume')).toHaveLength(0);
    expect(f.calls().filter((c) => c.method === 'session.send')).toHaveLength(1);
  });

  test.each([
    ['--logged-out', 'copilot login'],
    ['--wrong-version', 'runtime version'],
    ['--resume-error', 'Synthetic resume rejection'],
  ])(
    'pre-submit %s failure does not imply accepted input and permits explicit retry',
    async (flag, diagnostic) => {
      const f = fixture();
      const work = await f.start('settled');
      await settled(f, work);
      f.install(flag);
      const refused = await f.send(work, 'settled');
      expect(refused).toMatchObject({
        ok: false,
        reason: 'unreachable',
        detail: expect.stringContaining(diagnostic),
      });
      if (refused.ok) throw new Error('expected refusal');
      expect(refused.detail).not.toContain('input may be accepted');
      expect(refused.detail).not.toContain('do not replay');
      expect(f.calls().filter((c) => c.method === 'session.send')).toHaveLength(1);
      expect(await settled(f, work)).toMatchObject({ value: { lastReply: 'REPLY_1' } });
      f.install();
      const retried = await f.send(work, 'settled');
      expect(retried.ok).toBe(true);
      if (!retried.ok) throw new Error('retry rejected');
      expect(await settled(f, work, retried.value.receipt)).toMatchObject({
        value: { lastReply: 'REPLY_2' },
      });
      expect(f.calls().filter((c) => c.method === 'session.send')).toHaveLength(2);
    }
  );

  test('post-ACK record failure retains the do-not-replay warning', async () => {
    const f = fixture();
    const work = await f.start('settled');
    await settled(f, work);
    const sending = f.send(work, 'held-ack');
    try {
      for (
        let poll = 0;
        poll < 200 &&
        !f.calls().some((c) => c.method === 'session.send' && c.params.prompt === 'held-ack');
        poll++
      )
        await new Promise((done) => setTimeout(done, 5));
      expect(
        f.calls().some((c) => c.method === 'session.send' && c.params.prompt === 'held-ack')
      ).toBe(true);
      mkdirSync(join(f.run, 'owned', `${work.ref.id}.json.tmp`));
    } finally {
      writeFileSync(join(f.run, 'release-ack'), 'release');
    }
    const refused = await sending;
    expect(refused).toMatchObject({
      ok: false,
      reason: 'unreachable',
      detail: expect.stringContaining('input may be accepted; do not replay'),
    });
    await f.restart();
    expect(await f.send(work, 'settled')).toMatchObject({ ok: false, reason: 'unreachable' });
    expect(f.calls().filter((c) => c.method === 'session.send')).toHaveLength(2);
  });

  test('lost follow-up ACK never replays, but earlier complete evidence survives', async () => {
    const f = fixture();
    const work = await f.start('settled');
    await settled(f, work);
    expect(await f.send(work, 'lost-ack')).toMatchObject({ ok: false, reason: 'unreachable' });
    expect(await f.adapter.status!(work.ref)).toMatchObject({ ok: false, reason: 'unreachable' });
    await f.restart();
    expect(await f.send(work, 'settled')).toMatchObject({ ok: false, reason: 'unreachable' });
    expect(await settled(f, work)).toMatchObject({ value: { lastReply: 'REPLY_1' } });
    expect(f.calls().filter((c) => c.method === 'session.send')).toHaveLength(2);
  });
});
