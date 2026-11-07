import { createPushedWorkerRepo } from '../../../helpers/native-worker-worktree';
import { spawnSync } from 'node:child_process';
import { spawnProcess } from '../../../../src/lib/runtime-spawn/index';

import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createTables, runMigrations } from '../../../../src/storage/schema/index';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository';
import { createNeoTodoRunner } from '../../../../src/lib/neo/todo-runner';
import { gatewayFor } from '../../../../src/storage/db-gateway/db-gateway';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  appendFileSync,
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
import { createOperationRegistry } from '../../../../src/lib/operations/registry';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import { createWorkVerbOperations, pickRoute } from '../../../../src/lib/drivers/work-operations';
import { createCopilotAdapter } from '../../../../src/lib/drivers/copilot-adapter';
import type { StartRequest, WorkCallContext } from '../../../../src/lib/drivers/types';

const STALL_TIMEOUT_MS = 4000;

const runs: string[] = [];
const owners: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.close();
  for (const run of runs.splice(0)) rmSync(run, { recursive: true, force: true });
});
const context = { from: 'chat', caller: { source: 'rpc' } } as WorkCallContext;
function setup(flag = '', options: { timeoutMs?: number } = {}) {
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
    resolveCliPath: async () => cliPath,
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
  test('starts a new repository before its first commit in the project folder', async () => {
    const f = setup();
    const folder = join(f.run, 'unborn');
    expect(spawnSync('git', ['init', '--initial-branch=dev', folder]).status).toBe(0);
    const repo = realpathSync(folder);
    const adapter = createCopilotAdapter(f.discovery, {
      ...f.deps,
      worktreesDir: join(f.run, 'worktrees'),
      gitCheckout: async () => ({ repo, linked: false }),
      spawn: spawnProcess,
    });
    owners.push(adapter);
    const result = await adapter.start!(
      { ...f.request, place: { machine: 'test', folder: repo, name: 'new repo' } },
      context
    );
    expect(result).toMatchObject({ ok: true, value: { execution: { directory: repo } } });
    expect(existsSync(join(repo, '.git'))).toBe(true);
  });

  test('starts a coding worker in its own native worktree and reports the project separately', async () => {
    const f = setup();
    const { repo } = createPushedWorkerRepo(f.run);
    const adapter = createCopilotAdapter(f.discovery, {
      ...f.deps,
      worktreesDir: join(f.run, 'worktrees'),
      gitCheckout: async () => ({ repo, linked: false }),
      spawn: spawnProcess,
    });
    owners.push(adapter);
    const result = await adapter.start!(
      { ...f.request, place: { machine: 'test', folder: repo, name: 'repo' } },
      context
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        place: { folder: repo },
        execution: { machine: 'test', directory: expect.stringContaining('/worktrees/') },
      },
    });
    if (!result.ok) throw new Error(JSON.stringify(result));
    const folder = result.value.execution!.directory;
    expect(folder).not.toBe(repo);
    expect(existsSync(join(folder, '.git'))).toBe(true);
    const created = readFileSync(join(folder, 'calls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((call) => call.method === 'session.create');
    expect(created.params.workingDirectory).toBe(folder);
    expect(created.params.systemMessage.content).toContain(`Worktree: ${folder}`);
    expect(
      spawnSync('git', ['-C', folder, 'rev-parse', '--git-common-dir'], {
        encoding: 'utf8',
      }).stdout.trim()
    ).toBe(join(realpathSync(repo), '.git'));
    await adapter.stop!(result.value.ref, context);
    expect(await adapter.archive!(result.value.ref, () => null)).toMatchObject({
      ok: true,
      value: {
        archived: true,
        worktree: { directory: folder, removed: false, reason: expect.stringContaining('changes') },
      },
    });
    expect(existsSync(folder)).toBe(true);
    expect(spawnSync('git', ['-C', folder, 'clean', '-fd']).status).toBe(0);
    expect(await adapter.archive!(result.value.ref, () => null)).toMatchObject({
      ok: true,
      value: { archived: false, worktree: { directory: folder, removed: true } },
    });
    expect(existsSync(folder)).toBe(false);
  });

  test.each([
    [true, 'settled', 0, 0],
    [true, 'error', 0, 0],
    [true, 'abort-queued', 0, 0],
    [false, 'settled', 0, 0],
    [true, 'settled', 60, 0],
    [true, 'settled', 0, 60],
  ] as const)('reports human=%s %s (%s before/%s after)', async (human, prior, earlier, later) => {
    const fixture = setup();
    const since = Date.now() - 1;
    const work = await start(fixture, prior);
    const at = Date.now() + 100;
    if (human) {
      const history = join(
        fixture.deps.directory,
        work.ref.id,
        'session-state',
        work.ref.id,
        'events.jsonl'
      );
      const events = [
        ...Array.from({ length: earlier }, (_, index) => ({
          type: 'user.message',
          data: {
            messageId: `earlier-${index}`,
            interactionId: `earlier-turn-${index}`,
            content: `Earlier note ${index}`,
          },
        })),
        {
          type: 'user.message',
          data: {
            messageId: 'human-direct',
            interactionId: 'human-turn',
            content: 'Change the summary directly.',
          },
        },
        ...Array.from({ length: later }, (_, index) => ({
          type: 'user.message',
          data: {
            messageId: `later-${index}`,
            interactionId: `later-turn-${index}`,
            content: `Later note ${index}`,
          },
        })),
        {
          type: 'assistant.message',
          data: {
            messageId: 'human-reply',
            interactionId: 'human-turn',
            content: 'Changed the summary.',
            phase: 'final_answer',
          },
        },
        { type: 'session.idle', data: {} },
      ];
      appendFileSync(
        history,
        events
          .map((event, index) =>
            JSON.stringify({
              ...event,
              id: `human-${index}`,
              timestamp: new Date(at + index).toISOString(),
            })
          )
          .join('\n') + '\n'
      );
    }
    const detail = await fixture.adapter.status!(work.ref, since, work.receipt);
    expect(detail.ok).toBe(true);
    if (!detail.ok) throw new Error(detail.reason);
    expect(detail.value.recentInputs).toContainEqual(
      expect.objectContaining(
        human
          ? {
              inputId: 'human-direct',
              at: at + earlier,
              text: 'Change the summary directly.',
              human: true,
            }
          : { inputId: work.receipt!.inputId, text: 'settled', human: false }
      )
    );
    if (earlier) {
      expect(detail.value.recentInputs).toHaveLength(50);
      expect(detail.value.recentInputs?.at(-1)?.inputId).toBe('human-direct');
      const recent = await fixture.adapter.status!(work.ref);
      expect(recent.ok && recent.value.recentInputs).toHaveLength(8);
      expect(recent.ok && recent.value.recentInputs?.at(-1)?.inputId).toBe('human-direct');
    }
    if (later) {
      expect(detail.value.recentInputs).toHaveLength(50);
      expect(detail.value.recentInputs?.at(-1)?.inputId).toBe('later-59');
    }
    const db = new Database(':memory:');
    try {
      runMigrations(db, () => {});
      createTables(db);
      new JobQueueRepository(db).commitSubmissionReceipt(
        'neo-turn-report:v2:cutoff',
        'v2',
        () => 0
      );
      const store = new NeoAskTodoRepository(db);
      const sessions = new NeoTodoSessionRepository(db);
      store.openAsk({
        id: 'copilot-matter',
        sessionId: 'neo',
        title: 'Summary matter',
        request: 'Observe direct work',
        projectId: null,
        originMessageId: null,
        createdAt: since,
      });
      const todo = store.addTodo(
        'copilot-todo',
        'copilot-matter',
        { title: 'Summary', doneWhen: 'Recorded', instruction: null, check: null, named: null },
        since
      );
      sessions.create(todo.id, { verb: 'adopt', ref: work.ref });
      sessions.recordRef(todo.id, work.ref, since);
      sessions.recordFollowAnchor(todo.id, since);
      store.updateTodo(todo, { state: human ? 'done' : 'doing', startedAt: since }, since);
      if (!human) {
        const dispatch = await sessions.inputs.accept(
          todo.id,
          'neo',
          { verb: 'send', ref: work.ref },
          'settled',
          since
        );
        await sessions.inputs.recordOutcome(
          dispatch,
          { ref: work.ref, receipt: work.receipt },
          since
        );
      }
      const told: string[] = [];
      const runner = createNeoTodoRunner({
        store,
        sessions,
        write: gatewayFor(db).run.bind(gatewayFor(db)),
        packs: () => [],
        limits: () => ({ running: 99, perGroup: 99 }),
        changed: () => {},
        invoke: async (_caller, name, input) => {
          expect(name).toBe('work.status');
          return {
            kind: 'completed',
            value: await fixture.adapter.status!(
              work.ref,
              input.since as number | undefined,
              work.receipt
            ),
          };
        },
        tell: async (_ask, _todo, note) => {
          told.push(note);
        },
      });
      await runner.refresh(() => {});
      await runner.refresh(() => {});
      const reports = told.filter((note) =>
        note.startsWith(human ? 'The human worked directly' : 'Worker turn report')
      );
      expect(reports).toHaveLength(1);
      expect(reports[0]).toContain(
        human ? 'The human said: Change the summary directly.' : 'dispatch'
      );
      expect(reports[0]).toContain(human ? 'The worker replied: Changed the summary.' : 'REPLY_1');
      expect(
        told.filter((note) =>
          note.startsWith(human ? 'Worker turn report' : 'The human worked directly')
        )
      ).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test('retains legacy daemon attribution from history without resuming the owner', async () => {
    const fixture = setup();
    const since = Date.now() - 1;
    const work = await start(fixture, 'settled');
    await fixture.adapter.close();
    const recordPath = join(fixture.deps.directory, `${work.ref.id}.json`);
    const record = JSON.parse(readFileSync(recordPath, 'utf8'));
    for (const input of Object.values(record.snapshot.inputs) as Array<{
      at?: number;
      text?: string;
      human?: boolean;
      endedAt?: number;
    }>) {
      delete input.at;
      delete input.text;
      delete input.human;
      delete input.endedAt;
    }
    writeFileSync(recordPath, JSON.stringify(record));
    const restarted = createCopilotAdapter(fixture.discovery, fixture.deps);
    owners.push(restarted);
    const detail = await restarted.status!(work.ref, since);
    expect(detail).toMatchObject({
      ok: true,
      value: {
        recentInputs: [
          expect.objectContaining({
            inputId: work.receipt!.inputId,
            text: 'settled',
            human: false,
          }),
        ],
        turnEnds: [expect.objectContaining({ id: work.receipt!.inputId, message: 'REPLY_1' })],
      },
    });
    expect(readFileSync(join(fixture.run, 'calls.jsonl'), 'utf8')).not.toContain('session.resume');
  });

  test('does not invent completion from commentary, child replies or a partial tail', async () => {
    const fixture = setup();
    const work = await start(fixture, 'settled');
    const at = Date.now() + 100;
    const history = join(
      fixture.deps.directory,
      work.ref.id,
      'session-state',
      work.ref.id,
      'events.jsonl'
    );
    appendFileSync(
      history,
      [
        {
          type: 'user.message',
          data: {
            messageId: 'unfinished-human',
            interactionId: 'new-human',
            content: 'Pending direct work',
          },
        },
        {
          type: 'assistant.message',
          data: {
            messageId: 'comment',
            interactionId: 'new-human',
            content: 'Commentary',
            phase: 'commentary',
          },
        },
        {
          type: 'assistant.message',
          agentId: 'child',
          data: {
            messageId: 'child-reply',
            interactionId: 'new-human',
            content: 'Child final',
            phase: 'final_answer',
          },
        },
      ]
        .map((event, index) =>
          JSON.stringify({
            ...event,
            id: `incomplete-${index}`,
            timestamp: new Date(at + index).toISOString(),
          })
        )
        .join('\n') + '\n{"type":"session.idle"'
    );
    const detail = await fixture.adapter.status!(work.ref, at - 1);
    expect(detail).toMatchObject({
      ok: true,
      value: {
        recentInputs: [expect.objectContaining({ inputId: 'unfinished-human', at, human: true })],
        turnEnds: [],
      },
    });
    const after = await fixture.adapter.status!(work.ref, at + 2);
    expect(after).toMatchObject({ ok: true, value: { recentInputs: [], turnEnds: [] } });
  });

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

  test('reuses an idle owned Copilot worker with the same explicit model', async () => {
    const f = setup('--durable-inputs');
    const first = await start(f, 'settled');
    let status = await f.adapter.status!(first.ref);
    for (let i = 0; i < 500 && (!status.ok || status.value.status !== 'done'); i++) {
      await new Promise((done) => setTimeout(done, 20));
      status = await f.adapter.status!(first.ref);
    }
    expect(status).toMatchObject({ ok: true, value: { status: 'done' } });
    const registry = createOperationRegistry(
      createWorkVerbOperations({
        adapters: () => [f.adapter],
        remote: { list: () => [], invoke: async () => ({}) },
        daemonName: 'test',
        freeWorkers: () => new Set([first.ref.id]),
      })
    );
    const result = await invokeOperation(
      registry,
      'work.start',
      { adapter: f.adapter.id, ...f.request, message: 'settled' },
      { source: 'internal', role: 'neo', sessionId: 'neo' }
    );
    if (result.kind !== 'completed' || !(result.value as { ok?: boolean }).ok)
      throw new Error(JSON.stringify(result));
    expect(result).toMatchObject({
      kind: 'completed',
      value: { ok: true, value: { ref: first.ref, reused: true } },
    });
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
      for (let poll = 0; poll < 2000; poll++) {
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
    for (let poll = 0; poll < 2000 && !existsSync(join(fixture.run, 'settlement-emitted')); poll++)
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
      for (let poll = 0; poll < 2000; poll++) {
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
      for (let poll = 0; poll < 2000; poll++) {
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
      for (let poll = 0; poll < 2000; poll++) {
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
      'withdraw',
      'status',
      'stop',
      'archive',
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
    const fixture = setup('--abort-ack-only', { timeoutMs: STALL_TIMEOUT_MS });
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
    const fixture = setup('', { timeoutMs: STALL_TIMEOUT_MS });
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
