import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import type { MessageHub, Session, SessionConfig } from '@hyperneo/shared';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import { AgentSession } from '../../../../src/lib/agent/agent-session.ts';
import { QueryOptionsBuilder } from '../../../../src/lib/agent/query-options-builder.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import { NeoHolderTurn } from '../../../../src/lib/neo/holder-turn.ts';
import { neoPrompt } from '../../../../src/lib/neo/prompt.ts';
import { neoConsultationRequestContent } from '../../../../src/lib/neo/consultation-request-content.ts';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

const conversationId = '10000000-0000-4000-8000-000000000001';
const root = `neo:${conversationId}`;
const holder = 'neo:holder:fictional-runtime';
const requestId = 'neo-consult:check:request';
const draft = {
  publicationId: '20000000-0000-4000-8000-000000000001',
  shortText: 'The fictional plan is current.',
  fullText: '**Plan B** replaced the old plan. External completion is not verified.',
  links: [{ kind: 'consultation' as const, id: 'check', label: 'View comparison' }],
};

describe('published consultation runtime activation', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let service: NeoService;
  let events: InternalEventBus<DaemonInternalEventMap>;
  const hub = { event: vi.fn() } as unknown as MessageHub;
  const agents: AgentSession[] = [];
  const turns: NeoHolderTurn[] = [];
  const createSession = vi.fn(async (input: { sessionId: string; config: SessionConfig }) => {
    const session = { ...createTestSession(input.sessionId), config: input.config };
    db.createSession(session);
    return session;
  });
  const sessions = { createSession, getSessionAsync: vi.fn() } as unknown as SessionManager;
  const startService = (format: 'legacy' | 'published' = 'published') => {
    service?.dispose();
    service = new NeoService(db, sessions, hub, events, format);
  };
  const savePrompt = (sessionId: string, messageId: string, content: string, human = false) =>
    db.getSDKMessageRepo().saveSDKMessage(sessionId, {
      type: 'user',
      uuid: messageId,
      session_id: sessionId,
      parent_tool_use_id: null,
      inputKind: human ? 'human' : 'system',
      message: { role: 'user', content },
    } as SDKUserMessage);
  const reserve = () =>
    service.consultations.reserve({
      id: 'check',
      requestKey: 'check',
      concernId: 'fictional',
      originSessionId: root,
      originMessageId: 'original-ask',
      sessionId: holder,
      question: 'Compare fictional plans.',
    })!;
  const mailbox = (sessionId: string) =>
    db.getJobQueueRepo().listActiveByPayload('mailbox', { 'to.sessionId': sessionId });
  beforeEach(async () => {
    db = await createTestDb();
    events = new InternalEventBus();
    createSession.mockClear();
    for (const id of [root, holder]) db.createSession(createTestSession(id));
    startService();
    service.repo.saveConcern({ id: 'fictional', title: 'Plans', summary: '', context: '' }, 0);
    service.repo.reserveBinding({ sessionId: root, concernId: null, kind: 'neo' });
    service.repo.reserveBinding({ sessionId: holder, concernId: 'fictional', kind: 'concern' });
    savePrompt(root, 'original-ask', 'Compare fictional plans.', true);
  });
  afterEach(async () => {
    for (const agent of agents.splice(0)) await agent.cleanup();
    for (const turn of turns.splice(0)) turn.dispose();
    service.dispose();
    db.close();
    vi.restoreAllMocks();
  });

  test('delivers the published instructions through the real durable mailbox exactly once', async () => {
    const item = reserve();
    const sdkBefore = db.getDatabase().prepare('SELECT * FROM sdk_messages').all();
    await service.syncConsultation(item.id);
    const jobs = mailbox(holder);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload).toMatchObject({
      messageUuid: requestId,
      origin: `session:${encodeURIComponent(root)}`,
      message: {
        inputKind: 'system',
        message: {
          role: 'user',
          content: neoConsultationRequestContent(item, 'published'),
        },
      },
    });
    await service.recoverConsultations();
    startService();
    await service.syncConsultation(item.id);
    expect(mailbox(holder)).toEqual(jobs);
    expect(mailbox(root)).toEqual([]);
    expect(db.getDatabase().prepare('SELECT * FROM sdk_messages').all()).toEqual(sdkBefore);
    expect(db.getDatabase().prepare('SELECT * FROM neo_publications').all()).toEqual([]);
    expect(createSession).not.toHaveBeenCalled();
  });

  test('preserves a legacy queued request verbatim across activation and recovery', async () => {
    startService('legacy');
    const item = reserve();
    await service.syncConsultation(item.id);
    const queued = mailbox(holder);
    expect(queued[0].payload).toMatchObject({
      message: {
        message: {
          content: neoConsultationRequestContent(item),
        },
      },
    });
    startService();
    await service.recoverConsultations();
    expect(mailbox(holder)).toEqual(queued);
    expect(service.consultations.get(item.id)).toEqual(item);
    service.consultations.finish(item.id, 'reported', 'Older legacy answer.');
    await service.syncConsultation(item.id);
    expect(mailbox(root)).toHaveLength(1);
    expect(JSON.stringify(mailbox(root)[0].payload)).toContain('Older legacy answer.');
    expect(db.getDatabase().prepare('SELECT * FROM neo_publications').all()).toEqual([]);
  });

  test('keeps an already consumed legacy request on its original return path', async () => {
    const item = reserve();
    savePrompt(holder, requestId, neoConsultationRequestContent(item));
    await service.recoverConsultations();
    expect(mailbox(holder)).toEqual([]);
    const turn = new NeoHolderTurn(db, holder, { isLive: () => true }, () => {});
    turns.push(turn);
    expect(turn.bind(requestId)).toBe(true);
    const answer = await invokeOperation(
      createOperationRegistry(createNeoOperations(service)),
      'neo.concern.respond',
      { id: item.id, answer: 'Legacy answer after restart.' },
      { source: 'mcp', sessionId: holder, role: 'neo', neoTurn: turn.identity() }
    );
    expect(answer).toMatchObject({ kind: 'completed', value: { ok: true } });
    await service.syncConsultation(item.id);
    expect(mailbox(root)).toHaveLength(1);
    expect(JSON.stringify(mailbox(root)[0].payload)).toContain('Legacy answer after restart.');
  });

  test('commits the same authored tuple and original ask without another root query', async () => {
    const item = reserve();
    await service.syncConsultation(item.id);
    savePrompt(holder, requestId, neoConsultationRequestContent(item, 'published'));
    savePrompt(root, 'unrelated-newer-ask', 'An unrelated fictional question.', true);
    const turn = new NeoHolderTurn(db, holder, { isLive: () => true }, () => {});
    turns.push(turn);
    expect(turn.bind(requestId)).toBe(true);
    const registry = createOperationRegistry(createNeoOperations(service));
    const caller = {
      source: 'mcp' as const,
      sessionId: holder,
      role: 'neo' as const,
      neoTurn: turn.identity(),
    };
    expect(await invokeOperation(registry, 'neo.publication.publish', draft, caller)).toMatchObject(
      {
        kind: 'completed',
        value: { accepted: true, created: true },
      }
    );
    expect(await invokeOperation(registry, 'neo.publication.publish', draft, caller)).toMatchObject(
      {
        kind: 'completed',
        value: { accepted: true, created: false },
      }
    );
    await service.syncConsultation(item.id);
    expect(service.publications.get(conversationId, draft.publicationId)).toMatchObject({
      ...draft,
      askOrigin: { sessionId: root, messageId: 'original-ask' },
      producerInput: { sessionId: holder, messageId: requestId },
    });
    expect(mailbox(root)).toEqual([]);
    expect(
      db.getDatabase().prepare('SELECT returned FROM neo_consultations WHERE id = ?').get(item.id)
    ).toEqual({ returned: 1 });
    startService();
    await service.recoverConsultations();
    expect(mailbox(root)).toEqual([]);
    expect(db.getDatabase().prepare('SELECT * FROM neo_publications').all()).toHaveLength(1);
  });

  test.each([null, 'fictional'])(
    'creates the %j coordinator with published guidance',
    async (concernId) => {
      db.getDatabase()
        .prepare('DELETE FROM neo_session_bindings WHERE session_id = ?')
        .run(concernId ? holder : root);
      const sessionId = await service.open(concernId);
      expect(createSession).toHaveBeenCalledTimes(1);
      expect(db.getSession(sessionId)?.config.systemPrompt).toBe(neoPrompt(concernId, 'published'));
      expect(db.getSession(sessionId)?.config.allowedTools).toEqual([
        ...(concernId ? ['AskUserQuestion'] : []),
        'mcp__hyperneo-operations__invoke',
      ]);
    }
  );

  test.each([
    ['neo', null],
    ['concern', 'fictional'],
    ['worker', 'fictional'],
  ] as const)(
    'uses the actual AgentSession options builder for persisted %s sessions',
    async (kind, concernId) => {
      const id = `neo:runtime-${kind}`;
      const session: Session = {
        ...createTestSession(id),
        sdkSessionId: crypto.randomUUID(),
        workspacePath: null,
        config: {
          ...createTestSession(id).config,
          model: 'default',
          provider: 'anthropic',
          maxTurns: 17,
          systemPrompt: 'Older stored wording',
          sdkToolsPreset: ['AskUserQuestion'],
          permissionMode: 'acceptEdits' as const,
        },
      };
      db.createSession(session);
      if (kind !== 'worker')
        db.getDatabase()
          .prepare('DELETE FROM neo_session_bindings WHERE session_id = ?')
          .run(kind === 'neo' ? root : holder);
      expect(service.repo.reserveBinding({ sessionId: id, concernId, kind })).toBe(true);
      const agent = new AgentSession(
        session,
        db,
        hub,
        events,
        async () => null,
        undefined,
        undefined,
        undefined,
        undefined,
        { autoReplayPendingMessages: false }
      );
      agents.push(agent);
      const options = agent.optionsBuilder.addSessionStateOptions(
        await agent.optionsBuilder.build()
      );
      expect(options.resume).toBe(session.sdkSessionId);
      expect(options.model).toBe('default');
      expect(options.maxTurns).toBe(17);
      if (kind === 'worker') {
        expect(options.systemPrompt).toEqual({
          type: 'custom',
          prompt: 'Older stored wording',
          snapshot: false,
        });
        expect(options.permissionMode).toBe('acceptEdits');
      } else {
        expect(options.systemPrompt).toEqual({
          type: 'custom',
          prompt: neoPrompt(concernId, 'published'),
          snapshot: false,
        });
        expect(options.permissionMode).toBe('dontAsk');
        expect(options.tools).toEqual(concernId ? ['AskUserQuestion'] : []);
        expect(options.plugins).toEqual([]);
        expect(options.settingSources).toEqual([]);
        expect(options.agents).toEqual({});
        expect(options.allowedTools).toEqual([
          ...(concernId ? ['AskUserQuestion'] : []),
          'mcp__hyperneo-operations__invoke',
        ]);
        const legacy = await new QueryOptionsBuilder(agent).build();
        expect(legacy.systemPrompt).toEqual({
          type: 'custom',
          prompt: neoPrompt(concernId),
          snapshot: false,
        });
      }
    }
  );
});
