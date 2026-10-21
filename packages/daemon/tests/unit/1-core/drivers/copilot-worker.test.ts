import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openCopilotWorker } from '../../../../src/lib/drivers/copilot-worker';

const runs: string[] = [];
afterEach(() => {
  for (const run of runs.splice(0)) rmSync(run, { recursive: true, force: true });
});
function config(version = 'fixture-1', flag = '') {
  const run = mkdtempSync(join(tmpdir(), 'copilot-owner-'));
  runs.push(run);
  const home = join(run, 'home');
  mkdirSync(home);
  const cliPath = join(run, 'copilot');
  const fixture = fileURLToPath(new URL('../../../fixtures/copilot-sdk.ts', import.meta.url));
  writeFileSync(
    cliPath,
    `#!/usr/bin/env bun\nprocess.argv.push(${JSON.stringify(flag)}); await import(${JSON.stringify(fixture)});\n`,
    {
      mode: 0o700,
    }
  );
  return {
    cliPath,
    expectedVersion: version,
    sessionId: '11111111-1111-4111-8111-111111111111',
    cwd: run,
    stateDirectory: join(home, '.copilot'),
    model: 'synthetic-model',
    env: { HOME: home, PATH: process.env.PATH ?? '', ANTHROPIC_API_KEY: 'must-not-reach-child' },
    timeoutMs: 1500,
  };
}

async function eventually(read: () => Promise<unknown>, matches: (value: unknown) => boolean) {
  const until = Date.now() + 1500;
  let value: unknown;
  do {
    value = await read();
    if (matches(value)) return value;
    await new Promise((done) => setTimeout(done, 10));
  } while (Date.now() < until);
  throw new Error(`condition not observed: ${JSON.stringify(value)}`);
}

describe('Copilot worker construction', () => {
  test('owns one stdio runtime, binds pre-ACK events, and never settles on turn-end alone', async () => {
    const cfg = config();
    const worker = await openCopilotWorker(cfg);
    try {
      const receipt = await worker.submit('hold');
      expect(receipt).toEqual({ executionId: cfg.sessionId, inputId: 'input-1' });
      const held = await worker.snapshot();
      expect(held.status).toBe('running');
      expect(held.inputs[receipt.inputId]).toMatchObject({
        state: 'observed',
        replyAvailability: 'incomplete',
      });
      await worker.submit('finish');
      const complete = (await eventually(
        () => worker.snapshot(),
        (value) => (value as typeof held).status === 'done'
      )) as typeof held;
      expect(complete.inputs[receipt.inputId]).toMatchObject({
        replyReport: 'FIRST_REPLY',
        replyAvailability: 'complete',
      });
      expect(JSON.stringify(complete)).not.toContain('UNRELATED');
      await worker.submit('late');
      expect((await worker.snapshot()).inputs[receipt.inputId].replyReport).toBe('FIRST_REPLY');
      const before = JSON.stringify(await worker.snapshot());
      complete.inputs[receipt.inputId].replyReport = 'mutated';
      expect(JSON.stringify(await worker.snapshot())).toBe(before);
    } finally {
      await Promise.all([worker.close(), worker.close()]);
    }
    const calls = readFileSync(join(cfg.cwd, 'calls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(calls.filter((c) => c.method === 'session.create')).toHaveLength(1);
    expect(calls.some((c) => c.method === 'runtime.shutdown')).toBe(true);
    expect(calls.find((c) => c.method === 'session.create').params).toMatchObject({
      sessionId: cfg.sessionId,
      model: cfg.model,
      availableTools: [],
    });
    expect(calls[0].secretPresent).toBe(false);
  });

  test('accepted but unconsumed input and missing final reply stay incomplete', async () => {
    const worker = await openCopilotWorker(config());
    try {
      const queued = await worker.submit('queued');
      expect((await worker.snapshot()).inputs[queued.inputId]).toMatchObject({
        state: 'pending',
        replyAvailability: 'incomplete',
      });
      const blank = await worker.submit('empty');
      const state = await worker.snapshot();
      expect(state.inputs[blank.inputId]).toMatchObject({
        state: 'observed',
        replyAvailability: 'incomplete',
      });
      expect(state.status).not.toBe('done');
      const hostile = await worker.submit('hostile');
      expect(Object.hasOwn((await worker.snapshot()).inputs, hostile.inputId)).toBe(true);
    } finally {
      await worker.close();
    }
  });

  test('abort ACK is not completion; terminal abort and EOF preserve conservative evidence', async () => {
    const worker = await openCopilotWorker(config());
    try {
      const receipt = await worker.submit('hold');
      await worker.abort();
      const stopped = (await eventually(
        () => worker.snapshot(),
        (v) => (v as { status: string }).status === 'stopped'
      )) as Awaited<ReturnType<typeof worker.snapshot>>;
      expect(stopped.inputs[receipt.inputId].replyAvailability).toBe('incomplete');
      await worker.submit('crash');
      await eventually(
        () => worker.snapshot(),
        (v) => (v as { status: string }).status === 'unreachable'
      );
      await expect(worker.submit('never retry')).rejects.toThrow();
    } finally {
      await worker.close();
    }
  });

  test('rejects runtime version drift and releases its process without a session', async () => {
    const cfg = config('unsupported-version');
    await expect(openCopilotWorker(cfg)).rejects.toThrow('version');
    const calls = readFileSync(join(cfg.cwd, 'calls.jsonl'), 'utf8');
    expect(calls).not.toContain('session.create');
    expect(calls).toContain('runtime.shutdown');
  });
  test('denies permissions without letting later idle hide the blocked state', async () => {
    const cfg = config();
    const worker = await openCopilotWorker(cfg);
    try {
      await worker.submit('permission');
      await eventually(
        () => worker.snapshot(),
        (v) => (v as { status: string }).status === 'needs_you'
      );
      const calls = readFileSync(join(cfg.cwd, 'calls.jsonl'), 'utf8');
      expect(calls).toContain('"kind":"reject"');
    } finally {
      await worker.close();
    }
  });

  test('a session error followed by idle is failed, not successful completion', async () => {
    const worker = await openCopilotWorker(config());
    try {
      const receipt = await worker.submit('error');
      const state = await worker.snapshot();
      expect(state.status).toBe('failed');
      expect(state.inputs[receipt.inputId].replyAvailability).toBe('incomplete');
    } finally {
      await worker.close();
    }
  });

  test('rejects protocol drift and bounds shutdown of an unresponsive owned process', async () => {
    await expect(openCopilotWorker(config('fixture-1', '--bad-protocol'))).rejects.toThrow(
      'protocol'
    );
    const cfg = config('fixture-1', '--hang-stop');
    const worker = await openCopilotWorker(cfg);
    await worker.close();
    const first = JSON.parse(readFileSync(join(cfg.cwd, 'calls.jsonl'), 'utf8').split('\n')[0]);
    await eventually(async () => {
      try {
        process.kill(first.pid, 0);
        return false;
      } catch {
        return true;
      }
    }, Boolean);
    await expect(worker.submit('after close')).rejects.toThrow('disconnected');
  });
  test('an accepted input whose ACK is lost is never automatically replayed', async () => {
    const cfg = config();
    const worker = await openCopilotWorker(cfg);
    try {
      await expect(worker.submit('lost-ack')).rejects.toThrow('timeout');
      expect((await worker.snapshot()).status).toBe('unreachable');
      await expect(worker.submit('retry')).rejects.toThrow('disconnected');
      const calls = readFileSync(join(cfg.cwd, 'calls.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(calls.filter((c) => c.method === 'session.send')).toHaveLength(1);
    } finally {
      await worker.close();
    }
  });
});
