import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { vi } from 'vitest';
import * as sandbox from '../../../../src/lib/drivers/worker-sandbox';
import {
  prepareWorkerSandbox,
  releaseWorkerSandbox,
  workerSandboxPaths,
} from '../../../../src/lib/drivers/worker-sandbox';
import { existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  connectCodexAppServer,
  type CodexAppServer,
} from '../../../../src/lib/drivers/codex-app-server';
import {
  admitCodexSteerTurn,
  codexExchange,
  codexInputEvidence,
  codexQueueDelivery,
  codexRecentInputs,
  codexTurnState,
  codexUserInputIds,
  createCodexDesktopAdapter,
} from '../../../../src/lib/drivers/codex-desktop-adapter';
import { WorkDetailSchema } from '../../../../src/lib/drivers/types';
import type { SpawnFn } from '../../../../src/lib/runtime-spawn';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createWorkVerbOperations } from '../../../../src/lib/drivers/work-operations';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import { createOperationRegistry } from '../../../../src/lib/operations/registry';
import {
  configureLogger,
  getLoggerConfig,
  LogLevel,
  subscribeToStructuredLogs,
} from '../../../../src/lib/logger';

const NOW = Date.parse('2026-10-04T12:00:00.000Z');

const line = (type: string, payload: Record<string, unknown>) => JSON.stringify({ type, payload });
const heard = (text: string) =>
  line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const said = (text: string) =>
  line('response_item', {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text }],
  });

const heardAs = (id: string, text: string, at = '2026-10-04T11:00:00.000Z') =>
  JSON.stringify({
    type: 'response_item',
    timestamp: at,
    payload: { type: 'message', role: 'user', id, content: [{ type: 'input_text', text }] },
  });
const saidAt = (text: string, at = '2026-10-04T11:00:05.000Z') =>
  JSON.stringify({
    type: 'response_item',
    timestamp: at,
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
  });

describe('codexQueueDelivery', () => {
  test('a queued message is receipted by the user message id it appended, not an older copy', () => {
    const before = [heardAs('msg_old', 'next step')];
    const after = [...before, saidAt('ok'), heardAs('msg_new', 'next step\nwith detail')];
    expect(
      codexQueueDelivery(
        after,
        'next step\nwith detail',
        't1',
        codexUserInputIds(before),
        'msg_new'
      )
    ).toEqual({
      delivered: true,
      receipt: { executionId: 't1', inputId: 'msg_new' },
    });
    expect(
      codexQueueDelivery(before, 'next step', 't1', codexUserInputIds(before), 'msg_old')
    ).toEqual({
      delivered: false,
    });
    expect(codexQueueDelivery([heard('next step')], 'next step', 't1', new Set(), 'no-id')).toEqual(
      {
        delivered: false,
      }
    );
    expect(
      codexQueueDelivery(after, 'next step\nwith detail', 't1', new Set(), 'other-sender')
    ).toEqual({ delivered: false });
  });
});

describe('codexInputEvidence', () => {
  const receipt = { executionId: 't1', inputId: 'msg_1' };
  const rollout = [
    heardAs('msg_0', 'earlier ask'),
    saidAt('earlier answer'),
    heardAs('msg_1', 'fix the loader'),
    heard('<environment_context>cwd</environment_context>'),
    saidAt('looking'),
    JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-10-04T11:00:09.000Z',
      payload: { type: 'task_complete', last_agent_message: 'Fixed in #12.' },
    }),
    heardAs('msg_2', 'and the parser?'),
    saidAt('next turn'),
  ];

  test('returns the input and its own turn, stopping at the next human input', () => {
    expect(codexInputEvidence(rollout, receipt, 't1')).toEqual({
      receipt,
      state: 'observed',
      exchange: [
        { at: Date.parse('2026-10-04T11:00:00.000Z'), role: 'user', text: 'fix the loader' },
        { at: Date.parse('2026-10-04T11:00:05.000Z'), role: 'agent', text: 'looking' },
        { at: Date.parse('2026-10-04T11:00:09.000Z'), role: 'agent', text: 'Fixed in #12.' },
      ],
      exchangeCut: false,
    });
  });

  test('keeps the first and the newest replies of a long turn', () => {
    const replies = Array.from({ length: 41 }, (_, index) =>
      saidAt(`step ${index}`, `2026-10-04T11:01:${String(index).padStart(2, '0')}.000Z`)
    );
    expect(codexInputEvidence([heardAs('msg_1', 'fix'), ...replies], receipt, 't1')).toMatchObject({
      state: 'observed',
      exchangeCut: true,
      exchange: [
        { text: 'fix' },
        { text: 'step 0' },
        ...Array.from({ length: 38 }, (_, index) => ({ text: `step ${index + 3}` })),
      ],
    });
  });

  test('is unavailable for another thread, an id outside the tail, or a malformed line', () => {
    expect(codexInputEvidence(rollout, receipt, 't2').state).toBe('unavailable');
    expect(codexInputEvidence(rollout, { ...receipt, inputId: 'msg_9' }, 't1').state).toBe(
      'unavailable'
    );
    expect(codexInputEvidence([heardAs('msg_1', 'fix'), '{"cut'], receipt, 't1').state).toBe(
      'unavailable'
    );
  });
});

describe('codexTurnState', () => {
  test('reads a finished turn as everything it said, in order, without repeating the final message', () => {
    expect(
      codexTurnState([
        said('an earlier turn'),
        line('event_msg', { type: 'task_complete', last_agent_message: 'an earlier turn' }),
        line('event_msg', { type: 'task_started' }),
        said('Opened https://github.com/o/r/pull/569.'),
        said('Merged #569.'),
        line('event_msg', { type: 'task_complete', last_agent_message: 'Merged #569.' }),
        '',
      ])
    ).toEqual({
      marker: 'task_complete',
      reply: 'Opened https://github.com/o/r/pull/569.\n\nMerged #569.',
    });
  });

  test('keeps the opening and the newest text when a turn says too much', () => {
    const reply =
      codexTurnState([
        line('event_msg', { type: 'task_started' }),
        said('Opened https://github.com/o/r/pull/1.'),
        said('a'.repeat(12_000)),
        said('Done.'),
      ]).reply ?? '';
    expect(reply).toHaveLength(12_000);
    expect(reply.startsWith('Opened https://github.com/o/r/pull/1.\n\n(…)\n\naaa')).toBe(true);
    expect(reply.endsWith('a\n\nDone.')).toBe(true);
  });

  test('reads a running turn with the latest thing it said', () => {
    expect(
      codexTurnState([
        line('event_msg', { type: 'task_complete', last_agent_message: 'old' }),
        line('event_msg', { type: 'task_started' }),
        said('reading the repo'),
        '{"truncated',
      ])
    ).toEqual({ marker: 'task_started', reply: 'reading the repo' });
  });

  test('a finished turn that asked the user and was not answered is waiting on them', () => {
    const ask = line('response_item', {
      type: 'function_call',
      name: 'request_user_input_async',
      call_id: 'c1',
    });
    const done = line('event_msg', { type: 'task_complete', last_agent_message: 'Which one?' });
    const started = line('event_msg', { type: 'task_started' });
    expect(codexTurnState([started, heard('pick one'), ask, done])).toEqual({
      marker: 'task_complete',
      outcome: 'asked',
      reply: 'Which one?',
    });
    expect(codexTurnState([started, ask, heard('the first'), done])).toEqual({
      marker: 'task_complete',
      reply: 'Which one?',
    });
    expect(codexTurnState([ask, done, started, heard('the first'), said('ok')])).toEqual({
      marker: 'task_started',
      reply: 'ok',
    });
  });

  test('a finished turn that carries an error failed', () => {
    expect(
      codexTurnState([
        line('event_msg', { type: 'task_started' }),
        line('event_msg', { type: 'task_complete', error: 'stream disconnected' }),
      ])
    ).toEqual({ marker: 'task_complete', outcome: 'errored', reply: null });
  });

  test('reports no turn when the tail holds none', () => {
    expect(codexTurnState([said('hello'), 'not json'])).toEqual({ marker: null, reply: 'hello' });
  });
});

