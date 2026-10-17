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
import { CONSULTATION_STOPPED } from '../../../../src/lib/neo/consultation-policy.ts';
import { neoPrompt } from '../../../../src/lib/neo/prompt.ts';
import { NeoHolderTurn } from '../../../../src/lib/neo/holder-turn.ts';
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
  test('root prompt requires real todos and honors explicit context retention', () => {
    const prompt = neoPrompt(null);
    expect(prompt).toContain('permission to create its record now');
    expect(prompt).toContain('open the ask with its todos in that turn without start');
    expect(prompt).toContain('never describe a pretend todo');
    expect(prompt).toContain('no implicit project, workspace, folder, repository or worktree');
    expect(prompt).toContain('wait for needed facts or ask for genuinely missing information');
    expect(prompt).toContain('Apply them whenever you add todos and write doneWhen');
    expect(prompt).toContain('neo.rule.save {add?,remove?,from}');
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
        listQueuedSystemInputs: () => [],
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
  function holderInput(sessionId: string, consultationId?: string): OperationCaller {
    return {
      source: 'mcp',
      role: 'neo',
      sessionId,
      neoTurn: {
        messageId: consultationId ? `neo-consult:${consultationId}:request` : 'human-message',
        consultationId,
        human: !consultationId,
        isLive: () => true,
      },
    };
  }
  async function propose() {
    const root = await service.open(null);
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
    const ids = await Promise.all([service.open(null), service.open(null), service.open(null)]);
    expect(new Set(ids).size).toBe(1);
    expect(created).toHaveLength(1);
    expect(created[0].config).toMatchObject({
      permissionMode: 'dontAsk',
      sdkToolsPreset: neoCoordinatorNativeTools(),
      allowedTools: neoCoordinatorAllowedTools(),
    });
    expect(created[0]).toMatchObject({ workspacePath: neoFolderPath(), detectGit: false });
    expect(service.repo.listProjects()).toEqual([]);
    expect(await service.open(null)).toBe(ids[0]);
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
    const id = await service.open(project.id);
    expect(await service.open(project.id)).toBe(id);
    expect(created[0].config).toMatchObject({
      sdkToolsPreset: neoCoordinatorNativeTools(),
      allowedTools: neoCoordinatorAllowedTools(),
    });
    expect(await invoke('neo.snapshot')).toMatchObject({
      value: { projects: [{ context: project.context }] },
    });
    const root = await service.open(null);
    expect(
      await invoke('neo.snapshot', {}, { source: 'mcp', role: 'neo', sessionId: root })
    ).toMatchObject({ value: { projects: [{ context: '' }] } });
  });

  test('a holder session title follows its project title', async () => {
    service.repo.saveProject(project, 0);
    const id = await service.open(project.id);
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
    const root = await service.open(null);
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
    const holder = await service.open('book-club');
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
    const root = await service.open(null);
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
    const root = await service.open(null);
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
    const root = await service.open(null);
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

  test('a summarized work item or consultation reads back whole by its id', async () => {
    const work = (await propose())!;
    const long = 'A quiet library room is a possible free venue. '.repeat(40);
    service.repo.transitionWork(work.id, work, { status: 'reported', report: long });
    service.repo.saveProject(project, 0);
    const root = await service.open(null);
    const consultation = service.consultations.reserve({
      id: 'c1',
      requestKey: 'c1',
      projectId: project.id,
      originSessionId: root,
      sessionId: 'holder',
      question: 'Which venues are free? '.repeat(40),
    })!;
    service.consultations.finish(consultation.id, 'reported', 'The library. '.repeat(60));
    const summary = (await invoke('neo.snapshot', { summaries: true })) as {
      value: {
        work: Array<{ id: string; report: string | null; summarized?: true }>;
        consultations: Array<{ id: string; answer: string | null; summarized?: true }>;
      };
    };
    expect(summary.value.work.find((item) => item.id === work.id)).toMatchObject({
      summarized: true,
      report: long.slice(0, 300),
    });
    expect(summary.value.consultations[0]?.summarized).toBe(true);
    expect(await invoke('neo.receipt.read', { workId: work.id })).toMatchObject({
      value: { ok: true, work: { id: work.id, report: long, instruction: work.instruction } },
    });
    expect(await invoke('neo.receipt.read', { consultationId: 'c1' })).toMatchObject({
      value: {
        ok: true,
        consultation: {
          id: 'c1',
          question: consultation.question,
          answer: 'The library. '.repeat(60),
        },
      },
    });
    expect(await invoke('neo.receipt.read', { workId: 'gone' })).toMatchObject({
      value: { ok: false, reason: 'Receipt not found.' },
    });
    expect(
      await invoke('neo.receipt.read', { workId: work.id }, { source: 'mcp', sessionId: root })
    ).toMatchObject({ value: { ok: false, reason: 'This action needs the user.' } });
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
    service.open = async (projectId) => {
      const id = await open(projectId);
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

  test('open names the conversation, the default session and every Neo session', async () => {
    service.repo.saveProject(project, 0);
    const holder = await service.open(project.id);
    const inbox = await service.openDefault();
    const opened = (await invoke('neo.open')) as {
      value: { sessionId: string; neoSessions: unknown[] };
    };
    const root = opened.value.sessionId;
    expect(opened).toMatchObject({
      value: { conversationId: root.slice(4), defaultSessionId: inbox },
    });
    expect(opened.value.neoSessions).toHaveLength(3);
    expect(opened.value.neoSessions).toEqual(
      expect.arrayContaining([
        { sessionId: root, projectId: null },
        { sessionId: holder, projectId: project.id },
        { sessionId: inbox, projectId: 'inbox' },
      ])
    );
  });

  test('trusts bindings, not a claimed role; a project session reads another project', async () => {
    service.repo.saveProject(project, 0);
    service.repo.saveProject({ ...project, id: 'other', title: 'Other project' }, 0);
    const id = await service.open(project.id);
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
      'neo.projects.dispatch',
      'neo.message.send',
      'neo.projects.reorganize',
      'neo.publication.publish',
      'neo.publication.edit',
      'neo.route.correct',
      'neo.route.failure',
      'neo.inbox.promote',
      'neo.ask.forward',
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
      'neo.question.answer',
      'neo.project.cancel',
      'neo.project.consult',
      'neo.project.respond',
      'neo.open',
      'neo.receipt.read',
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
    const root = await service.open(null);
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

  async function consultation() {
    service.repo.saveProject(project, 0);
    const root = await service.open(null);
    const caller = holderInput(root);
    const input = {
      projectId: project.id,
      requestKey: 'ask-once',
      question: 'What venue fits our constraints?',
    };
    expect(await invoke('neo.project.consult', input, caller)).toMatchObject({
      kind: 'completed',
      value: { ok: true, consultation: { status: 'pending' } },
    });
    const item = service.consultations.list()[0];
    const holder: OperationCaller = { source: 'mcp', role: 'neo', sessionId: item.sessionId };
    return { item, caller, holder, input };
  }

  test('correlates unrelated root inputs through durable consultation returns', async () => {
    service.repo.saveProject(project, 0);
    service.repo.saveProject({ ...project, id: 'research' }, 0);
    const root = await service.open(null);
    const caller = (messageId: string): OperationCaller => ({
      ...holderInput(root),
      neoTurn: { messageId, human: true, isLive: () => true },
    });
    const input = { projectId: project.id, requestKey: 'first', question: 'Next?' };
    expect(
      await invoke('neo.project.consult', { ...input, originMessageId: 'forged' }, caller('ask-A'))
    ).toMatchObject({ value: { consultation: { originMessageId: 'ask-A' } } });
    expect(
      await invoke(
        'neo.project.consult',
        { ...input, projectId: 'research', requestKey: 'second' },
        caller('ask-B')
      )
    ).toMatchObject({ value: { consultation: { originMessageId: 'ask-B' } } });
    await invoke('neo.project.consult', input, caller('ask-A'));
    expect(service.consultations.list()).toHaveLength(2);
    expect(service.repo.listWork()).toEqual([]);
    for (const item of service.consultations.list()) {
      expect(
        JSON.stringify(
          jobs.find((job) => job.payload.messageUuid === `neo-consult:${item.id}:request`)
        )
      ).toContain(item.originMessageId);
      await invoke(
        'neo.project.respond',
        { id: item.id, answer: `Answer ${item.originMessageId}` },
        holderInput(item.sessionId, item.id)
      );
      expect(
        JSON.stringify(
          jobs.find((job) => job.payload.messageUuid === `neo-consult:${item.id}:reply`)
        )
      ).toContain(item.originMessageId);
    }
    await service.recover();
    expect(jobs).toHaveLength(4);
    expect(await invoke('neo.snapshot', {}, human)).toMatchObject({
      value: {
        consultations: expect.arrayContaining([
          expect.objectContaining({ originMessageId: 'ask-A', status: 'reported' }),
          expect.objectContaining({ originMessageId: 'ask-B', status: 'reported' }),
        ]),
      },
    });
  });

  test('the same question from another input asks again instead of borrowing the earlier receipt', async () => {
    const { item, caller, holder, input } = await consultation();
    await invoke('neo.project.respond', { id: item.id, answer: 'A result' }, holder);
    const unrelated: OperationCaller = {
      ...caller,
      neoTurn: { messageId: 'ask-B', human: true, isLive: () => true },
    };
    const again = await invoke('neo.project.consult', input, unrelated);
    expect(again).toMatchObject({
      value: { ok: true, consultation: { originMessageId: 'ask-B', answer: null } },
    });
    expect((again as { value: { consultation: { id: string } } }).value.consultation.id).not.toBe(
      item.id
    );
    expect(service.consultations.get(item.id)).toEqual({
      ...item,
      status: 'reported',
      answer: 'A result',
    });
  });

  test('MCP consultations use the isolated runtime input despite forged provenance', async () => {
    service.repo.saveProject(project, 0);
    service.repo.saveProject({ ...project, id: 'research' }, 0);
    const root = await service.open(null);
    const attempts = new QueryAttemptRegistry();
    const first = new NeoHolderTurn(db, root, attempts.allocate());
    const turns = [first];
    const registry = createOperationRegistry(createNeoOperations(service));
    const handler = (current: NeoHolderTurn) =>
      createOperationMcpHandler(registry, () => ({
        sessionId: root,
        role: 'neo',
        neoTurn: current.identity(),
      }));
    const request = {
      name: 'neo.project.consult',
      input: {
        projectId: project.id,
        requestKey: 'first',
        question: 'Next?',
        originMessageId: 'forged',
        neoTurn: { messageId: 'forged', human: true },
      },
      caller: { source: 'rpc', principal: 'local', neoTurn: { messageId: 'forged' } },
    };
    try {
      first.bind('ask-A');
      const result = await handler(first)(request);
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        ok: true,
        consultation: { originMessageId: 'ask-A', originSessionId: root },
      });
      const next = new NeoHolderTurn(db, root, attempts.allocate());
      turns.push(next);
      next.bind('ask-B');
      const independent = {
        ...request,
        input: { ...request.input, projectId: 'research', requestKey: 'second' },
      };
      expect(JSON.parse((await handler(first)(independent)).content[0].text)).toMatchObject({
        ok: false,
      });
      expect(JSON.parse((await handler(next)(independent)).content[0].text)).toMatchObject({
        ok: true,
        consultation: { originMessageId: 'ask-B' },
      });
      expect(service.consultations.list()).toHaveLength(2);
      expect(jobs).toHaveLength(2);
      expect(service.repo.listWork()).toEqual([]);
    } finally {
      turns.forEach((current) => current.dispose());
    }
  });

  test('an unbound root cannot create a consultation', async () => {
    service.repo.saveProject(project, 0);
    const root = await service.open(null);
    expect(
      await invoke(
        'neo.project.consult',
        {
          projectId: project.id,
          requestKey: 'unbound',
          question: 'Next?',
        },
        { source: 'mcp', role: 'neo', sessionId: root }
      )
    ).toMatchObject({ value: { ok: false } });
    expect(service.consultations.list()).toEqual([]);
    expect(created).toHaveLength(1);
    expect(jobs).toEqual([]);
  });

  test('superseding the input during holder opening prevents reservation and delivery', async () => {
    service.repo.saveProject(project, 0);
    const root = await service.open(null);
    let live = true;
    let opened!: () => void;
    let release!: () => void;
    const opening = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = service.open.bind(service);
    service.open = async (id) => {
      const sessionId = await original(id);
      opened();
      await held;
      return sessionId;
    };
    const result = invoke(
      'neo.project.consult',
      {
        projectId: project.id,
        requestKey: 'late',
        question: 'Next?',
      },
      {
        source: 'mcp',
        role: 'neo',
        sessionId: root,
        neoTurn: { messageId: 'ask-A', human: true, isLive: () => live },
      }
    );
    await opening;
    live = false;
    release();
    expect(await result).toMatchObject({ value: { ok: false } });
    expect(service.consultations.list()).toEqual([]);
    expect(jobs).toEqual([]);
  });

  test('consults the persistent holder once, returns through the mailbox, and starts no worker', async () => {
    const { item, caller, holder, input } = await consultation();
    await Promise.all([
      invoke('neo.project.consult', input, caller),
      invoke('neo.project.consult', input, caller),
    ]);
    expect(service.consultations.list()).toHaveLength(1);
    expect(service.repo.listWork()).toHaveLength(0);
    expect(created).toHaveLength(2);
    expect(service.repo.getBindingBySession(item.sessionId)?.kind).toBe('project');
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload).toMatchObject({
      to: { sessionId: item.sessionId },
      messageUuid: `neo-consult:${item.id}:request`,
    });
    expect(JSON.stringify(jobs[0].payload)).toContain(input.question);
    const answer = 'Use a free living room on Sunday. No booking has been made.';
    expect(await invoke('neo.project.respond', { id: item.id, answer }, holder)).toMatchObject({
      value: { ok: true, consultation: { status: 'reported', answer } },
    });
    expect(jobs).toHaveLength(2);
    expect(jobs[1].payload).toMatchObject({
      to: { sessionId: caller.sessionId },
      messageUuid: `neo-consult:${item.id}:reply`,
    });
    expect(JSON.stringify(jobs[1].payload)).toContain(answer);
    await invoke('neo.project.respond', { id: item.id, answer }, holder);
    await service.recover();
    expect(jobs).toHaveLength(2);
    expect(service.consultations.unsettled()).toEqual([]);
    expect(
      await invoke('neo.project.respond', { id: item.id, answer: 'Overwrite' }, holder)
    ).toMatchObject({
      value: { ok: true, replyGuidance: expect.stringContaining('Already settled') },
    });
    expect(service.consultations.get(item.id)?.answer).toBe(answer);
    expect(created).toHaveLength(2);
  });

  test('rechecks the immutable input inside receipt persistence before any queue write', async () => {
    service.repo.saveProject(project, 0);
    const root = await service.open(null);
    let checks = 0;
    const source: OperationCaller = {
      ...holderInput(root),
      neoTurn: { messageId: 'ask-B', human: true, isLive: () => ++checks < 2 },
    };
    expect(
      await invoke(
        'neo.project.consult',
        { projectId: project.id, requestKey: 'B', question: 'Correction B' },
        source
      )
    ).toMatchObject({ value: { ok: false } });
    expect(checks).toBe(2);
    expect(service.consultationWaiters.queued()).toEqual([]);
    expect(service.consultations.list()).toEqual([]);
    expect(jobs).toEqual([]);
  });

  test('admits Neo sessions’ consultations and attributes replies to the exact assigned holder', async () => {
    const { item, caller, holder, input } = await consultation();
    service.repo.saveProject({ ...project, id: 'private' }, 0);
    const other = await service.open('private');
    service.repo.reserveBinding({ sessionId: 'worker', projectId: project.id, kind: 'worker' });
    for (const denied of [
      human,
      { ...caller, sessionId: 'worker' },
      { ...caller, sessionId: 'impostor' },
    ]) {
      expect(await invoke('neo.project.consult', input, denied)).toMatchObject({
        value: { ok: false },
      });
    }
    for (const denied of [
      human,
      caller,
      { ...holder, sessionId: other },
      { ...holder, sessionId: 'worker' },
      { ...holder, sessionId: 'impostor' },
    ]) {
      expect(
        await invoke('neo.project.respond', { id: item.id, answer: 'Forged' }, denied)
      ).toMatchObject({ value: { ok: false } });
    }
    expect(service.consultations.get(item.id)?.status).toBe('pending');
    expect(jobs).toHaveLength(1);
    expect(await invoke('neo.snapshot', {}, { ...holder, sessionId: other })).toMatchObject({
      value: { consultations: [] },
    });
    expect(await invoke('neo.snapshot', {}, caller)).toMatchObject({
      value: { consultations: [{ question: '', answer: null }] },
    });
    expect(await invoke('neo.snapshot', { projectId: project.id }, caller)).toMatchObject({
      value: { projects: [{ context: '' }], consultations: [{ question: '', answer: null }] },
    });
    expect(await invoke('neo.snapshot', {}, holder)).toMatchObject({
      value: { consultations: [{ question: input.question }] },
    });
  });

  test('queues a changed question separately and refuses an unknown project', async () => {
    const { item, caller, input } = await consultation();
    expect(
      await invoke('neo.project.consult', { ...input, projectId: 'missing' }, caller)
    ).toMatchObject({ value: { ok: false } });
    expect(service.consultations.list()).toEqual([item]);
    expect(jobs).toHaveLength(1);
    const changed = { ...input, question: 'Changed question' };
    const queued = await invoke('neo.project.consult', changed, caller);
    expect(queued).toMatchObject({ value: { ok: true, waiter: { status: 'queued' } } });
    expect(await invoke('neo.project.consult', changed, caller)).toEqual(queued);
    expect(service.consultations.list()).toEqual([item]);
    expect(jobs).toHaveLength(1);
  });

  test('recovers undelivered requests and finished replies across service restart', async () => {
    const { item } = await consultation();
    jobs = [];
    service.dispose();
    service = new NeoService(
      db,
      sessions,
      { event: mock(() => {}) } as unknown as MessageHub,
      events
    );
    await service.recover();
    expect(jobs).toHaveLength(1);
    delivered.add(`${item.sessionId}:neo-consult:${item.id}:request`);
    jobs = [];
    await service.recover();
    expect(jobs).toHaveLength(0);
    service.consultations.finish(item.id, 'reported', 'Recovered answer');
    await service.recover();
    expect(jobs).toHaveLength(1);
    expect(JSON.stringify(jobs[0].payload)).toContain('Recovered answer');
    await service.recover();
    expect(jobs).toHaveLength(1);
  });

  test.each([null, 'error_max_turns'])(
    'returns an explicit failure when the holder ends without responding (%s)',
    async (failure) => {
      const { item, holder } = await consultation();
      await service.syncConsultation(item.id);
      expect(service.consultations.get(item.id)?.status).toBe('pending');
      terminal = true;
      failed = failure;
      await events.publish('session.updated', {
        sessionId: item.sessionId,
        processingState: { status: 'idle' },
      });
      expect(service.consultations.get(item.id)).toMatchObject({
        status: 'failed',
        answer: expect.any(String),
      });
      expect(jobs).toHaveLength(2);
      expect(
        await invoke('neo.project.respond', { id: item.id, answer: 'Late reply' }, holder)
      ).toMatchObject({
        value: { ok: true, replyGuidance: expect.stringContaining('Already settled') },
      });
      expect(jobs).toHaveLength(2);
    }
  );

  test('bounds questions and responses before they enter durable context', async () => {
    const { item, caller, holder, input } = await consultation();
    expect(
      await invoke('neo.project.consult', { ...input, question: 'x'.repeat(8001) }, caller)
    ).toMatchObject({ kind: 'failed', code: 'invalid_input' });
    expect(
      await invoke('neo.project.respond', { id: item.id, answer: 'x'.repeat(4001) }, holder)
    ).toMatchObject({ kind: 'failed', code: 'invalid_input' });
    expect(service.consultations.get(item.id)?.status).toBe('pending');
  });

  test('every Neo session may create a project and revise one at its current revision', async () => {
    const root = await service.open(null);
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
    const holder = await service.open(id);
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

  test('only the human can stop waiting, without interrupting the shared holder session', async () => {
    const { item, caller, holder } = await consultation();
    for (const denied of [caller, holder]) {
      expect(await invoke('neo.project.cancel', { id: item.id }, denied)).toMatchObject({
        kind: 'completed',
        value: { ok: false, reason: 'This action needs the user.' },
      });
    }
    expect(
      await invoke('neo.project.cancel', { id: item.id }, { source: 'rpc', principal: 'remote' })
    ).toMatchObject({ value: { ok: false } });
    expect(service.consultations.get(item.id)?.status).toBe('pending');
    const request = jobs[0];
    const unrelated = {
      payload: { to: { sessionId: item.sessionId }, messageUuid: 'human-follow-up' },
    };
    jobs.push(unrelated);
    expect(await invoke('neo.project.cancel', { id: item.id })).toMatchObject({
      value: { ok: true, consultation: { status: 'failed', answer: CONSULTATION_STOPPED } },
    });
    await invoke('neo.project.cancel', { id: item.id });
    await service.recoverConsultations();
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toBe(request);
    expect(jobs[1]).toBe(unrelated);
    expect(JSON.stringify(jobs[2])).toContain(CONSULTATION_STOPPED);
    expect(interrupt).not.toHaveBeenCalled();
    expect(service.repo.getProject(project.id)?.context).toBe(project.context);
    expect(
      await invoke('neo.project.respond', { id: item.id, answer: 'Late' }, holder)
    ).toMatchObject({
      value: { ok: true, replyGuidance: expect.stringContaining('Already settled') },
    });
    expect(await invoke('neo.project.cancel', { id: 'missing' })).toMatchObject({
      value: { ok: false },
    });
  });

  test('old consultations survive recovery and return their late answer once', async () => {
    const { item, caller, input, holder } = await consultation();
    sqlite.prepare('UPDATE neo_consultations SET created_at = 0 WHERE id = ?').run(item.id);
    await service.recoverConsultations();
    expect(service.consultations.get(item.id)).toMatchObject({ status: 'pending', answer: null });
    expect(jobs).toHaveLength(1);
    expect(await invoke('neo.project.consult', input, caller)).toMatchObject({
      value: { ok: true, consultation: { id: item.id, status: 'pending' } },
    });
    expect(
      await invoke('neo.project.respond', { id: item.id, answer: 'Still useful' }, holder)
    ).toMatchObject({
      value: { ok: true, consultation: { status: 'reported', answer: 'Still useful' } },
    });
    await service.recoverConsultations();
    expect(jobs).toHaveLength(2);
    expect(interrupt).not.toHaveBeenCalled();
  });

  test('accepts an old answer before recovery runs', async () => {
    const { item, holder } = await consultation();
    sqlite.prepare('UPDATE neo_consultations SET created_at = 0 WHERE id = ?').run(item.id);
    expect(
      await invoke('neo.project.respond', { id: item.id, answer: 'Still useful' }, holder)
    ).toMatchObject({
      value: { ok: true, consultation: { status: 'reported', answer: 'Still useful' } },
    });
    expect(JSON.stringify(jobs[1])).toContain('Still useful');
  });

  test('stopping or recovering a completed request cannot replace its answer', async () => {
    const { item, holder } = await consultation();
    await invoke('neo.project.respond', { id: item.id, answer: 'Timely answer' }, holder);
    sqlite.prepare('UPDATE neo_consultations SET created_at = 0 WHERE id = ?').run(item.id);
    await invoke('neo.project.cancel', { id: item.id });
    await service.recoverConsultations();
    expect(service.consultations.get(item.id)).toMatchObject({
      status: 'reported',
      answer: 'Timely answer',
    });
    expect(jobs).toHaveLength(2);
  });

  test('a concurrent answer and stop settle once with one consistent return', async () => {
    const { item, holder } = await consultation();
    await Promise.all([
      invoke('neo.project.respond', { id: item.id, answer: 'Answer' }, holder),
      invoke('neo.project.cancel', { id: item.id }),
    ]);
    const settled = service.consultations.get(item.id)!;
    expect(['reported', 'failed']).toContain(settled.status);
    expect(settled.answer).toBe(settled.status === 'reported' ? 'Answer' : CONSULTATION_STOPPED);
    expect(jobs).toHaveLength(2);
    expect(JSON.stringify(jobs[1])).toContain(settled.answer!);
    await service.recoverConsultations();
    expect(jobs).toHaveLength(2);
  });
});
