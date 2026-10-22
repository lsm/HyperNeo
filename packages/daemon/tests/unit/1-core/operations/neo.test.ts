import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { z } from 'zod';

import type { MessageHub } from '@hyperneo/shared';
import type { NeoAsk } from '@hyperneo/shared/types/neo-snapshot';
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
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import { neoCoordinatorBinding } from '../../../../src/lib/neo/session-policy.ts';
import { neoFolderPath } from '../../../../src/lib/neo/folder.ts';
import {
  createOperationRegistry,
  defineOperation,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import { invokeOperation, isOperationAdmitted } from '../../../../src/lib/operations/invoke.ts';
import { listOperationSummaries } from '../../../../src/lib/operations/discovery.ts';
import { QueryAttemptRegistry } from '../../../../src/lib/agent/query-attempt-token.ts';
import { createOperationMcpHandler } from '../../../../src/lib/operations/mcp-adapter.ts';

const human: OperationCaller = { source: 'rpc', principal: 'local' };
const project = {
  id: 'book-club',
  title: 'Book club',
  summary: 'Sunday afternoons',
  context: 'Six people, free venue',
  expectedRevision: 0,
};

describe('Neo MVP', () => {
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
      getOperationRegistry: () => createOperationRegistry([]),
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
      input,
      caller
    );
  }
  function holderInput(sessionId: string): OperationCaller {
    return {
      source: 'mcp',
      role: 'neo',
      sessionId,
    };
  }
  test('opening is idempotent, independent of project creation and creates ordinary sessions with a Neo prompt', async () => {
    const ids = await Promise.all([service.open(), service.open(), service.open()]);
    expect(new Set(ids).size).toBe(1);
    expect(created).toHaveLength(1);
    expect(created[0].config).toMatchObject({
      systemPrompt: expect.stringContaining('You are Neo'),
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
      systemPrompt: expect.stringContaining('You are Neo'),
    });
    expect(await invoke('neo.snapshot')).toMatchObject({
      value: { projects: [{ context: project.context }] },
    });
    const root = await service.open();
    expect(
      await invoke('neo.snapshot', {}, { source: 'mcp', role: 'neo', sessionId: root })
    ).toMatchObject({ value: { projects: [{ context: '' }] } });
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

  test('standing rules start empty, the human adds them, and Neo needs a received human citation', async () => {
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
    ).toMatchObject({ value: { ok: false, reason: expect.stringContaining('human') } });
    expect(settings.neo?.standingRules).toEqual(rules);
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

  test('open names the conversation and returns root for any project', async () => {
    service.repo.saveProject(project, 0);
    const root = await service.openDefault();
    expect(await invoke('neo.open', { projectId: project.id })).toMatchObject({
      value: { sessionId: root, conversationId: root.slice(4) },
    });
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
    expect(
      await invoke('neo.ask.doneTodos', { askId: 'missing' }, { ...caller, sessionId: 'impostor' })
    ).toMatchObject({ value: { ok: false, reason: 'This operation belongs to Neo.' } });
    expect(await invoke('neo.ask.doneTodos', { askId: 'missing' }, caller)).toMatchObject({
      value: { ok: false, reason: 'not_found: no such ask.' },
    });
    const definitions = createNeoOperations(service);
    expect(
      listOperationSummaries(createOperationRegistry(definitions), caller, true).map(
        (item) => item.name
      )
    ).toEqual([
      'neo.project.move',
      'neo.project.section',
      'neo.project.forget',
      'neo.message.send',
      'neo.projects.reorganize',
      'neo.publication.publish',
      'neo.publication.edit',
      'neo.publication.read',
      'neo.conversation.read',
      'neo.conversation.asks.read',
      'neo.conversation.image.read',
      'neo.draft.recover',
      'neo.rule.ask',
      'neo.rule.applyAnswer',
      'pack.preferences.ask',
      'pack.preferences.applyAnswer',
      'neo.preferences.set',
      'pack.preferences.get',
      'pack.preferences.list',
      'neo.todo.add',
      'neo.todo.edit',
      'neo.todo.remove',
      'neo.todo.continue',
      'neo.todo.retry',
      'neo.todo.close',
      'neo.ask.doneTodos',
      'neo.ask.open',
      'neo.ask.settle',
      'neo.question.ask',
      'neo.question.retire',
      'neo.question.get',
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

  test('every Neo session may create a project and revise one at its current revision', async () => {
    const root = await service.open();
    const caller: OperationCaller = {
      source: 'mcp',
      role: 'neo',
      sessionId: root,
    };
    expect(await invoke('neo.project.save', project, caller)).toMatchObject({
      value: { ok: false, reason: expect.stringContaining('Omit id') },
    });
    const { id: _named, ...fresh } = project;
    const created = await invoke('neo.project.save', fresh, caller);
    expect(created).toMatchObject({ value: { ok: true, project: { revision: 1 } } });
    const id = (created as { value: { project: { id: string } } }).value.project.id;
    expect(id).not.toBe(project.id);
    const another = await invoke('neo.project.save', fresh, caller);
    expect(another).toMatchObject({ value: { ok: true } });
    expect((another as { value: { project: { id: string } } }).value.project.id).not.toBe(id);
    expect(service.repo.listProjects()).toHaveLength(2);
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
