import { afterEach, describe, expect, test } from 'bun:test';
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
import { pickRoute } from '../../../../src/lib/drivers/work-operations';
import { createCopilotAdapter } from '../../../../src/lib/drivers/copilot-adapter';
import type { StartRequest, WorkCallContext } from '../../../../src/lib/drivers/types';

const runs: string[] = [];
const owners: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.close();
  for (const run of runs.splice(0)) rmSync(run, { recursive: true, force: true });
});
const context = { from: 'chat', caller: { source: 'rpc' } } as WorkCallContext;
function setup(flag = '', options: { timeoutMs?: number } = { timeoutMs: 1500 }) {
  const run = mkdtempSync(join(tmpdir(), 'copilot-adapter-'));
  runs.push(run);
  mkdirSync(join(run, 'home'));
  const cliPath = join(run, 'copilot');
  const fixture = fileURLToPath(new URL('../../../fixtures/copilot-sdk.ts', import.meta.url));
  writeFileSync(
    cliPath,
    `#!/usr/bin/env bun\nprocess.argv.push('--production-version', ${JSON.stringify(flag)}); await import(${JSON.stringify(fixture)});\n`,
    { mode: 0o700 }
  );
  const deps = {
    cliPath,
    directory: join(run, 'owned'),
    machine: 'test',
    homeDir: join(run, 'home'),
    env: { HOME: join(run, 'home'), PATH: process.env.PATH ?? '' },
    timeoutMs: options.timeoutMs,
    folderExists: existsSync,
    makeFolder: (path: string) => mkdirSync(path),
  };
  const discovery = { id: 'copilot-cli', capabilities: ['find'] as const, find: () => [] };
  const adapter = createCopilotAdapter(discovery, deps);
  owners.push(adapter);
  const request: StartRequest = {
    place: { machine: 'test', folder: run, name: 'fixture' },
    title: 'Synthetic work',
    message: 'hold',
    model: 'synthetic-model',
  };
  return { run, deps, discovery, adapter, request };
}
async function start(fixture: ReturnType<typeof setup>, message = fixture.request.message) {
  const result = await fixture.adapter.start!({ ...fixture.request, message }, context);
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.value;
}

