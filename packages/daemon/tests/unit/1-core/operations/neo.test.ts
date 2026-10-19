import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { z } from 'zod';

import type { MessageHub } from '@hyperneo/shared';
import type { NeoAsk } from '@hyperneo/shared/types/neo-snapshot';
import type { HookInput, Options } from '@anthropic-ai/claude-agent-sdk';
import type { Database as SQLite } from '../../../../src/storage/sqlite-compat.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';
import type { Database } from '../../../../src/storage/database.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import type { CreateSessionParams } from '../../../../src/lib/session/session-lifecycle.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import { createNeoOperations, NEO_HUMAN_TURN_REFUSAL } from '../../../../src/lib/neo/operations.ts';
import {
  neoCoordinatorAllowedTools,
  neoCoordinatorBinding,
  neoCoordinatorNativeTools,
  neoCoordinatorRuntimePath,
  restrictNeoQuery,
} from '../../../../src/lib/neo/session-policy.ts';
import { neoFolderPath } from '../../../../src/lib/neo/folder.ts';
import {
  createOperationRegistry,
  defineOperation,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import { invokeOperation, isOperationAdmitted } from '../../../../src/lib/operations/invoke.ts';
import { listOperationSummaries } from '../../../../src/lib/operations/discovery.ts';
import { neoPrompt } from '../../../../src/lib/neo/prompt.ts';
import { QueryAttemptRegistry } from '../../../../src/lib/agent/query-attempt-token.ts';
import { createOperationMcpHandler } from '../../../../src/lib/operations/mcp-adapter.ts';
import { withNeoProposalAsk } from '../../helpers/neo-proposal-ask.ts';

const human: OperationCaller = { source: 'rpc', principal: 'local' };
const project = {
  id: 'book-club',
  title: 'Book club',
  summary: 'Sunday afternoons',
  context: 'Six people, free venue',
  expectedRevision: 0,
};

describe('Neo MVP', () => {
  test('the holder prompt has no root rule-saving operation', () => {
    expect(neoPrompt('book-club')).not.toContain('neo.rule.save');
  });

  let sqlite: SQLite;
  let service: NeoService;
  let db: Database;
  let sessions: SessionManager;
  let events: InternalEventBus<DaemonInternalEventMap>;
  let created: CreateSessionParams[];
  let active: Set<string>;
  let jobs: { payload: Record<string, unknown> }[];
  let terminal: boolean;
  let terminalSessions: Set<string> | null;
  let failed: string | null;
  let delivered: Set<string>;
  let interrupt: ReturnType<typeof mock>;
  let settings: { neo?: { standingRules?: string[] } };
  let published: unknown[];

  beforeEach(async () => {
    const real = await createTestDb();
    sqlite = real.getDatabase();
    real.createSession(createTestSession('ordinary'));
    created = [];
    active = new Set();
    jobs = [];
    terminal = false;
    terminalSessions = null;
    failed = null;
    delivered = new Set();
    interrupt = mock(async () => {});
    settings = {};
    published = [];
    const queue = {
      listActiveByPayload: (_queue: string, match: Record<string, unknown>) =>
        jobs.filter(
          ({ payload }) =>
            (payload.to as { sessionId: string }).sessionId === match['to.sessionId'] &&
            payload.messageUuid === match.messageUuid
        ),
      enqueueUniquePending: (job: { payload: Record<string, unknown> }) => {
        jobs.push(job);
        return { id: String(jobs.length) };
      },
    };
    db = {
      getDatabase: () => sqlite,
      getGlobalSettings: () => settings,
      updateGlobalSettings: (updates: typeof settings) => {
        settings = { ...settings, ...updates };
        return settings;
      },
      getSession: (id: string) => (active.has(id) ? { id } : null),
      getJobQueueRepo: () => queue,
      getSDKMessageRepo: () => ({
        getStoredPromptsByUuid: () => [{ type: 'user', inputKind: 'human' }],
        listQueuedInputs: () => [],
        lastConsumedInputSeq: () => null,
        latestCompactionSeq: () => 0,
        findMessageIdByUuid: (id: string, uuid: string) =>
          delivered.has(`${id}:${uuid}`) ? uuid : null,
        hasTerminalResultAfter: (id: string) => terminalSessions?.has(id) ?? terminal,
        getErrorTerminalResultSubtypeAfter: (id: string) =>
          terminalSessions && !terminalSessions.has(id) ? null : failed,
        getTurnErrorResultSubtype: (id: string) =>
          terminalSessions && !terminalSessions.has(id) ? null : failed,
        getAssistantMessagesSince: () => [
          {
            id: 'reply',
            text: 'A quiet library room is a possible free venue.',
            toolCallNames: [],
          },
        ],
      }),
    } as unknown as Database;
    sessions = {
      createSession: async (params: CreateSessionParams) => {
        created.push(params);
        active.add(params.sessionId!);
        return params.sessionId;
      },
      getSessionAsync: async () => ({ handleInterrupt: interrupt }),
    } as unknown as SessionManager;
    events = new InternalEventBus<DaemonInternalEventMap>();
    service = new NeoService(
      db,
      sessions,
      { event: mock(() => {}) } as unknown as MessageHub,
      events,
      (updated) => published.push(updated)
    );
  });
  afterEach(() => {
    service.dispose();
    sqlite.close();
  });

  async function invoke(name: string, input: unknown = {}, caller = human) {
    return invokeOperation(
      createOperationRegistry(createNeoOperations(service)),
      name,
      withNeoProposalAsk(service, name, input, caller),
      caller
    );
  }
  function holderInput(sessionId: string): OperationCaller {
    return {
      source: 'mcp',
      role: 'neo',
      sessionId,
      neoTurn: { messageId: 'human-message', human: true, isLive: () => true },
    };
  }
  async function propose() {
    const root = await service.open();
    return service.repo.proposeWork({
      id: crypto.randomUUID(),
      requestKey: crypto.randomUUID(),
      projectId: null,
      originSessionId: root,
      targetSessionId: 'ordinary',
      title: 'Suggest venues',
      instruction: 'Suggest three free venues. Do not book anything.',
    });
  }

  test('opening is idempotent, independent of project creation and uses constrained coordinator sessions', async () => {
    const ids = await Promise.all([service.open(), service.open(), service.open()]);
    expect(new Set(ids).size).toBe(1);
    expect(created).toHaveLength(1);
    expect(created[0].config).toMatchObject({
      permissionMode: 'dontAsk',
      sdkToolsPreset: neoCoordinatorNativeTools(),
      allowedTools: neoCoordinatorAllowedTools(),
    });
    expect(created[0]).toMatchObject({ workspacePath: neoFolderPath(), detectGit: false });
    expect(service.repo.listProjects()).toEqual([]);
    expect(await service.open()).toBe(ids[0]);
    expect(neoCoordinatorBinding(db, ids[0])?.kind).toBe('neo');
    expect(neoCoordinatorBinding(db, 'ordinary')).toBeNull();
  });

  test('real operation pipeline saves with revision protection and reuses durable contexts', async () => {
    service.repo.saveProject(project, 0);
    expect(await invoke('neo.project.save', { ...project, expectedRevision: 1 })).toMatchObject({
      kind: 'completed',
      value: { ok: true, project: { revision: 2 } },
    });
    expect(
      await invoke('neo.project.save', { ...project, expectedRevision: 1, context: 'Lost update' })
    ).toMatchObject({
      kind: 'completed',
      value: { ok: false },
    });
    const id = await service.open();
    expect(await service.open()).toBe(id);
    expect(created[0].config).toMatchObject({
      sdkToolsPreset: neoCoordinatorNativeTools(),
      allowedTools: neoCoordinatorAllowedTools(),
    });
    expect(await invoke('neo.snapshot')).toMatchObject({
      value: { projects: [{ context: project.context }] },
    });
    const root = await service.open();
    expect(
      await invoke('neo.snapshot', {}, { source: 'mcp', role: 'neo', sessionId: root })
    ).toMatchObject({ value: { projects: [{ context: '' }] } });
  });

  test('a holder session title follows its project title', async () => {
    service.repo.saveProject(project, 0);
    const id = 'neo:holder';
    service.repo.reserveBinding({ sessionId: id, kind: 'project', projectId: project.id });
    active.add(id);
    const titles = new Map([[id, 'Neo · an old name']]);
    Object.assign(db, {
      getSession: (sessionId: string) =>
        active.has(sessionId) ? { id: sessionId, title: titles.get(sessionId) } : null,
    });
    Object.assign(sessions, {
      updateSession: async (sessionId: string, updates: { title: string }) => {
        titles.set(sessionId, updates.title);
      },
    });
    await invoke('neo.project.save', { ...project, title: 'Renamed', expectedRevision: 1 });
    expect(titles.get(id)).toBe('Neo · Renamed');
    titles.set(id, 'My name');
    Object.assign(db, {
      getSession: (sessionId: string) =>
        active.has(sessionId)
          ? { id: sessionId, title: titles.get(sessionId), metadata: { titleSetBy: 'user' } }
          : null,
    });
    await invoke('neo.project.save', { ...project, title: 'Again', expectedRevision: 2 });
    expect(titles.get(id)).toBe('My name');
  });

  test('a project snapshot lists the folders the project owns on every machine', async () => {
    service.repo.saveProject(project, 0);
    for (const alias of ['folder:laptop\u0000/w/app', 'folder:imac\u0000/x/app', 'git:root'])
      sqlite
        .prepare('INSERT INTO neo_project_workspaces (alias, project_id) VALUES (?, ?)')
        .run(alias, project.id);
    expect(await invoke('neo.snapshot')).toMatchObject({
      value: {
        projects: [
          {
            folders: [
              { machine: 'laptop', folder: '/w/app' },
              { machine: 'imac', folder: '/x/app' },
            ],
          },
        ],
      },
    });
  });

  test('standing rules start empty, the human adds them, and Neo cannot without a human turn', async () => {
    expect(await invoke('neo.snapshot')).toMatchObject({ value: { standingRules: [] } });
    const root = await service.open();
    const rules = ['Ask before deleting anything.'];
    expect(await invoke('neo.rule.save', { add: rules })).toMatchObject({
      value: { ok: true, standingRules: rules },
    });
    expect(
      await invoke(
        'neo.rule.save',
        { remove: rules, from: 'anything' },
        { source: 'mcp', role: 'neo', sessionId: root }
      )
    ).toMatchObject({ value: { ok: false } });
    expect(await invoke('neo.snapshot')).toMatchObject({ value: { standingRules: rules } });
    expect(published).toEqual([expect.objectContaining({ neo: { standingRules: rules } })]);
    service.repo.saveProject({ id: 'book-club', title: 'Book club', summary: '', context: '' }, 0);
    const holder = await service.open();
    expect(
      await invoke(
        'neo.rule.save',
        { remove: rules },
        { source: 'mcp', role: 'neo', sessionId: holder }
      )
    ).toMatchObject({ value: { ok: false, reason: NEO_HUMAN_TURN_REFUSAL } });
    expect(settings.neo?.standingRules).toEqual(rules);
  });

  test('work origin message ids survive the snapshot boundary in every state', async () => {
    service.repo.saveProject({ id: 'book-club', title: 'Book club', summary: '', context: '' }, 0);
    const root = await service.open();
    const states = ['proposed', 'queued', 'reported'] as const;
    const works = states.map((state) => {
      const work = service.repo.proposeWork({
        id: `origin-${state}`,
        requestKey: `origin-${state}`,
        projectId: 'book-club',
        originSessionId: root,
        originMessageId: `ask-${state}`,
        title: `Origin-bearing ${state}`,
        instruction: 'Draft a plan.',
      });
      if (state === 'queued')
        service.repo.transitionWork(work.id, work, { status: 'queued', sessionId: 'exec' });
      if (state === 'reported')
        service.repo.transitionWork(
          work.id,
          { status: 'proposed', sessionId: null, report: null },
          { status: 'reported', report: 'Done.' }
        );
      return work;
    });
    expect(works.map((work) => work.originMessageId)).toEqual([
      'ask-proposed',
      'ask-queued',
      'ask-reported',
    ]);
    const snapshot = (await invoke('neo.snapshot')) as {
      value: { work: Array<{ id: string; status: string; originMessageId: string | null }> };
    };
    const byState = new Map(snapshot.value.work.map((item) => [item.status, item]));
    for (const state of states) {
      expect(byState.get(state)?.originMessageId).toBe(`ask-${state}`);
    }
  });

  test('Neo reads a stale queued card as abandoned, the phase the human sees', async () => {
    const root = await service.open();
    service.driverTargets.propose(
      service.repo,
      {
        id: 'stale',
        requestKey: 'stale',
        projectId: null,
        originSessionId: root,
        title: 'Waiting on Codex',
        instruction: 'Count the files.',
      },
      {
        verb: 'start',
        adapter: 'codex-desktop',
        place: { machine: 'laptop', folder: '/focus/dolmen', name: 'dolmen' },
      }
    );
    service.repo.transitionWork('stale', service.repo.getWork('stale')!, {
      status: 'queued',
      sessionId: null,
    });
    sqlite.prepare("UPDATE neo_work SET updated_at = 1 WHERE id = 'stale'").run();
    const read = (await invoke(
      'neo.snapshot',
      {},
      { source: 'mcp', role: 'neo', sessionId: root }
    )) as {
      value: { work: Array<{ id: string; status: string; phase?: string }>; omitted?: unknown };
    };
    expect(read.value.work).toEqual([
      expect.objectContaining({ id: 'stale', status: 'queued', phase: 'abandoned' }),
    ]);
    expect(read.value.omitted).toBeUndefined();
  });

  test('human snapshots retain a bounded set of older actionable work', async () => {
    service.repo.saveProject({ id: 'book-club', title: 'Book club', summary: '', context: '' }, 0);
    const root = await service.open();
    const oldest = service.repo.proposeWork({
      id: 'oldest',
      requestKey: 'oldest',
      projectId: 'book-club',
      originSessionId: root,
      title: 'Still needs a decision',
      instruction: 'Draft a plan.',
    });
    sqlite.prepare('UPDATE neo_work SET created_at = 1 WHERE id = ?').run(oldest.id);
    const queued = service.repo.proposeWork({
      id: 'queued',
      requestKey: 'queued',
      projectId: 'book-club',
      originSessionId: root,
      title: 'Still running',
      instruction: 'Draft a plan.',
    });
    service.repo.transitionWork(queued.id, queued, {
      status: 'queued',
      sessionId: 'queued-session',
    });
    sqlite.prepare('UPDATE neo_work SET created_at = 2 WHERE id = ?').run(queued.id);
    for (let index = 0; index < 50; index++) {
      const item = service.repo.proposeWork({
        id: `recent-${index}`,
        requestKey: `recent-${index}`,
        projectId: 'book-club',
        originSessionId: root,
        title: 'Completed work',
        instruction: 'Draft a plan.',
      });
      service.repo.transitionWork(
        item.id,
        { status: 'proposed', sessionId: null, report: null },
        { status: 'reported', report: 'Done.' }
      );
    }
    const rootSnapshot = (await invoke('neo.snapshot')) as {
      value: { work: Array<{ id: string }> };
    };
    expect(rootSnapshot.value.work).toHaveLength(52);
    expect(rootSnapshot.value.work.at(-1)?.id).toBe(oldest.id);
    expect(rootSnapshot.value.work.some((item) => item.id === queued.id)).toBe(true);
    const concernSnapshot = (await invoke('neo.snapshot', { projectId: 'book-club' })) as {
      value: { work: Array<{ id: string }> };
    };
    expect(concernSnapshot.value.work.some((item) => item.id === oldest.id)).toBe(true);
    expect(concernSnapshot.value.work.some((item) => item.id === queued.id)).toBe(true);
    const agentSnapshot = (await invoke(
      'neo.snapshot',
      {},
      { source: 'mcp', role: 'neo', sessionId: root }
    )) as {
      value: {
        work: Array<{ id: string; status: string; phase?: string; label?: string }>;
        omitted?: { work?: number };
      };
    };
    expect(agentSnapshot.value.work).toHaveLength(12);
    expect(agentSnapshot.value.work.find((item) => item.id === queued.id)).toMatchObject({
      status: 'queued',
      phase: 'handed',
    });
    expect(agentSnapshot.value.work.find((item) => item.id === oldest.id)?.phase).toBe('proposed');
    expect(agentSnapshot.value.omitted).toEqual({ work: 40 });
    for (let index = 0; index < 50; index++) {
      const item = service.repo.proposeWork({
        id: `extra-${index}`,
        requestKey: `extra-${index}`,
        projectId: 'book-club',
        originSessionId: root,
        title: 'Another decision',
        instruction: 'Draft a plan.',
      });
      sqlite.prepare('UPDATE neo_work SET created_at = ? WHERE id = ?').run(index + 3, item.id);
    }
    const boundedSnapshot = (await invoke('neo.snapshot')) as {
      value: { work: Array<{ id: string }> };
    };
    expect(boundedSnapshot.value.work).toHaveLength(100);
    expect(boundedSnapshot.value.work.some((item) => item.id === 'extra-0')).toBe(true);
    expect(boundedSnapshot.value.work.some((item) => item.id === oldest.id)).toBe(false);
    expect(boundedSnapshot.value.work.some((item) => item.id === queued.id)).toBe(false);
  });

  test('a human snapshot that asks for summaries sends the newest settled asks as summaries and reads one ask whole', async () => {
    const asks = Array.from(
      { length: 12 },
      (_, index) =>
        service.askRecords.open({
          id: `ask-${index}`,
          requestKey: `k-${index}`,
          projectId: null,
          originSessionId: 'root',
          originMessageId: `m-${index}`,
          title: `Ask ${index}`,
          ask: 'Ship it',
          doneWhen: '- shipped',
          doneSource: 'human',
        })!
    );
    for (const ask of asks.slice(1))
      service.askRecords.settle(ask, 'achieved', 'Shipped.', 'merged');
    const full = (await invoke('neo.snapshot')) as { value: { asks: NeoAsk[] } };
    expect(full.value.asks).toHaveLength(12);
    expect(full.value.asks.some((ask) => ask.summarized)).toBe(false);
    const read = (await invoke('neo.snapshot', { summaries: true })) as {
      value: { asks: NeoAsk[]; moreSettled: boolean };
    };
    expect(read.value.moreSettled).toBe(true);
    expect(read.value.asks).toHaveLength(11);
    expect(read.value.asks.find((ask) => ask.id === 'ask-0')).toMatchObject({
      ask: 'Ship it',
      doneWhen: '- shipped',
    });
    expect(read.value.asks.find((ask) => ask.id === 'ask-0')?.summarized).toBeUndefined();
    const settled = read.value.asks.filter((ask) => ask.id !== 'ask-0');
    expect(settled.every((ask) => ask.summarized && ask.doneWhen === '' && ask.ask === '')).toBe(
      true
    );
    const whole = (await invoke('neo.snapshot', { askId: settled[0].id })) as {
      value: { asks: NeoAsk[]; moreSettled?: boolean };
    };
    expect(whole.value.asks[0]).toMatchObject({ ask: 'Ship it', doneWhen: '- shipped' });
    expect(whole.value.asks[0].summarized).toBeUndefined();
    expect(whole.value.moreSettled).toBeUndefined();
  });

  test('a summarized work item carries a bounded report', async () => {
    const work = (await propose())!;
    const long = 'A quiet library room is a possible free venue. '.repeat(40);
    service.repo.transitionWork(work.id, work, { status: 'reported', report: long });
    const summary = (await invoke('neo.snapshot', { summaries: true })) as {
      value: { work: Array<{ id: string; report: string | null; summarized?: true }> };
    };
    expect(summary.value.work.find((item) => item.id === work.id)).toMatchObject({
      summarized: true,
      report: long.slice(0, 300),
    });
  });

  test('opening a missing project reports a domain rejection instead of an execution fault', async () => {
    expect(await invoke('neo.open', { projectId: 'gone' })).toMatchObject({
      value: { ok: false, reason: 'Project not found.' },
    });
    expect(created).toHaveLength(0);
  });

  test('opening replies before work discovery starts', async () => {
    const finds: unknown[] = [];
    const find = defineOperation({
      name: 'work.find',
      description: 'never settles',
      inputSchema: z.object({ limit: z.number() }),
      resultSchema: z.unknown(),
      execute: (input) => {
        finds.push(input);
        return new Promise<never>(() => {});
      },
    });
    (sessions as unknown as { getOperationRegistry: () => unknown }).getOperationRegistry = () =>
      createOperationRegistry([find]);
    const opened = (await invoke('neo.open')) as { value: { ok: boolean; sessionId: string } };
    expect(opened.value.ok).toBe(true);
    expect(created.map((params) => params.sessionId)).toEqual([opened.value.sessionId]);
    expect(finds).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(finds).toEqual([{ limit: 50 }]);
  });

  test('opening reads the snapshot after the conversation is open', async () => {
    const order: string[] = [];
    (sessions as unknown as { getOperationRegistry: () => unknown }).getOperationRegistry = () =>
      createOperationRegistry([]);
    const open = service.open.bind(service);
    service.open = async () => {
      const id = await open();
      order.push('open');
      return id;
    };
    const listProjects = service.repo.listProjects.bind(service.repo);
    service.repo.listProjects = () => {
      order.push('read');
      return listProjects();
    };
    await invoke('neo.open');
    expect(order).toEqual(['open', 'read']);
  });

  test('open names the conversation, root as the default session and every Neo session', async () => {
    service.repo.saveProject(project, 0);
    const holder = 'neo:holder';
    service.repo.reserveBinding({ sessionId: holder, kind: 'project', projectId: project.id });
    const root = await service.openDefault();
    const opened = (await invoke('neo.open', { projectId: project.id })) as {
      value: { sessionId: string; neoSessions: unknown[] };
    };
    expect(opened).toMatchObject({
      value: { sessionId: root, conversationId: root.slice(4), defaultSessionId: root },
    });
    expect(opened.value.neoSessions).toEqual(
      expect.arrayContaining([
        { sessionId: root, projectId: null },
        { sessionId: holder, projectId: project.id },
      ])
    );
    expect(service.repo.getBindingForProject('inbox')).toBeNull();
  });

  test('trusts bindings, not a claimed role; a project session reads another project', async () => {
    service.repo.saveProject(project, 0);
    service.repo.saveProject({ ...project, id: 'other', title: 'Other project' }, 0);
    const id = await service.open();
    const caller: OperationCaller = { source: 'mcp', role: 'neo', sessionId: id };
    const other = await invoke('neo.snapshot', { projectId: 'other' }, caller);
    expect(other).toMatchObject({ value: { ok: true } });
    expect(JSON.stringify(other)).toContain('Other project');
    expect(await invoke('neo.snapshot', {}, { ...caller, sessionId: 'impostor' })).toMatchObject({
      value: { ok: false },
    });
    const definitions = createNeoOperations(service);
    expect(
      listOperationSummaries(createOperationRegistry(definitions), caller, true).map(
        (item) => item.name
      )
    ).toEqual([
      'neo.project.move',
      'neo.project.section',
      'neo.message.send',
      'neo.projects.reorganize',
      'neo.publication.publish',
      'neo.publication.edit',
      'neo.publication.read',
      'neo.conversation.read',
      'neo.conversation.asks.read',
      'neo.conversation.image.read',
      'neo.draft.recover',
      'neo.preferences.set',
      'neo.todo.add',
      'neo.todo.edit',
      'neo.todo.remove',
      'neo.todo.continue',
      'neo.todo.retry',
      'neo.todo.close',
      'neo.ask.open',
      'neo.ask.settle',
      'neo.question.ask',
      'neo.question.retire',
      'neo.question.answer',
      'neo.open',
      'neo.restart',
      'neo.rule.save',
      'neo.session.mute',
      'neo.session.track',
      'neo.github.read',
      'neo.pack.read',
      'neo.snapshot',
      'neo.project.save',
    ]);
    expect(isOperationAdmitted({ ...definitions[0], name: 'session.create' }, caller)).toBe(true);
    expect(
      isOperationAdmitted(
        { ...definitions[0], name: 'session.create' },
        { source: 'mcp', role: 'universal_read' }
      )
    ).toBe(true);
    expect(service.repo.getProject('private')).toBeNull();
  });

  async function concernWork(origin?: string) {
    service.repo.saveProject(project, 0);
    const root = await service.open();
    const work = service.repo.proposeWork({
      id: crypto.randomUUID(),
      requestKey: crypto.randomUUID(),
      projectId: project.id,
      originSessionId: origin ?? root,
      targetSessionId: 'ordinary',
      title: 'Suggest venues',
      instruction: 'Suggest free venues, do not book anything.',
    });
    await service.start(work.id);
    const saved = service.repo.getWork(work.id)!;
    terminalSessions ??= new Set();
    return { work: saved, root };
  }

  test('query restriction gives Neo its tools and guard and drops plugins, settings and extra MCP servers', async () => {
    const operationServer = { type: 'stdio' as const, command: 'operations' };
    const options: Options = {
      tools: ['Bash', 'Read', 'Edit', 'Write'],
      plugins: [{ type: 'local', path: '/plugin' }],
      settingSources: ['user', 'project'],
      mcpServers: { 'hyperneo-operations': operationServer, unsafe: { command: 'other' } },
      agent: 'coder',
      agents: { coder: { description: 'work', prompt: 'work' } },
    };
    restrictNeoQuery(options, null, 'neo:runtime-test');
    expect(options.tools).toEqual(neoCoordinatorNativeTools());
    expect(options.additionalDirectories).toEqual([homedir()]);
    expect(options.mcpServers).toEqual({ 'hyperneo-operations': operationServer });
    expect(options.allowedTools).toEqual(neoCoordinatorAllowedTools());
    expect(options.plugins).toEqual([]);
    expect(options.settingSources).toEqual([]);
    expect(options.agent).toBeUndefined();
    expect(options.agents).toEqual({});
    expect(options.cwd).toBe(neoCoordinatorRuntimePath('neo:runtime-test'));
    expect(options.cwd).not.toBe(process.cwd());
    const guard = options.hooks!.PreToolUse![0].hooks[0];
    const write = (file_path: string) =>
      guard(
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Write',
          tool_input: { file_path, content: 'x' },
          tool_use_id: 'tool-1',
          session_id: 'sdk-1',
          transcript_path: '/tmp/t.jsonl',
          cwd: options.cwd!,
        } as HookInput,
        'tool-1',
        { signal: new AbortController().signal }
      );
    expect(await write(join(options.cwd!, 'check.ts'))).toEqual({});
    const bash = (command: string) =>
      guard(
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command },
          tool_use_id: 'tool-2',
          session_id: 'sdk-1',
          transcript_path: '/tmp/t.jsonl',
          cwd: options.cwd!,
        } as HookInput,
        'tool-2',
        { signal: new AbortController().signal }
      );
    expect(await bash(`rm -rf ${join(tmpdir(), 'another-process-file')}`)).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    expect(await bash('rm -f old-check.ts')).toEqual({});
    expect(await write(join(homedir(), 'focus', 'app', 'a.ts'))).toMatchObject({
      hookSpecificOutput: { additionalContext: expect.stringContaining('hand changes to a card') },
    });
  });

  test('every Neo session may create a project and revise one at its current revision', async () => {
    const root = await service.open();
    const caller: OperationCaller = {
      source: 'mcp',
      role: 'neo',
      sessionId: root,
      neoTurn: { messageId: 'ask-A', human: true, isLive: () => true },
    };
    expect(await invoke('neo.project.save', project, caller)).toMatchObject({
      value: { ok: false, reason: expect.stringContaining('Omit id') },
    });
    const { id: _named, ...fresh } = project;
    const created = await invoke('neo.project.save', fresh, caller);
    expect(created).toMatchObject({ value: { ok: true, project: { revision: 1 } } });
    const id = (created as { value: { project: { id: string } } }).value.project.id;
    expect(id).not.toBe(project.id);
    expect(await invoke('neo.project.save', fresh, caller)).toEqual(created);
    expect(service.repo.listProjects()).toHaveLength(1);
    const correction = { ...project, id, expectedRevision: 1, context: 'Host at my home' };
    expect(await invoke('neo.project.save', correction, caller)).toMatchObject({
      value: { ok: true, project: { context: correction.context, revision: 2 } },
    });
    const holder = await service.open();
    expect(
      await invoke('neo.project.save', { ...fresh, title: 'Another' }, holderInput(holder))
    ).toMatchObject({ value: { ok: true, project: { title: 'Another', revision: 1 } } });
    const moved = { ...correction, expectedRevision: 2, context: 'Host at the café' };
    expect(await invoke('neo.project.save', moved, holderInput(holder))).toMatchObject({
      value: { ok: true, project: { context: moved.context, revision: 3 } },
    });
    expect(
      await invoke('neo.project.save', { ...correction, expectedRevision: 3 }, human)
    ).toMatchObject({ value: { ok: true } });
  });
});