describe('codexRecentInputs and reply time', () => {
  const at = (iso: string, entry: string) =>
    JSON.stringify({ ...JSON.parse(entry), timestamp: iso });

  test('lists what reached the thread, without the context Codex injects', () => {
    expect(
      codexRecentInputs([
        at(
          '2026-10-08T17:46:10.051Z',
          heard('<environment_context>\n  <cwd>/x</cwd>\n</environment_context>')
        ),
        at('2026-10-08T17:46:10.074Z', heard('Continue   the\nwork')),
        at('2026-10-08T17:53:57.904Z', said('Blocked.')),
        heard('no time'),
        '{"truncated',
      ])
    ).toEqual([
      { at: Date.parse('2026-10-08T17:46:10.074Z'), text: 'Continue the work', human: true },
    ]);
  });

  test('keeps agent inputs visible for delivery but never labels them human', () => {
    const entries = codexRecentInputs([
      at('2026-10-08T17:46:10.074Z', heard('Do it\n[HyperNeo agent input]')),
      at('2026-10-08T17:46:11.074Z', heard('Neo routed this to you: do it here.')),
      at('2026-10-08T17:46:12.074Z', heard('Please do it myself.')),
    ]);
    expect(entries.map((entry) => entry.human)).toEqual([false, false, true]);
  });

  test('times the reply by the line it came from', () => {
    expect(
      codexTurnState([
        at('2026-10-08T17:50:00.000Z', said('working')),
        at(
          '2026-10-08T17:53:57.904Z',
          line('event_msg', { type: 'task_complete', last_agent_message: 'Blocked.' })
        ),
      ])
    ).toEqual({
      marker: 'task_complete',
      reply: 'working\n\nBlocked.',
      replyAt: Date.parse('2026-10-08T17:53:57.904Z'),
    });
    expect(
      codexTurnState([
        line('event_msg', { type: 'task_started' }),
        at('2026-10-08T17:50:00.000Z', said('working')),
      ])
    ).toEqual({
      marker: 'task_started',
      reply: 'working',
      replyAt: Date.parse('2026-10-08T17:50:00.000Z'),
    });
  });
});

describe('codexExchange', () => {
  const at = (iso: string, entry: string) =>
    JSON.stringify({ ...JSON.parse(entry), timestamp: iso });
  const t = (second: number) => `2026-10-08T17:00:${String(second).padStart(2, '0')}.000Z`;

  test('lists the messages after since, without injected context or a repeated final message', () => {
    const lines = [
      at(t(1), heard('Neo asks: continue')),
      at(t(2), heard('<environment_context>\n</environment_context>')),
      at(t(3), said('Checking the tree.')),
      at(t(4), heard('also the footer')),
      at(t(5), said('Blocked: two files missing.')),
      at(
        t(6),
        line('event_msg', {
          type: 'task_complete',
          last_agent_message: 'Blocked: two files missing.',
        })
      ),
    ];
    expect(codexExchange(lines, Date.parse(t(1)), false)).toEqual({
      entries: [
        { at: Date.parse(t(3)), role: 'agent', text: 'Checking the tree.' },
        { at: Date.parse(t(4)), role: 'user', text: 'also the footer' },
        { at: Date.parse(t(5)), role: 'agent', text: 'Blocked: two files missing.' },
      ],
      cut: false,
    });
  });

  test('keeps the latest 40 messages of a long run and marks the earlier ones unread', () => {
    const lines = Array.from({ length: 45 }, (_, index) =>
      at(`2026-10-08T17:01:${String(index).padStart(2, '0')}.000Z`, said(`step ${index}`))
    );
    const { entries, cut } = codexExchange(lines, Date.parse(t(0)), false);
    expect(entries).toHaveLength(40);
    expect(entries[0].text).toBe('step 5');
    expect(entries.at(-1)?.text).toBe('step 44');
    expect(cut).toBe(true);
  });

  test('marks the exchange cut only when the read tail starts after since', () => {
    const lines = [at(t(3), said('late'))];
    expect(codexExchange(lines, Date.parse(t(1)), true).cut).toBe(true);
    expect(codexExchange(lines, Date.parse(t(4)), true).cut).toBe(false);
    expect(codexExchange(lines, Date.parse(t(1)), false).cut).toBe(false);
  });
});