describe('owned Copilot lifecycle', () => {
  test('gives the owned runtime work locations and the brief without a sandbox marker', async () => {
    const fixture = setup();
    await start(fixture);
    const calls = readFileSync(join(fixture.run, 'calls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(calls[0].worktrees).toMatch(/worktrees$/);
    expect(
      calls.find((call) => call.method === 'session.create').params.systemMessage.sections
    ).toEqual({ environment_context: { action: 'remove' } });
    expect(calls.find((call) => call.method === 'session.create').params.systemMessage.mode).toBe(
      'customize'
    );
    expect(
      calls.find((call) => call.method === 'session.create').params.systemMessage.content
    ).toContain('HYPERNEO_WORKTREES');
  });

  test('explains strict steering refusal without sending or starting a runtime', () => {
    const { adapter, run } = setup();
    expect(adapter.capabilities).not.toContain('steer');
    const result = pickRoute('steer', { adapter: adapter.id }, [adapter]);
    expect(result).toMatchObject({
      reason: { ok: false, reason: 'unsupported', detail: expect.stringContaining('same-turn') },
    });
    expect(existsSync(join(run, 'calls.jsonl'))).toBe(false);
  });
  test.each(['settled', 'error', 'late-settled'])(
    'reaps %s runtime without a status or stop call',
    async (message) => {
      const fixture = setup();
      const work = await start(fixture, message);
      const pid = JSON.parse(
        readFileSync(join(fixture.run, 'calls.jsonl'), 'utf8').split('\n')[0]
      ).pid;
      if (message === 'late-settled')
        writeFileSync(join(fixture.run, 'release-settlement'), 'release');
      for (let poll = 0; poll < 200; poll++) {
        try {
          process.kill(pid, 0);
        } catch {
          break;
        }
        await new Promise((done) => setTimeout(done, 5));
      }
      expect(() => process.kill(pid, 0)).toThrow();
      expect(await fixture.adapter.status!(work.ref, undefined, work.receipt)).toMatchObject({
        ok: true,
        value: { status: message === 'error' ? 'failed' : 'done' },
      });
      expect(await fixture.adapter.stop!(work.ref, context)).toEqual({
        ok: true,
        value: { stopped: false },
      });
      expect(readFileSync(join(fixture.run, 'calls.jsonl'), 'utf8')).not.toContain('session.abort');
    }
  );

  test('refuses a file execution folder as invalid_place before spawning a runtime', async () => {
    const fixture = setup();
    const folder = join(fixture.run, 'file');
    writeFileSync(folder, 'not a directory');
    expect(
      await fixture.adapter.start!(
        { ...fixture.request, place: { ...fixture.request.place, folder } },
        context
      )
    ).toMatchObject({ ok: false, reason: 'invalid_place' });
    expect(existsSync(join(fixture.run, 'calls.jsonl'))).toBe(false);
    expect(existsSync(fixture.deps.directory)).toBe(false);
  });

  test('default abort confirmation accepts terminal evidence later than two seconds', async () => {
    const fixture = setup('--delayed-abort', {});
    const work = await start(fixture);
    expect(await fixture.adapter.stop!(work.ref, context)).toEqual({
      ok: true,
      value: { stopped: true },
    });
    expect(await fixture.adapter.status!(work.ref, undefined, work.receipt)).toMatchObject({
      ok: true,
      value: { status: 'stopped' },
    });
  });

  test.each([
    ['settled', '', 'done'],
    ['settled', '--abort-ack-only', 'done'],
    ['error', '', 'failed'],
  ] as const)('stop preserves terminal %s with %s', async (message, flag, outcome) => {
    const fixture = setup(flag);
    const work = await start(fixture, message);
    const before = await fixture.adapter.status!(work.ref, undefined, work.receipt);
    expect(before).toMatchObject({ ok: true, value: { status: outcome } });
    expect(await fixture.adapter.stop!(work.ref, context)).toEqual({
      ok: true,
      value: { stopped: false },
    });
    expect(await fixture.adapter.status!(work.ref, undefined, work.receipt)).toEqual(before);
    expect(readFileSync(join(fixture.run, 'calls.jsonl'), 'utf8')).not.toContain('session.abort');
    await fixture.adapter.close();
    const restarted = createCopilotAdapter(fixture.discovery, fixture.deps);
    owners.push(restarted);
    expect(await restarted.stop!(work.ref, context)).toEqual({
      ok: true,
      value: { stopped: false },
    });
    expect(await restarted.status!(work.ref, undefined, work.receipt)).toEqual(before);
  });

  test('stop refreshes completion that arrived after the saved start snapshot', async () => {
    const fixture = setup();
    const work = await start(fixture, 'late-settled');
    expect(work.status).toBe('running');
    writeFileSync(join(fixture.run, 'release-settlement'), 'release');
    for (let poll = 0; poll < 200 && !existsSync(join(fixture.run, 'settlement-emitted')); poll++)
      await new Promise((done) => setTimeout(done, 5));
    expect(existsSync(join(fixture.run, 'settlement-emitted'))).toBe(true);
    expect(await fixture.adapter.stop!(work.ref, context)).toEqual({
      ok: true,
      value: { stopped: false },
    });
    expect(await fixture.adapter.status!(work.ref, undefined, work.receipt)).toMatchObject({
      ok: true,
      value: { status: 'done', lastReply: 'LATE_COMPLETE_REPLY' },
    });
    expect(readFileSync(join(fixture.run, 'calls.jsonl'), 'utf8')).not.toContain('session.abort');
  });

  test('concurrent status cannot overwrite stopped evidence while its runtime closes', async () => {
    const fixture = setup('--slow-stop');
    const work = await start(fixture);
    const other = await start(fixture, 'hold');
    const stopping = fixture.adapter.stop!(work.ref, context);
    try {
      for (let poll = 0; poll < 200; poll++) {
        if (readFileSync(join(fixture.run, 'calls.jsonl'), 'utf8').includes('runtime.shutdown'))
          break;
        await new Promise((done) => setTimeout(done, 5));
      }
      expect(readFileSync(join(fixture.run, 'calls.jsonl'), 'utf8')).toContain('runtime.shutdown');
      let timer: ReturnType<typeof setTimeout>;
      try {
        const independent = await Promise.race([
          fixture.adapter.status!(other.ref, undefined, other.receipt),
          new Promise<never>((_, fail) => {
            timer = setTimeout(
              () => fail(new Error('unrelated session blocked by shutdown')),
              1000
            );
          }),
        ]);
        expect(independent).toMatchObject({ ok: true, value: { status: 'running' } });
      } finally {
        clearTimeout(timer!);
      }
      const reading = fixture.adapter.status!(work.ref, undefined, work.receipt);
      await new Promise((done) => setTimeout(done, 5));
      writeFileSync(join(fixture.run, 'release-shutdown'), 'release');
      expect(await reading).toMatchObject({ ok: true, value: { status: 'stopped' } });
    } finally {
      writeFileSync(join(fixture.run, 'release-shutdown'), 'release');
      await stopping;
    }
    expect(await fixture.adapter.status!(work.ref, undefined, work.receipt)).toMatchObject({
      ok: true,
      value: { status: 'stopped' },
    });
    expect(await fixture.adapter.stop!(work.ref, context)).toEqual({
      ok: true,
      value: { stopped: false },
    });
  });

  test('daemon cleanup drains a stop that already detached its live runtime', async () => {
    const fixture = setup('--slow-stop');
    const work = await start(fixture);
    const stopping = fixture.adapter.stop!(work.ref, context);
    let closing: Promise<void> | undefined;
    try {
      for (let poll = 0; poll < 200; poll++) {
        if (readFileSync(join(fixture.run, 'calls.jsonl'), 'utf8').includes('runtime.shutdown'))
          break;
        await new Promise((done) => setTimeout(done, 5));
      }
      expect(readFileSync(join(fixture.run, 'calls.jsonl'), 'utf8')).toContain('runtime.shutdown');
      let closed = false;
      closing = fixture.adapter.close().then(() => {
        closed = true;
      });
      await new Promise((done) => setTimeout(done, 5));
      expect(closed).toBe(false);
    } finally {
      writeFileSync(join(fixture.run, 'release-shutdown'), 'release');
      await Promise.all([stopping, closing]);
    }
    expect(await fixture.adapter.status!(work.ref, undefined, work.receipt)).toMatchObject({
      ok: true,
      value: { status: 'stopped' },
    });
  });

  test.each([
    ['settled', 'done'],
    ['error', 'failed'],
  ] as const)(
    'retains %s terminal evidence after its runtime is reaped',
    async (message, outcome) => {
      const fixture = setup();
      const work = await start(fixture, message);
      const before = await fixture.adapter.status!(work.ref, undefined, work.receipt);
      expect(before).toMatchObject({ ok: true, value: { status: outcome } });
      const pid = JSON.parse(
        readFileSync(join(fixture.run, 'calls.jsonl'), 'utf8').split('\n')[0]
      ).pid;
      for (let poll = 0; poll < 100; poll++) {
        try {
          process.kill(pid, 0);
        } catch {
          break;
        }
        await new Promise((done) => setTimeout(done, 10));
      }
      expect(() => process.kill(pid, 0)).toThrow();
      expect(await fixture.adapter.status!(work.ref, undefined, work.receipt)).toEqual(before);
      expect(await fixture.adapter.status!(work.ref, undefined, work.receipt)).toEqual(before);
      await fixture.adapter.close();
      const restarted = createCopilotAdapter(fixture.discovery, fixture.deps);
      owners.push(restarted);
      expect(await restarted.status!(work.ref, undefined, work.receipt)).toEqual(before);
    }
  );

  test('disconnect after first ACK preserves identity and cannot report queued success', async () => {
    const fixture = setup('--crash-on-ping');
    const result = await fixture.adapter.start!(fixture.request, context);
    expect(result).toMatchObject({ ok: false, reason: 'unreachable' });
    expect(JSON.stringify(result)).toMatch(/copilot-cli:[0-9a-f-]{36}/);
    expect(
      readFileSync(join(fixture.run, 'calls.jsonl'), 'utf8').match(/"method":"session.send"/g)
    ).toHaveLength(1);
  });

  test('start returns a receipt; status uses its actual reply and owned execution directory', async () => {
    const fixture = setup();
    expect(fixture.adapter.capabilities).toEqual([
      'find',
      'start',
      'rename',
      'send',
      'queue',
      'status',
      'stop',
    ]);
    const work = await start(fixture, 'settled');
    const detail = await fixture.adapter.status!(work.ref, undefined, work.receipt);
    expect(detail).toMatchObject({
      ok: true,
      value: {
        status: 'done',
        title: 'Synthetic work',
        model: 'synthetic-model',
        execution: { directory: realpathSync(fixture.run) },
        inputEvidence: { state: 'observed', replyReport: 'REPLY_1', replyAvailability: 'complete' },
      },
    });
    expect(work.link).toBeUndefined();
    expect(work.watchHint).toContain('work.status');
    const calls = readFileSync(join(fixture.run, 'calls.jsonl'), 'utf8');
    expect(calls).toContain('"availableTools":[]');
    expect(calls).toContain('"mode":"enqueue"');
  });

  test('permission denial stays needs_you with incomplete evidence', async () => {
    const fixture = setup();
    const work = await start(fixture, 'permission');
    expect(await fixture.adapter.status!(work.ref, undefined, work.receipt)).toMatchObject({
      ok: true,
      value: { status: 'needs_you', inputEvidence: { replyAvailability: 'incomplete' } },
    });
  });

  test('stop waits for abort evidence, closes the owned runtime, and remains stopped', async () => {
    const fixture = setup('--idle-after-abort');
    const work = await start(fixture);
    expect(await fixture.adapter.stop!(work.ref, context)).toEqual({
      ok: true,
      value: { stopped: true },
    });
    expect(await fixture.adapter.status!(work.ref)).toMatchObject({
      ok: true,
      value: { status: 'stopped' },
    });
    const calls = readFileSync(join(fixture.run, 'calls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(calls.filter((call) => call.method === 'session.abort')).toHaveLength(1);
    expect(() => process.kill(calls[0].pid, 0)).toThrow();
    expect(
      await fixture.adapter.stop!({ adapter: 'copilot-cli', id: crypto.randomUUID() }, context)
    ).toMatchObject({ ok: false, reason: 'not_found' });
  });

  test('an abort ACK alone cannot report stopped, but closes its owned process', async () => {
    const fixture = setup('--abort-ack-only');
    const work = await start(fixture);
    expect(await fixture.adapter.stop!(work.ref, context)).toMatchObject({
      ok: false,
      reason: 'unreachable',
    });
    expect(await fixture.adapter.status!(work.ref)).toMatchObject({
      ok: false,
      reason: 'unreachable',
    });
  });

  test('restart retains ownership identity without replaying or taking external sessions', async () => {
    const fixture = setup();
    const work = await start(fixture);
    await fixture.adapter.close();
    const restarted = createCopilotAdapter(fixture.discovery, fixture.deps);
    owners.push(restarted);
    expect(await restarted.status!(work.ref, undefined, work.receipt)).toMatchObject({
      ok: false,
      reason: 'unreachable',
    });
    expect(await restarted.stop!(work.ref, context)).toMatchObject({
      ok: false,
      reason: 'unreachable',
    });
    expect(
      await restarted.status!({ adapter: 'copilot-cli', id: crypto.randomUUID() })
    ).toMatchObject({ ok: false, reason: 'not_found' });
    expect(await restarted.status!({ adapter: 'copilot-cli', id: '../escape' })).toMatchObject({
      ok: false,
      reason: 'not_found',
    });
    expect(
      readFileSync(join(fixture.run, 'calls.jsonl'), 'utf8').match(/"method":"session.send"/g)
    ).toHaveLength(1);
  });

  test('foreign receipts never get an unrelated reply', async () => {
    const fixture = setup();
    const work = await start(fixture, 'settled');
    const unknown = await fixture.adapter.status!(work.ref, undefined, {
      executionId: 'foreign',
      inputId: work.receipt!.inputId,
    });
    expect(unknown).toMatchObject({ ok: false, reason: 'not_found' });
  });

  test.each([
    ['effort', { effort: 'high' }, 'unsupported_effort'],
    ['missing model', { model: undefined }, 'unsupported_model'],
    ['unknown model', { model: 'unknown' }, 'unsupported_model'],
    [
      'remote folder',
      { place: { machine: 'elsewhere', folder: '/', name: 'remote' } },
      'invalid_place',
    ],
    [
      'unregistered preparation',
      { preparation: { pack: 'unknown', parameters: {} } },
      'unsupported_preparation',
    ],
  ] as const)('refuses %s without sending', async (_label, patch, reason) => {
    const fixture = setup();
    expect(await fixture.adapter.start!({ ...fixture.request, ...patch }, context)).toMatchObject({
      ok: false,
      reason,
    });
    expect(
      existsSync(join(fixture.run, 'calls.jsonl'))
        ? readFileSync(join(fixture.run, 'calls.jsonl'), 'utf8')
        : ''
    ).not.toContain('session.send');
  });

  test('a lost first ACK preserves identity and refuses automatic replay', async () => {
    const fixture = setup();
    const failure = await fixture.adapter.start!(
      { ...fixture.request, message: 'lost-ack' },
      context
    );
    expect(failure).toMatchObject({ ok: false, reason: 'unreachable' });
    expect(JSON.stringify(failure)).toMatch(/copilot-cli:[0-9a-f-]{36}/);
    expect(
      readFileSync(join(fixture.run, 'calls.jsonl'), 'utf8').match(/"method":"session.send"/g)
    ).toHaveLength(1);
  });
});
