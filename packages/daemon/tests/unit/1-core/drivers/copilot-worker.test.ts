import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CopilotClient } from '@github/copilot-sdk';
import { vi } from 'vitest';
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
  test('ignores evicted stale echoes during ACK wait without losing replies or capacity', async () => {
    const worker = await openCopilotWorker(config());
    try {
      for (let index = 0; index < 270; index++) await worker.submit('settled');
      const receipt = await worker.submit('stale-echo');
      const state = await worker.snapshot();
      expect(state.status).toBe('done');
      expect(state.inputs[receipt.inputId]).toMatchObject({
        replyReport: 'STALE_SAFE_REPLY',
        outcome: 'done',
      });
      for (let index = 0; index < 64; index++) await worker.submit('queued');
      expect(
        Object.values((await worker.snapshot()).inputs).filter((input) => !input.outcome)
      ).toHaveLength(64);
    } finally {
      await worker.close();
    }
  });

  test('construction preserves its primary error when both shutdown methods reject', async () => {
    let client: CopilotClient | undefined;
    const shutdownError = new Error('forced shutdown failed');
    vi.spyOn(CopilotClient.prototype, 'stop').mockImplementation(async function (
      this: CopilotClient
    ) {
      client = this;
      throw new Error('graceful shutdown failed');
    });
    vi.spyOn(CopilotClient.prototype, 'forceStop').mockRejectedValue(shutdownError);
    try {
      await expect(openCopilotWorker(config('unsupported-version'))).rejects.toMatchObject({
        message: 'Unsupported Copilot worker runtime version',
        cause: shutdownError,
      });
    } finally {
      vi.restoreAllMocks();
      await client?.forceStop();
    }
  });

  test('fails closed rather than retaining more than 512 pre-ACK events', async () => {
    const worker = await openCopilotWorker(config());
    try {
      await expect(worker.submit('ack-pressure')).rejects.toThrow('disconnected');
      expect((await worker.snapshot()).status).toBe('unreachable');
    } finally {
      await worker.close();
    }
  });

  test('overlapping sends bind both receipts before replaying early events', async () => {
    const worker = await openCopilotWorker(config());
    try {
      const [first, second] = await Promise.all([
        worker.submit('late-ack'),
        worker.submit('settled'),
      ]);
      const state = await worker.snapshot();
      expect(state.status).toBe('done');
      expect(state.inputs[first.inputId].replyReport).toBe('REPLY_1');
      expect(state.inputs[second.inputId].replyReport).toBe('REPLY_2');
    } finally {
      await worker.close();
    }
  });

  test('a denied child-agent permission remains visible as needs_you', async () => {
    const worker = await openCopilotWorker(config());
    try {
      await worker.submit('permission-agent');
      expect((await worker.snapshot()).status).toBe('needs_you');
    } finally {
      await worker.close();
    }
  });

  test('an idle before any submitted work preserves queued status', async () => {
    const worker = await openCopilotWorker(config('fixture-1', '--initial-idle'));
    try {
      expect((await worker.snapshot()).status).toBe('queued');
    } finally {
      await worker.close();
    }
  });

  test('retains 64 recent completions without discarding unsettled work', async () => {
    const worker = await openCopilotWorker(config());
    try {
      const pending = await worker.submit('hold');
      const first = await worker.submit('settled');
      let latest = first;
      for (let index = 0; index < 270; index++) latest = await worker.submit('settled');
      const state = await worker.snapshot();
      expect(Object.keys(state.inputs)).toHaveLength(65);
      expect(state.inputs[first.inputId]).toBeUndefined();
      expect(state.inputs[pending.inputId].replyAvailability).toBe('incomplete');
      expect(state.inputs[latest.inputId]).toMatchObject({
        outcome: 'done',
        replyAvailability: 'complete',
        replyReport: 'REPLY_272',
      });
      await worker.submit('finish');
      expect((await worker.snapshot()).inputs[pending.inputId]).toMatchObject({
        outcome: 'done',
        replyReport: 'FIRST_REPLY',
      });
    } finally {
      await worker.close();
    }
  });

  test('fails closed when dedup retention would forget an unsettled reply', async () => {
    const worker = await openCopilotWorker(config());
    try {
      await expect(worker.submit('dedup-pressure')).rejects.toThrow('disconnected');
      expect((await worker.snapshot()).status).toBe('unreachable');
      await expect(worker.submit('never replay')).rejects.toThrow('disconnected');
    } finally {
      await worker.close();
    }
  });

  test('refuses more than 64 unsettled inputs without dropping their receipts', async () => {
    const worker = await openCopilotWorker(config());
    try {
      for (let index = 0; index < 64; index++) await worker.submit('queued');
      await expect(worker.submit('queued')).rejects.toThrow('unsettled');
      const state = await worker.snapshot();
      expect(Object.keys(state.inputs)).toHaveLength(64);
      expect(state.status).toBe('queued');
    } finally {
      await worker.close();
    }
  });

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

  for (const prompt of ['queued', 'hold'])
    test(`refuses ${prompt} follow-up while permission-blocked without sending it`, async () => {
      const cfg = config();
      const worker = await openCopilotWorker(cfg);
      try {
        const receipt = await worker.submit('permission');
        expect((await worker.snapshot()).status).toBe('needs_you');
        await expect(worker.submit(prompt)).rejects.toThrow('permission');
        const state = await worker.snapshot();
        expect(state.status).toBe('needs_you');
        expect(Object.keys(state.inputs)).toEqual([receipt.inputId]);
        expect(state.inputs[receipt.inputId].replyAvailability).toBe('incomplete');
        const calls = readFileSync(join(cfg.cwd, 'calls.jsonl'), 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        expect(calls.filter((call) => call.method === 'session.send')).toHaveLength(1);
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

  test('normal idle after abort preserves stopped until an explicit new submission', async () => {
    const worker = await openCopilotWorker(config('fixture-1', '--idle-after-abort'));
    try {
      const receipt = await worker.submit('hold');
      const queued = await worker.submit('queued');
      await worker.abort();
      await eventually(
        () => worker.snapshot(),
        (v) => (v as { status: string }).status === 'stopped'
      );
      const state = await worker.snapshot();
      expect(state.status).toBe('stopped');
      expect(state.inputs[receipt.inputId].outcome).toBe('stopped');
      expect(state.inputs[queued.inputId]).toMatchObject({
        outcome: 'stopped',
        state: 'pending',
        replyAvailability: 'incomplete',
      });
      await worker.submit('settled');
      expect((await worker.snapshot()).status).toBe('done');
    } finally {
      await worker.close();
    }
  });

  for (const prompt of ['permission', 'error'])
    test(`a late repeated user echo preserves ${prompt} status and the original interaction`, async () => {
      const worker = await openCopilotWorker(config('fixture-1', '--late-user-echo'));
      try {
        const receipt = await worker.submit(prompt);
        const state = await worker.snapshot();
        expect(state.status).toBe(prompt === 'permission' ? 'needs_you' : 'failed');
        expect(state.inputs[receipt.inputId].interactionId).toBe('interaction-1');
      } finally {
        await worker.close();
      }
    });

  test('a repeated user message cannot orphan an in-flight reply', async () => {
    const worker = await openCopilotWorker(config('fixture-1', '--late-user-echo'));
    try {
      const receipt = await worker.submit('hold');
      await worker.submit('finish');
      const state = await worker.snapshot();
      expect(state.inputs[receipt.inputId]).toMatchObject({
        interactionId: 'interaction-1',
        replyReport: 'FIRST_REPLY',
        outcome: 'done',
      });
      expect(state.status).toBe('done');
    } finally {
      await worker.close();
    }
  });

  test('a permission request during an unconsumed send survives its ACK', async () => {
    const worker = await openCopilotWorker(config());
    try {
      const receipt = await worker.submit('permission-queued');
      const state = await worker.snapshot();
      expect(state.status).toBe('needs_you');
      expect(state.inputs[receipt.inputId].state).toBe('pending');
    } finally {
      await worker.close();
    }
  });

  for (const terminal of ['abort', 'error'])
    test(`${terminal} settles queued receipts and releases their admission capacity`, async () => {
      const worker = await openCopilotWorker(config());
      try {
        const queued = [];
        for (let index = 0; index < 63; index++) queued.push(await worker.submit('queued'));
        if (terminal === 'abort') {
          await worker.submit('hold');
          await worker.abort();
          await eventually(
            () => worker.snapshot(),
            (v) => (v as { status: string }).status === 'stopped'
          );
        } else await worker.submit('error');
        const state = await worker.snapshot();
        for (const receipt of queued)
          expect(state.inputs[receipt.inputId]).toMatchObject({
            state: 'pending',
            outcome: terminal === 'abort' ? 'stopped' : 'failed',
            replyAvailability: 'incomplete',
          });
        await worker.submit('settled');
        expect((await worker.snapshot()).status).toBe('done');
        expect(Object.keys((await worker.snapshot()).inputs)).toHaveLength(64);
      } finally {
        await worker.close();
      }
    });

  for (const terminal of ['abort', 'error'])
    test(`${terminal} before an unconsumed input ACK settles that receipt too`, async () => {
      const worker = await openCopilotWorker(config());
      try {
        const receipt = await worker.submit(`${terminal}-queued`);
        const state = await worker.snapshot();
        expect(state.inputs[receipt.inputId]).toMatchObject({
          state: 'pending',
          outcome: terminal === 'abort' ? 'stopped' : 'failed',
          replyAvailability: 'incomplete',
        });
        await worker.submit('settled');
        expect((await worker.snapshot()).status).toBe('done');
      } finally {
        await worker.close();
      }
    });

  test('abort ACK alone does not retire a queued input', async () => {
    const worker = await openCopilotWorker(config('fixture-1', '--abort-ack-only'));
    try {
      const receipt = await worker.submit('queued');
      await worker.abort();
      const state = await worker.snapshot();
      expect(state.status).toBe('queued');
      expect(state.inputs[receipt.inputId]).toMatchObject({
        state: 'pending',
        replyAvailability: 'incomplete',
      });
      expect(state.inputs[receipt.inputId].outcome).toBeUndefined();
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