describe('codex-desktop adapter status and send', () => {
  let dir: string;
  let statePath: string;
  let spawned: string[][];

  beforeEach(() => {
    spawned = [];
    dir = mkdtempSync(join(tmpdir(), 'codex-verbs-'));
    statePath = join(dir, 'state_5.sqlite');
    const running = join(dir, 'running.jsonl');
    const finished = join(dir, 'finished.jsonl');
    writeFileSync(
      running,
      [
        line('event_msg', { type: 'task_started', turn_id: 'turn-1' }),
        said('reading the repo'),
      ].join('\n')
    );
    writeFileSync(
      finished,
      [line('event_msg', { type: 'task_complete', last_agent_message: 'Done.' })].join('\n')
    );
    const db = new Database(statePath);
    db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, updated_at_ms INTEGER)`);
    db.exec(`CREATE TABLE project_roots (project_id TEXT, position INTEGER, path TEXT)`);
    db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, title TEXT, first_user_message TEXT,
      cwd TEXT, source TEXT, archived INTEGER, updated_at_ms INTEGER, rollout_path TEXT, git_branch TEXT)`);
    db.exec(`INSERT INTO projects VALUES ('p1', 'dolmen', 1)`);
    db.exec(`INSERT INTO project_roots VALUES ('p1', 0, '/focus/dolmen')`);
    const insert = db.prepare(
      `INSERT INTO threads VALUES (?, ?, '', '', ?, 'vscode', ?, ?, ?, NULL)`
    );
    insert.run('busy', 'loader', '/codex/worktrees/1/dolmen', 0, NOW - 600_000, running);
    insert.run('idle', 'parser', '/focus/dolmen', 0, NOW - 600_000, finished);
    insert.run('old', 'archived one', '/focus/dolmen', 1, NOW - 900_000, finished);
    db.close();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test.each(
    ['idle', 'active', 'systemError', 'notLoaded'].flatMap((status) =>
      ['present', 'missing', 'unreadable'].map((rollout) => ({ status, rollout }))
    )
  )(
    'archives only an idle Codex thread ($status, $rollout rollout)',
    async ({ status, rollout }) => {
      if (rollout !== 'present') rmSync(join(dir, 'finished.jsonl'));
      if (rollout === 'unreadable') mkdirSync(join(dir, 'finished.jsonl'));
      const root = join(dir, 'prepared');
      mkdirSync(join(root, '.git'), { recursive: true });
      const env = await prepareWorkerSandbox(root);
      const db = new Database(statePath);
      db.prepare('UPDATE threads SET cwd=? WHERE id=?').run(root, 'idle');
      db.close();
      const calls: string[] = [];
      let closed = false;
      const driver = adapter(0, '', async () => ({
        call: async (method, params) => {
          calls.push(method);
          expect(params.threadId).toBe('idle');
          return method === 'thread/read'
            ? { thread: { id: 'idle', status: { type: status } } }
            : {};
        },
        close: () => {
          closed = true;
        },
      }));
      const result = await driver.archive!({ adapter: driver.id, id: 'idle' }, () => null);
      expect(result.ok).toBe(status === 'idle' || status === 'notLoaded');
      expect(existsSync(env.TMPDIR)).toBe(!result.ok);
      expect(existsSync(env.XDG_CACHE_HOME)).toBe(!result.ok);
      expect(existsSync(root)).toBe(true);
      await releaseWorkerSandbox(root);
      expect(calls).toEqual(result.ok ? ['thread/read', 'thread/archive'] : ['thread/read']);
      expect(closed).toBe(true);
    }
  );

  test('does not archive a Codex thread when runtime removal fails', async () => {
    const calls: string[] = [];
    const driver = adapter(0, '', async () => ({
      call: async (method) => {
        calls.push(method);
        return { thread: { id: 'idle', status: { type: 'idle' } } };
      },
      close: () => {},
    }));
    const failure = vi
      .spyOn(sandbox, 'releaseWorkerSandbox')
      .mockRejectedValue(new Error('synthetic EBUSY'));
    try {
      await expect(driver.archive!({ adapter: driver.id, id: 'idle' }, () => null)).rejects.toThrow(
        'synthetic EBUSY'
      );
      expect(calls).toEqual(['thread/read']);
    } finally {
      failure.mockRestore();
    }
  });

  test('retries runtime release for an already archived Codex thread', async () => {
    const root = join(dir, 'prepared');
    mkdirSync(join(root, '.git'), { recursive: true });
    const env = await prepareWorkerSandbox(root);
    const db = new Database(statePath);
    db.prepare('UPDATE threads SET cwd=? WHERE id=?').run(root, 'old');
    db.close();
    try {
      const driver = adapter();
      expect(await driver.archive!({ adapter: driver.id, id: 'old' }, () => null)).toEqual({
        ok: true,
        value: { archived: false },
      });
      expect(existsSync(env.TMPDIR)).toBe(false);
      expect(existsSync(env.XDG_CACHE_HOME)).toBe(false);
    } finally {
      await releaseWorkerSandbox(root);
    }
  });

  test('a running rollout, late refusal and an already archived thread never call thread/archive', async () => {
    appendFileSync(join(dir, 'running.jsonl'), `\n${said('x'.repeat(5 * 1024 * 1024))}`);
    const calls: string[] = [];
    const driver = adapter(0, '', async () => ({
      call: async (method, params) => {
        calls.push(method);
        return { thread: { id: params.threadId, status: { type: 'idle' } } };
      },
      close: () => {},
    }));
    expect(await driver.archive!({ adapter: driver.id, id: 'busy' }, () => null)).toMatchObject({
      ok: false,
      reason: 'busy',
    });
    expect(
      await driver.archive!({ adapter: driver.id, id: 'idle' }, () => ({
        ok: false,
        reason: 'busy',
        detail: 'new',
      }))
    ).toMatchObject({ ok: false, reason: 'busy' });
    expect(await driver.archive!({ adapter: driver.id, id: 'old' }, () => null)).toEqual({
      ok: true,
      value: { archived: false },
    });
    expect(calls).toEqual(['thread/read', 'thread/read']);
  });

  function adapter(
    exitCode = 0,
    stderr = '',
    appServer: () => Promise<CodexAppServer> = async () => ({
      call: async () => {
        throw new Error('thread/queue/add: method not found (-32601)');
      },
      close: () => {},
    }),
    worktreesDir = '/codex/worktrees',
    stdout = '',
    overrides: { newId?: () => string; onSpawn?: () => void } = {}
  ) {
    const spawn: SpawnFn = (args) => {
      spawned.push(args);
      overrides.onSpawn?.();
      return {
        stdout: new Response(stdout).body,
        stderr: new Response(stderr).body,
        exited: Promise.resolve(exitCode),
        exitCode,
        kill: () => {},
      };
    };
    return createCodexDesktopAdapter({
      bootstrapServer: () => Promise.reject(new Error('not used')),
      prepareDesktopProject: async () => 'project-1',
      startDesktopTurn: async () => {
        throw new Error('not used');
      },
      statePath,
      desktopRunning: async () => false,
      worktreesDir,
      machine: 'laptop',
      now: () => NOW,
      spawn,
      appServer,
      folderExists: () => true,
      makeFolder: () => {},
      homeDir: '/Users/test',
      gitCheckout: async () => null,
      newId: overrides.newId ?? (() => 'abcd1234-0000'),
    });
  }

  const ref = (id: string) => ({ adapter: 'codex-desktop', id });

  test.each(['', '  Final Codex message 🔬\n'.repeat(400)])(
    'exposes explicit turn-end payloads without borrowing earlier prose: %s',
    async (message) => {
      const stamp = new Date(NOW).toISOString();
      writeFileSync(
        join(dir, 'finished.jsonl'),
        [
          saidAt('Earlier commentary'),
          JSON.stringify({
            type: 'event_msg',
            timestamp: stamp,
            payload: { type: 'task_complete', turn_id: 'ended-turn', last_agent_message: message },
          }),
        ].join('\n')
      );
      const detail = await adapter().status!(ref('idle'), NOW - 1);
      expect(WorkDetailSchema.parse(detail.ok ? detail.value : null)).toMatchObject({
        turnEnds: [{ id: 'ended-turn', at: NOW, message }],
      });
    }
  );

  test.each([
    [
      '<heartbeat><automation_id>reviewbot-test</automation_id><decision>DONT_NOTIFY</decision><message>Healthy</message></heartbeat>',
      false,
    ],
    [
      '<heartbeat>\n <automation_id>reviewbot-test</automation_id>\n <decision>NOTIFY</decision>\n <message>Failed</message>\n</heartbeat>',
      true,
    ],
    [
      'Example: <heartbeat><automation_id>test</automation_id><decision>DONT_NOTIFY</decision><message>Healthy</message></heartbeat>',
      true,
    ],
    [
      '<heartbeat><automation_id>test</automation_id><decision>DONT_NOTIFY</decision><message>Healthy</message></heartbeat> extra',
      true,
    ],
    [
      '<heartbeat><automation_id>test</automation_id><decision>DONT_NOTIFY</decision><decision>NOTIFY</decision><message>Healthy</message></heartbeat>',
      true,
    ],
    ['<heartbeat><decision>DONT_NOTIFY</decision><message>Healthy</message></heartbeat>', true],
    ['Worker blocked; <decision>DONT_NOTIFY</decision>', true],
  ])(
    'preserves final messages while exposing heartbeat wake admission: %s',
    async (message, notify) => {
      writeFileSync(
        join(dir, 'finished.jsonl'),
        JSON.stringify({
          type: 'event_msg',
          timestamp: new Date(NOW).toISOString(),
          payload: {
            type: 'task_complete',
            turn_id: 'heartbeat-turn',
            last_agent_message: message,
          },
        })
      );
      const detail = await adapter().status!(ref('idle'), NOW - 1);
      const parsed = WorkDetailSchema.parse(detail.ok ? detail.value : null);
      expect(parsed.turnEnds?.[0].message).toBe(message);
      expect((parsed.turnEnds?.[0] as { notify?: boolean }).notify !== false).toBe(notify);
    }
  );

  test.each(['busy', 'idle'])(
    'automatic input waits in the native queue for %s without starting another writer',
    async (id) => {
      const calls: string[] = [];
      const driver = adapter(0, '', async () => ({
        call: async (method) => {
          calls.push(method);
          if (method !== 'thread/queue/add') throw new Error('Must only enqueue');
          return { queuedSubmission: { id: 'pending-input' } };
        },
        close: () => {},
      }));
      expect(await driver.send!(ref(id), 'next task', user)).toEqual({
        ok: true,
        value: { delivered: false, queuedSubmissionId: 'pending-input' },
      });
      expect(calls).toEqual(['thread/queue/add']);
      expect(spawned).toEqual([]);
    }
  );

  test('work.send queues automatic input behind the running turn', async () => {
    const calls: string[] = [];
    const driver = adapter(0, '', async () => ({
      call: async (method) => {
        calls.push(method);
        if (method === 'thread/turns/list')
          return { data: [{ id: 'live-turn', status: 'inProgress' }] };
        if (method === 'turn/steer') return { turnId: 'live-turn' };
        return { queuedSubmission: { id: 'queued' } };
      },
      close: () => {},
    }));
    const registry = createOperationRegistry(
      createWorkVerbOperations({
        adapters: () => [driver],
        daemonName: 'test',
        isOpenTodo: (todoId) => todoId === 'open-todo',
        remote: { list: () => [], invoke: async () => ({}) },
      })
    );
    expect(
      await invokeOperation(
        registry,
        'work.send',
        { ref: ref('busy'), message: 'use the parser', todoId: 'open-todo' },
        { source: 'mcp', role: 'neo', sessionId: 'neo' }
      )
    ).toEqual({
      kind: 'completed',
      value: { ok: true, value: { delivered: false, queuedSubmissionId: 'queued' } },
    });
    expect(calls).toEqual(['thread/queue/add']);
  });

  test('stop interrupts the running turn through the shared app-server', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    let closed = false;
    const server = async (): Promise<CodexAppServer> => ({
      call: async (method, params) => {
        calls.push([method, params]);
        return {};
      },
      close: () => {
        closed = true;
      },
    });
    expect(await adapter(0, '', server).stop?.(ref('busy'), user)).toEqual({
      ok: true,
      value: { stopped: true },
    });
    expect(calls).toEqual([['turn/interrupt', { threadId: 'busy', turnId: 'turn-1' }]]);
    expect(closed).toBe(true);
    expect(await adapter(0, '', server).stop?.(ref('idle'), user)).toEqual({
      ok: true,
      value: { stopped: false },
    });
    expect(calls).toHaveLength(1);
  });

  test('stop finds a turn that began before the recent rollout and reports one that just ended', async () => {
    const calls: string[] = [];
    const chatty = join(dir, 'running.jsonl');
    appendFileSync(chatty, `\n${said('x'.repeat(5 * 1024 * 1024))}`);
    const finishing = async (): Promise<CodexAppServer> => ({
      call: async (_method, params) => {
        calls.push(String(params.turnId));
        if (calls.length === 1) return {};
        appendFileSync(chatty, `\n${line('event_msg', { type: 'task_complete' })}`);
        throw new Error('turn/interrupt got no answer from the Codex app-server.');
      },
      close: () => {},
    });
    expect(await adapter(0, '', finishing).stop?.(ref('busy'), user)).toEqual({
      ok: true,
      value: { stopped: true },
    });
    expect(await adapter(0, '', finishing).stop?.(ref('busy'), user)).toEqual({
      ok: true,
      value: { stopped: false },
    });
    expect(calls).toEqual(['turn-1', 'turn-1']);
  });

  test('stop leaves threads Codex Desktop runs itself to the app', async () => {
    const server = async (): Promise<CodexAppServer> => ({
      call: async () => {
        throw new Error('turn/interrupt: {"code":-32600,"message":"thread not found: busy"}');
      },
      close: () => {},
    });
    expect(await adapter(0, '', server).stop?.(ref('busy'), user)).toEqual({
      ok: false,
      reason: 'unsupported',
      detail: 'Codex Desktop runs thread busy itself; stop it in the app.',
    });
    expect(
      await adapter(0, '', () => Promise.reject(new Error('offline'))).stop?.(ref('busy'), user)
    ).toMatchObject({
      ok: false,
      reason: 'unreachable',
    });
    expect(await adapter().stop?.(ref('nope'), user)).toMatchObject({ reason: 'not_found' });
  });

  test('status preserves a worktree whose project has no git link', async () => {
    expect(await adapter().status?.(ref('busy'))).toEqual({
      ok: true,
      value: {
        ref: ref('busy'),
        title: 'loader',
        place: { machine: 'laptop', folder: '/codex/worktrees/1/dolmen', name: 'dolmen' },
        execution: { directory: '/codex/worktrees/1/dolmen', machine: 'laptop' },
        status: 'running',
        lastActivityAt: NOW - 600_000,
        link: 'codex://threads/busy',
        lastReply: 'reading the repo',
        recentInputs: [],
      },
    });
    expect(await adapter().status?.(ref('idle'))).toMatchObject({
      ok: true,
      value: { status: 'done', lastReply: 'Done.' },
    });
    expect(await adapter().status?.(ref('nope'))).toMatchObject({ ok: false, reason: 'not_found' });
    appendFileSync(
      join(dir, 'finished.jsonl'),
      `\n${heardAs('msg_9', 'ship it')}\n${saidAt('shipped')}`
    );
    const receipt = { executionId: 'idle', inputId: 'msg_9' };
    expect(await adapter().status?.(ref('idle'), undefined, receipt)).toMatchObject({
      ok: true,
      value: { inputEvidence: { receipt, state: 'observed', exchangeCut: false } },
    });
    expect(await adapter().status?.(ref('busy'), undefined, receipt)).toMatchObject({
      ok: true,
      value: { inputEvidence: { receipt, state: 'unavailable' } },
    });
  });

  test('status preserves execution cwd separately from the folded project location', async () => {
    const directory = join(dir, 'worktree');
    mkdirSync(directory);
    writeFileSync(join(directory, '.git'), 'gitdir: /focus/dolmen/.git/worktrees/test\n');
    const db = new Database(statePath);
    db.prepare('UPDATE threads SET cwd = ? WHERE id = ?').run(directory, 'busy');
    db.close();
    const result = await adapter(0, '', undefined, dir).status!(ref('busy'));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(WorkDetailSchema.parse(result.value)).toMatchObject({
      place: { folder: '/focus/dolmen' },
      execution: { directory, machine: 'laptop' },
    });
  });

  test.each(['', 'relative/worktree'])('status omits unusable execution cwd %s', async (cwd) => {
    const db = new Database(statePath);
    db.prepare('UPDATE threads SET cwd = ? WHERE id = ?').run(cwd, 'idle');
    db.close();
    const result = await adapter().status!(ref('idle'));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.execution).toBeUndefined();
    expect(result.value.lastReply).toBe('Done.');
  });

  test('status reports a question waiting on the user and a turn that errored', async () => {
    const rollout = join(dir, 'finished.jsonl');
    appendFileSync(
      rollout,
      `\n${line('event_msg', { type: 'task_started' })}\n${line('response_item', { type: 'function_call', name: 'request_user_input_async' })}\n${line('event_msg', { type: 'task_complete', last_agent_message: 'Which one?' })}`
    );
    expect(await adapter().status?.(ref('idle'))).toMatchObject({
      ok: true,
      value: { status: 'needs_you' },
    });
    appendFileSync(
      rollout,
      `\n${line('event_msg', { type: 'task_started' })}\n${line('event_msg', { type: 'task_complete', error: 'boom' })}`
    );
    expect(await adapter().status?.(ref('idle'))).toMatchObject({
      ok: true,
      value: { status: 'failed' },
    });
  });

  const user = { from: 'chat', caller: { source: 'rpc' as const, principal: 'local' } };

  test('rename updates a busy thread through Codex without starting or interrupting a turn', async () => {
    const calls: unknown[] = [];
    const driver = adapter(0, '', async () => ({
      call: async (method, params) => {
        calls.push([method, params]);
        return {};
      },
      close: () => {},
    }));
    expect(await driver.rename!(ref('busy'), 'HyperNeo backend', user)).toEqual({
      ok: true,
      value: { renamed: true, title: 'HyperNeo backend' },
    });
    expect(calls).toEqual([['thread/name/set', { threadId: 'busy', name: 'HyperNeo backend' }]]);
    expect(spawned).toEqual([]);
  });

  test('rename refuses archived and missing Codex threads and reports API failure', async () => {
    const calls: string[] = [];
    const driver = adapter(0, '', async () => ({
      call: async (method) => {
        calls.push(method);
        throw new Error('rename refused');
      },
      close: () => {},
    }));
    expect(await driver.rename!(ref('missing'), 'ops', user)).toMatchObject({
      ok: false,
      reason: 'not_found',
    });
    expect(await driver.rename!(ref('old'), 'ops', user)).toMatchObject({
      ok: false,
      reason: 'not_open',
    });
    expect(calls).toEqual([]);
    expect(await driver.rename!(ref('busy'), 'ops', user)).toMatchObject({
      ok: false,
      reason: 'not_delivered',
      detail: 'rename refused',
    });
  });

  test.each([false, true])(
    'prepared queue refreshes future-turn sandbox defaults (refused=%s)',
    async (refused) => {
      const root = join(dir, 'prepared');
      mkdirSync(join(root, '.git'), { recursive: true });
      await prepareWorkerSandbox(root);
      const db = new Database(statePath);
      db.prepare('UPDATE threads SET cwd=? WHERE id=?').run(root, 'idle');
      db.close();
      const calls: string[] = [];
      const driver = adapter(0, '', async () => ({
        call: async (method, params) => {
          calls.push(method);
          if (method === 'thread/settings/update') {
            expect(params).toMatchObject({
              threadId: 'idle',
              permissions: 'hyperneo-worker',
            });
            if (refused) throw new Error('sandbox settings refused');
            return {};
          }
          expect(method).toBe('thread/queue/add');
          return { queuedSubmission: { id: 'sandboxed-queue' } };
        },
        close: () => {},
      }));
      try {
        const result = await driver.send!(ref('idle'), 'run local tests', user);
        expect(result).toMatchObject(
          refused
            ? { ok: false, reason: 'not_delivered', detail: 'sandbox settings refused' }
            : { ok: true, value: { queuedSubmissionId: 'sandboxed-queue' } }
        );
        expect(calls).toEqual(
          refused ? ['thread/settings/update'] : ['thread/settings/update', 'thread/queue/add']
        );
      } finally {
        await releaseWorkerSandbox(root);
      }
    }
  );

  test('prepared workers do not bypass a required policy refresh through offline CLI queueing', async () => {
    const root = join(dir, 'prepared');
    mkdirSync(join(root, '.git'), { recursive: true });
    await prepareWorkerSandbox(root);
    const db = new Database(statePath);
    db.prepare('UPDATE threads SET cwd=? WHERE id=?').run(root, 'idle');
    db.close();
    const driver = adapter(
      0,
      '',
      async () => {
        throw new Error('offline');
      },
      undefined,
      'offline-queue'
    );
    try {
      expect(await driver.send!(ref('idle'), 'run local tests', user)).toMatchObject({
        ok: false,
        reason: 'unreachable',
      });
      expect(spawned).toEqual([]);
    } finally {
      await releaseWorkerSandbox(root);
    }
  });

  test.each(['native', 'cli'] as const)(
    'automatic queue restores purged prepared-worker runtime before dispatch: %s',
    async (route) => {
      const root = join(dir, 'prepared');
      mkdirSync(join(root, '.git'), { recursive: true });
      const env = workerSandboxPaths(root);
      const runtime = join(env.TMPDIR, '..');
      const readyAtDispatch: boolean[] = [];
      const observe = () => readyAtDispatch.push(Object.values(env).every(existsSync));
      try {
        await prepareWorkerSandbox(root);
        rmSync(runtime, { recursive: true, force: true });
        const db = new Database(statePath);
        db.prepare('UPDATE threads SET cwd=? WHERE id=?').run(root, 'idle');
        db.close();
        const driver = adapter(
          0,
          '',
          async () => ({
            call: async (method) => {
              if (method === 'thread/settings/update') return {};
              expect(method).toBe('thread/queue/add');
              observe();
              if (route === 'cli') throw new Error('method not found (-32601)');
              return { queuedSubmission: { id: 'restored-queue' } };
            },
            close: () => {},
          }),
          undefined,
          'restored-queue',
          { onSpawn: observe }
        );
        expect(await driver.send!(ref('idle'), 'continue after idle', user)).toEqual({
          ok: true,
          value: { delivered: false, queuedSubmissionId: 'restored-queue' },
        });
        expect(readyAtDispatch).toEqual(route === 'cli' ? [true, true] : [true]);
      } finally {
        rmSync(runtime, { recursive: true, force: true });
      }
    }
  );

  test('automatic queue routing logs the queue route without a steering-failure claim', async () => {
    const config = getLoggerConfig();
    configureLogger({ level: LogLevel.WARN, filter: ['*'], excludeFilter: [] });
    const events: string[] = [];
    const off = subscribeToStructuredLogs((event) => {
      if (event.message.startsWith('work.send route')) events.push(event.message);
    });
    try {
      const driver = adapter(0, '', async () => ({
        call: async () => ({ queuedSubmission: { id: 'native-queue' } }),
        close: () => {},
      }));
      await driver.send!(ref('idle'), 'routine next input', user);
      expect(events).toHaveLength(1);
      expect(events[0]).toContain('"path":"queue"');
      expect(events[0]).toContain('"reason":"native_queue"');
    } finally {
      off();
      configureLogger(config);
    }
  });

  test('advertises separate messaging capabilities and queues natively without spawning', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    let closed = 0;
    const driver = adapter(0, '', async () => ({
      call: async (method, params) => {
        calls.push([method, params]);
        if (method === 'thread/turns/list') return { data: [] };
        return {
          queuedSubmission: {
            id: 'queue-1',
            input: params.input,
            clientUserMessageId: params.clientUserMessageId,
          },
        };
      },
      close: () => {
        closed++;
      },
    }));
    expect(driver.capabilities).toEqual(
      expect.arrayContaining(['steer', 'queue', 'withdraw', 'send', 'stop'])
    );
    for (const method of ['queue'] as const) {
      expect(await driver[method]!(ref('busy'), 'after this', user)).toEqual({
        ok: true,
        value: { delivered: false, queuedSubmissionId: 'queue-1' },
      });
    }
    expect(calls.filter(([method]) => method !== 'thread/turns/list')).toEqual(
      Array.from({ length: 1 }, () => [
        'thread/queue/add',
        {
          threadId: 'busy',
          clientUserMessageId: 'abcd1234-0000',
          input: [{ type: 'text', text: 'after this' }],
        },
      ])
    );
    expect(spawned).toEqual([]);
    expect(closed).toBe(1);
  });

  test.each(['NoActiveTurn', 'turn/steer: method not found (-32601)'])(
    'explicit steer refuses a turn that ended or cannot steer: %s',
    async (error) => {
      const driver = adapter(0, '', async () => ({
        call: async (method) => {
          if (method === 'thread/turns/list') return { data: [{ id: 't1', status: 'inProgress' }] };
          if (method === 'turn/steer') throw new Error(error);
          if (method === 'thread/resume') return { thread: { id: 'busy', turns: [] } };
          if (method === 'turn/start') return { turn: { id: 'new-turn' } };
          throw new Error('Must not queue');
        },
        close: () => {},
      }));
      expect(await driver.steer!(ref('busy'), 'now', user)).toMatchObject({
        ok: false,
        reason: 'not_delivered',
        detail: expect.stringContaining(error),
      });
    }
  );

  test('explicit steer never duplicates a server steer whose outcome is unknown; work.queue remains next-turn input', async () => {
    let queued = 0;
    const driver = adapter(0, '', async () => ({
      call: async (method) => {
        if (method === 'thread/turns/list') return { data: [{ id: 't1', status: 'inProgress' }] };
        if (method === 'turn/steer') throw new Error('connection closed');
        queued++;
        return { queuedSubmission: { id: 'q1' } };
      },
      close: () => {},
    }));
    expect(await driver.steer!(ref('busy'), 'now', user)).toMatchObject({
      ok: false,
      reason: 'not_delivered',
    });
    expect(queued).toBe(0);
    expect(await driver.queue!(ref('busy'), 'later', user)).toEqual({
      ok: true,
      value: { delivered: false, queuedSubmissionId: 'q1' },
    });
    expect(queued).toBe(1);
  });

  test('steers the active server turn even when the local rollout disagrees', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    let closed = false;
    const driver = adapter(0, '', async () => ({
      call: async (method, params) => {
        calls.push([method, params]);
        return method === 'thread/turns/list'
          ? {
              data: [{ id: 'server-turn', status: 'inProgress' }],
              nextCursor: null,
              backwardsCursor: null,
            }
          : { turnId: 'server-turn' };
      },
      close: () => {
        closed = true;
      },
    }));
    expect(await driver.steer!(ref('idle'), 'use the parser', user)).toEqual({
      ok: true,
      value: { delivered: true, steeredIntoTurnId: 'server-turn' },
    });
    expect(calls).toEqual([
      ['thread/turns/list', { threadId: 'idle', limit: 1 }],
      [
        'turn/steer',
        {
          threadId: 'idle',
          expectedTurnId: 'server-turn',
          input: [{ type: 'text', text: 'use the parser' }],
        },
      ],
    ]);
    expect(closed).toBe(true);
    expect(spawned).toEqual([]);
  });

  test('the pure steer admission selects only the latest active turn', () => {
    expect(admitCodexSteerTurn({ data: [{ id: 't1', status: 'inProgress' }] })).toEqual({
      value: 't1',
    });
    expect(
      admitCodexSteerTurn({
        data: [
          { id: 't2', status: 'completed' },
          { id: 't1', status: 'inProgress' },
        ],
      })
    ).toMatchObject({ reason: { reason: 'not_delivered' } });
  });

  test.each(['completed', 'interrupted', 'failed', 'missing'])(
    'never steers or queues without a running server turn: %s',
    async (status) => {
      const calls: string[] = [];
      const data = status === 'missing' ? [] : [{ id: 'server-turn', status }];
      expect(admitCodexSteerTurn({ data })).toMatchObject({ reason: { reason: 'not_delivered' } });
      const driver = adapter(0, '', async () => ({
        call: async (method) => {
          calls.push(method);
          return { data };
        },
        close: () => {},
      }));
      expect(await driver.steer!(ref('busy'), 'hi', user)).toMatchObject({
        ok: false,
        reason: 'not_delivered',
      });
      expect(calls).toEqual(['thread/turns/list']);
      expect(spawned).toEqual([]);
    }
  );

  test('a changed active turn rejects steering without retrying or queueing', async () => {
    const calls: string[] = [];
    let closed = false;
    const driver = adapter(0, '', async () => ({
      call: async (method) => {
        calls.push(method);
        if (method === 'thread/turns/list') return { data: [{ id: 't1', status: 'inProgress' }] };
        throw new Error('expected turn t1 but active turn is t2');
      },
      close: () => {
        closed = true;
      },
    }));
    expect(await driver.steer!(ref('busy'), 'hi', user)).toMatchObject({
      ok: false,
      reason: 'not_delivered',
      detail: expect.stringContaining('active turn is t2'),
    });
    expect(calls).toEqual(['thread/turns/list', 'turn/steer']);
    expect(closed).toBe(true);
    expect(spawned).toEqual([]);
  });

  test.each(['withdrawn', 'delivered', 'steered', 'delivery-race'])(
    'withdraw returns a fact for %s',
    async (state) => {
      const calls: Array<[string, Record<string, unknown>]> = [];
      let closed = false;
      const driver = adapter(0, '', async () => ({
        call: async (method, params) => {
          calls.push([method, params]);
          return method === 'thread/queue/list'
            ? {
                data: [
                  { id: 'unrelated' },
                  ...(['withdrawn', 'delivery-race'].includes(state)
                    ? [{ id: 'queue-1', input: [], clientUserMessageId: 'client-1' }]
                    : []),
                ],
              }
            : { deleted: state === 'withdrawn' };
        },
        close: () => {
          closed = true;
        },
      }));
      const withdrawn = state === 'withdrawn';
      expect(await driver.withdraw!(ref('busy'), 'queue-1', user)).toEqual({
        ok: true,
        value: {
          queuedSubmissionId: 'queue-1',
          withdrawn,
          ...(!withdrawn ? { reason: 'not_queued' } : {}),
        },
      });
      expect(calls).toEqual([
        ['thread/queue/list', { threadId: 'busy' }],
        ...(['withdrawn', 'delivery-race'].includes(state)
          ? [['thread/queue/delete', { threadId: 'busy', queuedSubmissionId: 'queue-1' }]]
          : []),
      ]);
      expect(closed).toBe(true);
      expect(spawned).toEqual([]);
    }
  );

  test.each(['requires experimentalApi capability', 'connection closed', 'queue add timed out'])(
    'never falls back to CLI for a possibly accepted queue request: %s',
    async (error) => {
      let closed = false;
      const driver = adapter(0, '', async () => ({
        call: async () => {
          throw new Error(error);
        },
        close: () => {
          closed = true;
        },
      }));
      expect(await driver.queue!(ref('busy'), 'hi', user)).toEqual({
        ok: false,
        reason: 'not_delivered',
        detail: error,
      });
      expect(spawned).toEqual([]);
      expect(closed).toBe(true);
    }
  );

  test.each(['queue', 'steer', 'withdraw'] as const)(
    'reports malformed %s responses as faults and closes the connection',
    async (method) => {
      let closed = false;
      const driver = adapter(0, '', async () => ({
        call: async () => ({ unexpected: true }),
        close: () => {
          closed = true;
        },
      }));
      expect(await driver[method]!(ref('busy'), 'id-or-message', user)).toMatchObject({
        ok: false,
        reason: 'not_delivered',
      });
      expect(closed).toBe(true);
      expect(spawned).toEqual([]);
    }
  );

  test.each(['steer', 'queue'] as const)(
    'marks native %s input as agent-originated',
    async (method) => {
      const calls: Array<[string, Record<string, unknown>]> = [];
      const driver = adapter(0, '', async () => ({
        call: async (name, params) => {
          calls.push([name, params]);
          return name === 'thread/turns/list'
            ? { data: [{ id: 't1', status: 'inProgress' }] }
            : name === 'turn/steer'
              ? { turnId: 't1' }
              : { queuedSubmission: { id: 'q1' } };
        },
        close: () => {},
      }));
      expect(
        (
          await driver[method]!(ref('busy'), 'continue', {
            from: 'session:neo',
            caller: { source: 'internal', role: 'neo' },
          })
        ).ok
      ).toBe(true);
      expect(calls.at(-1)?.[1].input).toEqual([
        { type: 'text', text: 'continue\n[HyperNeo agent input]' },
      ]);
    }
  );

  test('withdraw surfaces a failed delete rather than claiming the message is no longer queued', async () => {
    let closed = false;
    const driver = adapter(0, '', async () => ({
      call: async (method) => {
        if (method === 'thread/queue/list') return { data: [{ id: 'q1' }] };
        throw new Error('delete refused');
      },
      close: () => {
        closed = true;
      },
    }));
    expect(await driver.withdraw!(ref('busy'), 'q1', user)).toEqual({
      ok: false,
      reason: 'not_delivered',
      detail: 'delete refused',
    });
    expect(closed).toBe(true);
  });

  test.each(['steer', 'withdraw'] as const)(
    'reports unavailable delivery for %s without shell fallback',
    async (method) => {
      const driver = adapter(0, '', () => Promise.reject(new Error('offline')));
      expect(await driver[method]!(ref('busy'), 'id-or-message', user)).toMatchObject({
        ok: false,
        reason: method === 'steer' ? 'not_delivered' : 'unreachable',
      });
      expect(spawned).toEqual([]);
    }
  );

  test.each(['queue'] as const)(
    'preserves CLI availability when %s cannot connect before submission',
    async (method) => {
      const driver = adapter(
        0,
        '',
        () => Promise.reject(new Error('connect ECONNREFUSED')),
        undefined,
        'offline-queue-id\n'
      );
      expect(await driver[method]!(ref('busy'), 'later', user)).toEqual({
        ok: true,
        value: { delivered: false, queuedSubmissionId: 'offline-queue-id' },
      });
      expect(spawned).toEqual([['codex', 'queue', '--thread=busy', '--message=later']]);
    }
  );

  test.each(
    [false, true].flatMap((identical) => [false, true].map((reverse) => ({ identical, reverse })))
  )(
    'concurrent sends never share the first consumed input receipt (identical: $identical, reverse: $reverse)',
    async ({ identical, reverse }) => {
      const requests: Array<{
        params: Record<string, unknown>;
        resolve: (reply: unknown) => void;
      }> = [];
      let next = 0;
      const driver = adapter(
        0,
        '',
        async () => ({
          call: async (method, params) => {
            expect(method).toBe('thread/queue/add');
            return new Promise((resolve) => {
              requests.push({ params, resolve });
              if (requests.length !== 2) return;
              if (reverse) requests.reverse();
              const first = requests[0].params;
              const text = (first.input as { text: string }[])[0].text;
              appendFileSync(
                join(dir, 'finished.jsonl'),
                `\n${heardAs(String(first.clientUserMessageId), text)}\n${saidAt('First reply only.')}`
              );
              requests.forEach((request, index) =>
                request.resolve({ queuedSubmission: { id: `queue-${index}` } })
              );
            });
          },
          close: () => {},
        }),
        undefined,
        '',
        { newId: () => `client-${next++}` }
      );
      const prefix = 'same prefix '.repeat(20);
      const messages = [`${prefix} first`, `${prefix} ${identical ? 'first' : 'second'}`];
      const results = await Promise.all(
        messages.map((message) => driver.send!(ref('idle'), message, user))
      );
      const consumed = requests[0].params;
      const receipt = { executionId: 'idle', inputId: String(consumed.clientUserMessageId) };
      expect(
        results.find((result) => result.ok && result.value.queuedSubmissionId === 'queue-0')
      ).toEqual({
        ok: true,
        value: { delivered: true, queuedSubmissionId: 'queue-0', receipt },
      });
      expect(
        results.find((result) => result.ok && result.value.queuedSubmissionId === 'queue-1')
      ).toEqual({
        ok: true,
        value: { delivered: false, queuedSubmissionId: 'queue-1' },
      });
      expect(await driver.status!(ref('idle'), undefined, receipt)).toMatchObject({
        ok: true,
        value: {
          inputEvidence: {
            state: 'observed',
            exchange: [
              { role: 'user', text: (consumed.input as { text: string }[])[0].text },
              { role: 'agent', text: 'First reply only.' },
            ],
          },
        },
      });
    }
  );

  test('CLI queue never attributes a concurrent matching input to an unrelated queue id', async () => {
    const driver = adapter(0, '', undefined, undefined, 'cli-queue', {
      onSpawn: () =>
        appendFileSync(
          join(dir, 'finished.jsonl'),
          `\n${heardAs('another-input', 'next task')}\n${saidAt('Another sender reply.')}`
        ),
    });
    expect(await driver.send!(ref('idle'), 'next task', user)).toEqual({
      ok: true,
      value: { delivered: false, queuedSubmissionId: 'cli-queue' },
    });
  });

  test('native queue preserves a fresh delivered input receipt for later evidence reads', async () => {
    appendFileSync(join(dir, 'running.jsonl'), `\n${heardAs('older', 'next step')}`);
    const driver = adapter(0, '', async () => ({
      call: async (method, params) => {
        if (method === 'thread/turns/list') return { data: [] };
        appendFileSync(
          join(dir, 'running.jsonl'),
          `\n${heardAs(String(params.clientUserMessageId), 'next step')}`
        );
        return { queuedSubmission: { id: 'native-queue' } };
      },
      close: () => {},
    }));
    const receipt = { executionId: 'busy', inputId: 'abcd1234-0000' };
    expect(await driver.queue!(ref('busy'), 'next step', user)).toEqual({
      ok: true,
      value: { delivered: true, queuedSubmissionId: 'native-queue', receipt },
    });
    expect(await driver.status!(ref('busy'), undefined, receipt)).toMatchObject({
      ok: true,
      value: {
        inputEvidence: {
          receipt,
          state: 'observed',
          exchange: [{ role: 'user', text: 'next step' }],
        },
      },
    });
    expect(spawned).toEqual([]);
  });

  test('a previously delivered copy does not make a newly queued native input delivered', async () => {
    appendFileSync(join(dir, 'running.jsonl'), `\n${heardAs('older', 'next step')}`);
    const driver = adapter(0, '', async () => ({
      call: async () => ({ queuedSubmission: { id: 'still-queued' } }),
      close: () => {},
    }));
    expect(await driver.queue!(ref('busy'), 'next step', user)).toEqual({
      ok: true,
      value: { delivered: false, queuedSubmissionId: 'still-queued' },
    });
  });

  test('CLI queue acceptance does not reuse an earlier identical input as delivery evidence', async () => {
    appendFileSync(join(dir, 'finished.jsonl'), '\n' + heardAs('old-input', 'next task'));
    const driver = adapter(
      0,
      '',
      async () => ({
        call: async () => {
          throw new Error('method not found (-32601)');
        },
        close: () => {},
      }),
      undefined,
      'queued-cli-input'
    );
    expect(await driver.send!(ref('idle'), 'next task', user)).toEqual({
      ok: true,
      value: { delivered: false, queuedSubmissionId: 'queued-cli-input' },
    });
  });

  test('CLI compatibility preserves its queue id for withdrawal', async () => {
    expect(
      await adapter(0, '', undefined, undefined, 'queue-cli-1\n').queue!(ref('busy'), 'hi', user)
    ).toEqual({
      ok: true,
      value: { delivered: false, queuedSubmissionId: 'queue-cli-1' },
    });
    expect(spawned).toEqual([['codex', 'queue', '--thread=busy', '--message=hi']]);
  });

  test('message capabilities reject unknown or archived targets before connecting', async () => {
    let connected = false;
    const driver = adapter(0, '', async () => {
      connected = true;
      throw new Error('unexpected');
    });
    for (const method of ['steer', 'queue'] as const) {
      expect(await driver[method]!(ref('nope'), 'hi', user)).toMatchObject({
        ok: false,
        reason: 'not_found',
      });
      expect(await driver[method]!(ref('old'), 'hi', user)).toMatchObject({
        ok: false,
        reason: 'not_open',
      });
    }
    expect(await driver.withdraw!(ref('nope'), 'q1', user)).toMatchObject({
      ok: false,
      reason: 'not_found',
    });
    expect(connected).toBe(false);
  });

  test.each([false, true])(
    'an undiscovered active writer accepts idle input through its queue (consumed: %s)',
    async (consumed) => {
      const queued: string[] = [];
      const receipt = { executionId: 'idle', inputId: 'abcd1234-0000' };
      const driver = adapter(0, '', async () => ({
        call: async (method, params) => {
          if (method === 'thread/turns/list')
            return { data: [{ id: 'done', status: 'completed' }] };
          if (method === 'thread/resume')
            throw new Error(
              'thread/resume: {"code":-32600,"message":"thread idle already has an active writer"}'
            );
          if (method !== 'thread/queue/add') throw new Error('Must not start another writer');
          const text = (params.input as { text: string }[])[0].text;
          queued.push(text);
          if (consumed)
            appendFileSync(
              join(dir, 'finished.jsonl'),
              `\n${heardAs(receipt.inputId, text)}\n${saidAt('Received queued work.')}`
            );
          return { queuedSubmission: { id: 'writer-queue' } };
        },
        close: () => {},
      }));
      expect(await driver.send!(ref('idle'), 'continue saved work', user)).toEqual({
        ok: true,
        value: {
          delivered: consumed,
          queuedSubmissionId: 'writer-queue',
          ...(consumed ? { receipt } : {}),
        },
      });
      expect(queued).toEqual(['continue saved work']);
      if (consumed)
        expect(await driver.status!(ref('idle'), undefined, receipt)).toMatchObject({
          ok: true,
          value: {
            inputEvidence: {
              state: 'observed',
              receipt,
              exchange: [
                { role: 'user', text: 'continue saved work' },
                { role: 'agent', text: 'Received queued work.' },
              ],
            },
          },
        });
      expect(spawned).toEqual([]);
    }
  );

  test.each([0, 1])(
    'active-writer CLI queue returns its receipt or refusal: %s',
    async (exitCode) => {
      const driver = adapter(
        exitCode,
        'queue refused',
        async () => ({
          call: async (method) => {
            if (method === 'thread/turns/list') return { data: [] };
            if (method === 'thread/resume')
              throw new Error('thread idle already has an active writer');
            throw new Error('thread/queue/add: method not found (-32601)');
          },
          close: () => {},
        }),
        undefined,
        'writer-cli-queue\n'
      );
      expect(await driver.send!(ref('idle'), 'continue', user)).toEqual(
        exitCode === 0
          ? {
              ok: true,
              value: { delivered: false, queuedSubmissionId: 'writer-cli-queue' },
            }
          : { ok: false, reason: 'not_delivered', detail: 'queue refused' }
      );
      expect(spawned).toEqual([['codex', 'queue', '--thread=idle', '--message=continue']]);
    }
  );

  test('automatic agent input keeps its attribution when queued', async () => {
    let text = '';
    const driver = adapter(0, '', async () => ({
      call: async (method, params) => {
        expect(method).toBe('thread/queue/add');
        text = (params.input as { text: string }[])[0].text;
        return { queuedSubmission: { id: 'agent-queue' } };
      },
      close: () => {},
    }));
    const agent = {
      from: 'session:neo',
      caller: { source: 'internal' as const, role: 'neo' as const },
    };
    expect(await driver.send!(ref('idle'), 'new request', agent)).toEqual({
      ok: true,
      value: { delivered: false, queuedSubmissionId: 'agent-queue' },
    });
    expect(text).toBe('new request\n[HyperNeo agent input]');
    expect(spawned).toEqual([]);
  });

  test.each([
    'thread idle already has an active writer',
    'Cannot start: thread idle already has an active writer; retry later',
  ])(
    'a typed active-writer refusal remains retryable while a lost reply stays uncertain: %s',
    async (wording) => {
      const server = createServer();
      const sockets = new WebSocketServer({ server });
      const path = join(dir, 'refusal.sock');
      let refused = true;
      let accepted = 0;
      sockets.on('connection', (socket) =>
        socket.on('message', (bytes) => {
          const request = JSON.parse(String(bytes));
          if (request.id === undefined) return;
          if (request.method === 'thread/queue/add') {
            if (refused)
              socket.send(
                JSON.stringify({
                  id: request.id,
                  error: { code: -32600, message: wording },
                })
              );
            else {
              accepted++;
              socket.close();
            }
            return;
          }
          socket.send(
            JSON.stringify({
              id: request.id,
              result: request.method === 'thread/turns/list' ? { data: [] } : {},
            })
          );
        })
      );
      await new Promise<void>((resolve) => server.listen(path, resolve));
      const driver = adapter(0, '', () => connectCodexAppServer(path));
      try {
        expect(await driver.send!(ref('idle'), 'answer', user)).toMatchObject({
          ok: false,
          reason: 'not_delivered',
          notSent: true,
        });
        expect(accepted).toBe(0);
        refused = false;
        const unknown = await driver.send!(ref('idle'), 'answer', user);
        expect(unknown).toMatchObject({ ok: false, reason: 'not_delivered' });
        expect(unknown).not.toHaveProperty('notSent');
        expect(accepted).toBe(1);
      } finally {
        for (const socket of sockets.clients) socket.terminate();
        sockets.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  );

  test.each(['thread/turns/list', 'turn/steer'])(
    'distinguishes a pre-send refusal from a lost acknowledgement at %s',
    async (phase) => {
      const accepted: string[] = [];
      const driver = adapter(0, '', async () => ({
        call: async (method, params) => {
          if (method === 'turn/steer') accepted.push(JSON.stringify(params.input));
          if (method === phase) throw new Error('Synthetic connection lost');
          if (method === 'thread/turns/list')
            return { data: [{ id: 'active', status: 'inProgress' }] };
          throw new Error(`Unexpected ${method}`);
        },
        close: () => {},
      }));
      const reply = await driver.steer!(ref('idle'), 'answer the worker', user);
      expect(reply).toMatchObject({ ok: false, reason: 'not_delivered' });
      if (phase === 'turn/steer') {
        expect(reply).not.toHaveProperty('notSent');
        expect(accepted).toHaveLength(1);
      } else {
        expect(reply).toHaveProperty('notSent', true);
        expect(accepted).toEqual([]);
      }
    }
  );

  test('send refuses archived threads and unavailable turn delivery', async () => {
    expect(await adapter().send?.(ref('old'), 'hi', user)).toMatchObject({
      ok: false,
      reason: 'not_open',
    });
    expect(
      await adapter(1, 'no such thread\n', async () => ({
        call: async () => {
          throw new Error('no such thread');
        },
        close: () => {},
      })).send?.(ref('idle'), 'hi', user)
    ).toMatchObject({
      ok: false,
      reason: 'not_delivered',
    });
    expect(spawned).toEqual([]);
  });
});
