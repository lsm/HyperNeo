import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import type { MessageHub, SDKMessage, Session } from '@hyperneo/shared';
import { setupSpaceAgentHandlers } from '../../../../src/lib/rpc-handlers/space-agent-handlers';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository';
import {
  coordinatorLongHorizonAgentId,
  SpaceLongHorizonAgentRepository,
} from '../../../../src/storage/repositories/space-long-horizon-agent-repository';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import type {
  DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus';
import type { SpaceManager } from '../../../../src/lib/space/managers/space-manager';
import { setModelsCache } from '../../../../src/lib/model-service';
import {
  createSpaceAgentSchema,
  insertSpace,
  insertWorkflow,
  insertWorkflowNode,
} from '../../helpers/space-agent-schema';

type RequestHandler = (data: unknown, context: unknown) => Promise<unknown>;

function createMockMessageHub(): { hub: MessageHub; handlers: Map<string, RequestHandler> } {
  const handlers = new Map<string, RequestHandler>();
  const hub = {
    onRequest: mock((method: string, handler: RequestHandler) => {
      handlers.set(method, handler);
      return () => handlers.delete(method);
    }),
    onEvent: mock(() => () => {}),
    request: mock(async () => {}),
    event: mock(() => {}),
    joinChannel: mock(async () => {}),
    leaveChannel: mock(async () => {}),
    isConnected: mock(() => true),
    getState: mock(() => 'connected' as const),
    onConnection: mock(() => () => {}),
    onMessage: mock(() => () => {}),
    cleanup: mock(() => {}),
    registerTransport: mock(() => () => {}),
    registerRouter: mock(() => {}),
    getRouter: mock(() => null),
    getPendingCallCount: mock(() => 0),
  } as unknown as MessageHub;
  return { hub, handlers };
}

function createMockInternalEventBus(): {
  internalEventBus: InternalEventBus<DaemonInternalEventMap>;
  publishMock: ReturnType<typeof mock>;
} {
  const publishMock = mock(async () => ({ delivered: 0, failures: [] }));
  const internalEventBus = {
    publish: publishMock,
    publishAsync: mock(() => {}),
    subscribe: mock(() => () => {}),
    off: mock(() => {}),
    clear: mock(() => {}),
  } as unknown as InternalEventBus<DaemonInternalEventMap>;
  return { internalEventBus, publishMock };
}

function createMockSpaceManager(): {
  spaceManager: SpaceManager;
  getSpaceMock: ReturnType<typeof mock>;
} {
  type GetSpaceResult = Awaited<ReturnType<SpaceManager['getSpace']>>;
  const existingSpace = { id: 'space-1' } as unknown as Exclude<GetSpaceResult, null>;
  const getSpaceMock = mock(async (spaceId: string): Promise<GetSpaceResult> => {
    return spaceId === 'space-1' ? existingSpace : null;
  });
  const spaceManager = {
    getSpace: getSpaceMock,
  } as unknown as SpaceManager;
  return { spaceManager, getSpaceMock };
}

function createTestDatabaseFacade(db: Database) {
  const sessionRepo = new SessionRepository(db as any);
  const sdkMessageRepo = new SDKMessageRepository(db as any);
  return {
    getDatabase: () => db,
    getSession: (id: string) => sessionRepo.getSession(id),
    getRenderableTextMessages: (sessionId: string, limit?: number) =>
      sdkMessageRepo.getRenderableTextMessages(sessionId, limit),
  } as any;
}

function insertSession(db: Database, session: Partial<Session> & { id: string }): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO sessions (
			id, title, workspace_path, created_at, last_active_at, status, config, metadata,
			is_worktree, type, session_context
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    session.id,
    session.title ?? session.id,
    session.workspacePath ?? null,
    session.createdAt ?? now,
    session.lastActiveAt ?? now,
    session.status ?? 'active',
    JSON.stringify(
      session.config ?? {
        model: 'claude-sonnet-4-5',
        maxTokens: 4096,
        temperature: 0,
      }
    ),
    JSON.stringify(session.metadata ?? {}),
    session.worktree?.isWorktree ? 1 : 0,
    session.type ?? 'space_chat',
    session.context ? JSON.stringify(session.context) : null
  );
}

function insertMessage(db: Database, sessionId: string, id: string, message: SDKMessage): void {
  db.prepare(
    `INSERT INTO sdk_messages (
			id, session_id, message_type, sdk_message, timestamp, send_status, is_renderable, is_terminal,
			parent_tool_use_id
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    sessionId,
    message.type,
    JSON.stringify(message),
    new Date(Date.now() + Number(id.replace(/\D/g, '') || 0)).toISOString(),
    'consumed',
    1,
    0,
    null
  );
}

async function call<T>(
  handlers: Map<string, RequestHandler>,
  method: string,
  params: unknown
): Promise<T> {
  const handler = handlers.get(method);
  if (!handler) throw new Error(`Handler not registered: ${method}`);
  return (await handler(params, {})) as T;
}

describe('Space Agent RPC Handlers', () => {
  let db: Database;
  let manager: SpaceAgentManager;
  let hubData: ReturnType<typeof createMockMessageHub>;
  let daemonData: ReturnType<typeof createMockInternalEventBus>;
  let spaceManagerData: ReturnType<typeof createMockSpaceManager>;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceAgentSchema(db);
    insertSpace(db, 'space-1');

    const repo = new SpaceAgentRepository(db as any);
    manager = new SpaceAgentManager(repo);
    hubData = createMockMessageHub();
    daemonData = createMockInternalEventBus();
    spaceManagerData = createMockSpaceManager();

    setModelsCache(new Map());

    setupSpaceAgentHandlers(
      hubData.hub,
      daemonData.internalEventBus,
      manager,
      spaceManagerData.spaceManager,
      createTestDatabaseFacade(db)
    );
  });

  afterEach(() => {
    db.close();
    setModelsCache(new Map());
    mock.restore();
  });

  describe('spaceAgent.listBuiltInTemplates', () => {
    it('registers the handler', () => {
      expect(hubData.handlers.has('spaceAgent.listBuiltInTemplates')).toBe(true);
    });

    it('returns built-in agent templates from seeding source', async () => {
      const result = await call<{
        templates: Array<{ name: string; tools: string[]; systemPrompt: string }>;
      }>(hubData.handlers, 'spaceAgent.listBuiltInTemplates', {
        spaceId: 'space-1',
      });

      expect(Array.isArray(result.templates)).toBe(true);
      expect(result.templates).toHaveLength(6);
      expect(result.templates.map((template) => template.name).sort()).toEqual([
        'Coder',
        'General',
        'Planner',
        'QA',
        'Research',
        'Reviewer',
      ]);
      for (const template of result.templates) {
        expect(template.tools.length).toBeGreaterThanOrEqual(0);
        expect(template.customPrompt.length).toBeGreaterThan(0);
        expect(template.templateHash).toBeTruthy();
      }
    });

    it('throws when spaceId is missing', async () => {
      await expect(call(hubData.handlers, 'spaceAgent.listBuiltInTemplates', {})).rejects.toThrow(
        'spaceId is required'
      );
    });

    it('throws when space does not exist', async () => {
      await expect(
        call(hubData.handlers, 'spaceAgent.listBuiltInTemplates', { spaceId: 'missing-space' })
      ).rejects.toThrow('Space not found: missing-space');
    });
  });

  describe('spaceAgent.promotion', () => {
    it('generates a draft from recent renderable session messages', async () => {
      insertSession(db, {
        id: 'session-1',
        title: 'Release captain',
        type: 'space_chat',
        context: { spaceId: 'space-1' },
        config: {
          model: 'claude-sonnet-4-5',
          maxTokens: 4096,
          temperature: 0,
          thinkingLevel: 'think8k',
          allowedTools: ['Read', 'Grep', 'UnknownTool'],
        },
      });
      insertMessage(db, 'session-1', 'msg-1', {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'Track release blockers.' }] },
      } as SDKMessage);
      insertMessage(db, 'session-1', 'msg-2', {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'I will monitor CI.' }] },
      } as SDKMessage);

      const result = await call<{
        draft: { name: string; customPrompt: string; tools?: string[] };
      }>(hubData.handlers, 'spaceAgent.getPromotionDraft', {
        spaceId: 'space-1',
        sessionId: 'session-1',
      });

      expect(result.draft.name).toBe('Release captain');
      expect(result.draft.tools).toBeUndefined();
      expect(result.draft.customPrompt).toContain('## Responsibility');
      expect(result.draft.customPrompt).toContain('## Event Subscriptions');
      expect(result.draft.customPrompt).toContain('User: Track release blockers.');
      expect(result.draft.customPrompt).toContain('Assistant: I will monitor CI.');
    });

    it('preserves explicit empty setting sources in the draft', async () => {
      insertSession(db, {
        id: 'session-empty-settings',
        type: 'space_chat',
        context: { spaceId: 'space-1' },
        config: {
          model: 'claude-sonnet-4-5',
          maxTokens: 4096,
          temperature: 0,
          settingSources: [],
          tools: { settingSources: ['user'] },
        },
      });

      const result = await call<{ draft: { settingSources?: string[] } }>(
        hubData.handlers,
        'spaceAgent.getPromotionDraft',
        { spaceId: 'space-1', sessionId: 'session-empty-settings' }
      );

      expect(result.draft.settingSources).toEqual([]);
    });

    it('preserves explicit sdk tool presets in the draft', async () => {
      insertSession(db, {
        id: 'session-read-only-tools',
        type: 'space_chat',
        context: { spaceId: 'space-1' },
        config: {
          model: 'claude-sonnet-4-5',
          maxTokens: 4096,
          temperature: 0,
          sdkToolsPreset: ['Read', 'Grep'],
          allowedTools: ['Bash'],
        },
      });

      const result = await call<{ draft: { tools?: string[] } }>(
        hubData.handlers,
        'spaceAgent.getPromotionDraft',
        { spaceId: 'space-1', sessionId: 'session-read-only-tools' }
      );

      expect(result.draft.tools).toEqual(['Read', 'Grep']);
    });

    it('preserves disallowed tool restrictions in the draft', async () => {
      insertSession(db, {
        id: 'session-disallowed-tools',
        type: 'space_chat',
        context: { spaceId: 'space-1' },
        config: {
          model: 'claude-sonnet-4-5',
          maxTokens: 4096,
          temperature: 0,
          sdkToolsPreset: { type: 'preset', preset: 'claude_code' },
          disallowedTools: ['Bash', 'Write', 'UnknownTool'],
        },
      });

      const result = await call<{ draft: { tools?: string[] } }>(
        hubData.handlers,
        'spaceAgent.getPromotionDraft',
        { spaceId: 'space-1', sessionId: 'session-disallowed-tools' }
      );

      expect(result.draft.tools).not.toContain('Bash');
      expect(result.draft.tools).not.toContain('Write');
      expect(result.draft.tools).toContain('Read');
    });

    it('keeps the newest standing context when truncating long drafts', async () => {
      insertSession(db, {
        id: 'session-long-context',
        type: 'space_chat',
        context: { spaceId: 'space-1' },
      });
      insertMessage(db, 'session-long-context', 'msg-1', {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'old '.repeat(3000) }] },
      } as SDKMessage);
      insertMessage(db, 'session-long-context', 'msg-2', {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'newest marker' }] },
      } as SDKMessage);

      const result = await call<{ draft: { customPrompt: string } }>(
        hubData.handlers,
        'spaceAgent.getPromotionDraft',
        { spaceId: 'space-1', sessionId: 'session-long-context' }
      );

      expect(result.draft.customPrompt).toContain('…');
      expect(result.draft.customPrompt).toContain('Assistant: newest marker');
    });

    it('rejects drafts for sessions outside the requested space', async () => {
      insertSession(db, {
        id: 'session-2',
        type: 'space_chat',
        context: { spaceId: 'space-other' },
      });

      await expect(
        call(hubData.handlers, 'spaceAgent.getPromotionDraft', {
          spaceId: 'space-1',
          sessionId: 'session-2',
        })
      ).rejects.toThrow('Session not found: session-2');
    });

    it('rejects promotion when the target space no longer exists', async () => {
      insertSession(db, {
        id: 'session-deleted-space',
        type: 'space_chat',
        context: { spaceId: 'space-1' },
      });
      spaceManagerData.getSpaceMock.mockResolvedValue(null as never);

      await expect(
        call(hubData.handlers, 'spaceAgent.promoteSession', {
          spaceId: 'space-1',
          sessionId: 'session-deleted-space',
          name: 'Deleted Space Agent',
        })
      ).rejects.toThrow('Space not found: space-1');
    });

    it('creates an agent from a reviewed promotion draft', async () => {
      insertSession(db, {
        id: 'session-3',
        type: 'space_chat',
        context: { spaceId: 'space-1' },
      });

      const result = await call<{ agent: { name: string; customPrompt: string | null } }>(
        hubData.handlers,
        'spaceAgent.promoteSession',
        {
          spaceId: 'space-1',
          sessionId: 'session-3',
          name: 'Release Agent',
          customPrompt: 'Reviewed profile',
          tools: ['Read'],
        }
      );

      expect(result.agent.name).toBe('Release Agent');
      expect(result.agent.customPrompt).toBe('Reviewed profile');
      expect(daemonData.publishMock).toHaveBeenCalledWith(
        'spaceAgent.created',
        expect.objectContaining({ spaceId: 'space-1' })
      );
    });

    it('persists template tracking metadata when promoting from a template', async () => {
      insertSession(db, {
        id: 'session-template-promotion',
        type: 'space_chat',
        context: { spaceId: 'space-1' },
      });

      const result = await call<{
        agent: { templateName: string | null; templateHash: string | null };
      }>(hubData.handlers, 'spaceAgent.promoteSession', {
        spaceId: 'space-1',
        sessionId: 'session-template-promotion',
        name: 'Template Promotion',
        templateName: 'Coder',
        templateHash: 'coder-hash',
      });

      expect(result.agent.templateName).toBe('Coder');
      expect(result.agent.templateHash).toBe('coder-hash');
    });
  });

  describe('spaceAgent.create', () => {
    it('registers the handler', () => {
      expect(hubData.handlers.has('spaceAgent.create')).toBe(true);
    });

    it('creates an agent with required params', async () => {
      const result = await call<{ agent: { id: string; name: string } }>(
        hubData.handlers,
        'spaceAgent.create',
        { spaceId: 'space-1', name: 'MyAgent' }
      );

      expect(result.agent).toBeDefined();
      expect(result.agent.name).toBe('MyAgent');
    });

    it('creates an agent with all optional params', async () => {
      const result = await call<{
        agent: {
          name: string;
          description: string;
          model: string | undefined;
          customPrompt: string | null;
        };
      }>(hubData.handlers, 'spaceAgent.create', {
        spaceId: 'space-1',
        name: 'FullAgent',
        description: 'A detailed agent',
        model: 'claude-opus-4-5',
        provider: 'anthropic',
        customPrompt: 'You are helpful.',
      });

      expect(result.agent.name).toBe('FullAgent');
      expect(result.agent.description).toBe('A detailed agent');
      expect(result.agent.customPrompt).toBe('You are helpful.');
    });

    it('persists template tracking metadata on create', async () => {
      const result = await call<{
        agent: { templateName: string | null; templateHash: string | null };
      }>(hubData.handlers, 'spaceAgent.create', {
        spaceId: 'space-1',
        name: 'TemplateAgent',
        templateName: 'Coder',
        templateHash: 'coder-hash',
      });

      expect(result.agent.templateName).toBe('Coder');
      expect(result.agent.templateHash).toBe('coder-hash');
    });

    it('emits spaceAgent.created event after creation', async () => {
      await call(hubData.handlers, 'spaceAgent.create', {
        spaceId: 'space-1',
        name: 'EventAgent',
      });

      await new Promise((r) => setTimeout(r, 0));

      expect(daemonData.publishMock).toHaveBeenCalled();
      const [eventName, payload] = daemonData.publishMock.mock.calls[0] as [
        string,
        { spaceId: string; agent: { name: string } },
      ];
      expect(eventName).toBe('spaceAgent.created');
      expect(payload.spaceId).toBe('space-1');
      expect(payload.agent.name).toBe('EventAgent');
    });

    it('throws when spaceId is missing', async () => {
      await expect(call(hubData.handlers, 'spaceAgent.create', { name: 'A' })).rejects.toThrow(
        'spaceId is required'
      );
    });

    it('throws when name is missing', async () => {
      await expect(
        call(hubData.handlers, 'spaceAgent.create', { spaceId: 'space-1' })
      ).rejects.toThrow('name is required');
    });

    it('creates an agent without a role (role field removed from schema)', async () => {
      const result = await call<{ agent: { id: string; name: string } }>(
        hubData.handlers,
        'spaceAgent.create',
        { spaceId: 'space-1', name: 'SimpleAgent' }
      );
      expect(result.agent.name).toBe('SimpleAgent');
    });

    it('throws on duplicate name within the same space', async () => {
      await call(hubData.handlers, 'spaceAgent.create', {
        spaceId: 'space-1',
        name: 'Duplicate',
      });

      await expect(
        call(hubData.handlers, 'spaceAgent.create', {
          spaceId: 'space-1',
          name: 'Duplicate',
        })
      ).rejects.toThrow('"Duplicate" already exists');
    });
  });

  describe('spaceAgent.list', () => {
    it('registers the handler', () => {
      expect(hubData.handlers.has('spaceAgent.list')).toBe(true);
    });

    it('returns empty array for a space with no agents', async () => {
      const result = await call<{ agents: unknown[] }>(hubData.handlers, 'spaceAgent.list', {
        spaceId: 'space-1',
      });
      expect(result.agents).toEqual([]);
    });

    it('returns all agents for a space', async () => {
      await call(hubData.handlers, 'spaceAgent.create', {
        spaceId: 'space-1',
        name: 'Alpha',
      });
      await call(hubData.handlers, 'spaceAgent.create', {
        spaceId: 'space-1',
        name: 'Beta',
      });

      const result = await call<{ agents: { name: string }[] }>(
        hubData.handlers,
        'spaceAgent.list',
        { spaceId: 'space-1' }
      );
      expect(result.agents).toHaveLength(2);
      const names = result.agents.map((a) => a.name).sort();
      expect(names).toEqual(['Alpha', 'Beta']);
    });

    it('throws when spaceId is missing', async () => {
      await expect(call(hubData.handlers, 'spaceAgent.list', {})).rejects.toThrow(
        'spaceId is required'
      );
    });
  });

  describe('spaceAgent.get', () => {
    it('registers the handler', () => {
      expect(hubData.handlers.has('spaceAgent.get')).toBe(true);
    });

    it('returns the agent by id', async () => {
      const created = await call<{ agent: { id: string; name: string } }>(
        hubData.handlers,
        'spaceAgent.create',
        { spaceId: 'space-1', name: 'GetMe' }
      );

      const result = await call<{ agent: { id: string; name: string } }>(
        hubData.handlers,
        'spaceAgent.get',
        { id: created.agent.id }
      );
      expect(result.agent.id).toBe(created.agent.id);
      expect(result.agent.name).toBe('GetMe');
    });

    it('throws when id is missing', async () => {
      await expect(call(hubData.handlers, 'spaceAgent.get', {})).rejects.toThrow('id is required');
    });

    it('throws when agent does not exist', async () => {
      await expect(
        call(hubData.handlers, 'spaceAgent.get', { id: 'nonexistent-id' })
      ).rejects.toThrow('Agent not found');
    });
  });

  describe('spaceAgent.update', () => {
    let agentId: string;

    beforeEach(async () => {
      const created = await call<{ agent: { id: string } }>(hubData.handlers, 'spaceAgent.create', {
        spaceId: 'space-1',
        name: 'Original',
      });
      agentId = created.agent.id;
      daemonData.publishMock.mockClear();
    });

    it('registers the handler', () => {
      expect(hubData.handlers.has('spaceAgent.update')).toBe(true);
    });

    it('updates the agent name', async () => {
      const result = await call<{ agent: { name: string } }>(
        hubData.handlers,
        'spaceAgent.update',
        { id: agentId, name: 'Renamed' }
      );
      expect(result.agent.name).toBe('Renamed');
    });

    it('updates description and customPrompt', async () => {
      const result = await call<{
        agent: { description: string; customPrompt: string | null };
      }>(hubData.handlers, 'spaceAgent.update', {
        id: agentId,
        description: 'New desc',
        customPrompt: 'New prompt',
      });
      expect(result.agent.description).toBe('New desc');
      expect(result.agent.customPrompt).toBe('New prompt');
    });

    it('clears template tracking metadata on update', async () => {
      const created = await call<{ agent: { id: string } }>(hubData.handlers, 'spaceAgent.create', {
        spaceId: 'space-1',
        name: 'TemplateTracked',
        templateName: 'Coder',
        templateHash: 'coder-hash',
      });

      const result = await call<{
        agent: { templateName: string | null; templateHash: string | null };
      }>(hubData.handlers, 'spaceAgent.update', {
        id: created.agent.id,
        templateName: null,
        templateHash: null,
      });

      expect(result.agent.templateName).toBeNull();
      expect(result.agent.templateHash).toBeNull();
    });

    it('clears the session provider when the override is explicitly cleared (P2)', async () => {
      const runtimeService = {
        removeLongHorizonAgentSubscriptions: mock(() => {}),
        clearLongTermAgentSessionProvider: mock(async () => {}),
      };
      const freshHub = createMockMessageHub();
      setupSpaceAgentHandlers(
        freshHub.hub,
        daemonData.internalEventBus,
        manager,
        spaceManagerData.spaceManager,
        createTestDatabaseFacade(db),
        runtimeService
      );

      await call(freshHub.handlers, 'spaceAgent.update', {
        id: agentId,
        provider: null,
      });

      expect(runtimeService.clearLongTermAgentSessionProvider).toHaveBeenCalledWith(
        'space-1',
        agentId
      );
    });

    it('does not clear the session provider when the override is set or untouched', async () => {
      const runtimeService = {
        removeLongHorizonAgentSubscriptions: mock(() => {}),
        clearLongTermAgentSessionProvider: mock(async () => {}),
      };
      const freshHub = createMockMessageHub();
      setupSpaceAgentHandlers(
        freshHub.hub,
        daemonData.internalEventBus,
        manager,
        spaceManagerData.spaceManager,
        createTestDatabaseFacade(db),
        runtimeService
      );

      await call(freshHub.handlers, 'spaceAgent.update', { id: agentId, provider: 'kimi' });
      await call(freshHub.handlers, 'spaceAgent.update', { id: agentId, name: 'Renamed' });

      expect(runtimeService.clearLongTermAgentSessionProvider).not.toHaveBeenCalled();
    });

    it('does not sync shared long-horizon agent rows when worker changes', async () => {
      const visibleAgent = manager.getById(agentId);
      expect(visibleAgent).not.toBeNull();
      const longHorizonRepo = new SpaceLongHorizonAgentRepository(db as any);
      const longHorizonAgent = longHorizonRepo.create({
        id: agentId,
        spaceId: 'space-1',
        handle: visibleAgent?.handle ?? 'original',
        displayName: 'Original',
      });

      await call(hubData.handlers, 'spaceAgent.update', {
        id: agentId,
        handle: 'renamed',
        description: 'Short UI summary only',
        provider: 'openrouter',
        settingSources: ['project'],
        tools: ['Read', 'Edit'],
      });

      expect(longHorizonRepo.getById(longHorizonAgent.id)).toEqual(
        expect.objectContaining({
          handle: visibleAgent?.handle,
          instructions: '',
          provider: null,
          settingSources: null,
          toolPermissions: {},
        })
      );
    });

    it('allows worker handle changes without checking long-horizon handle collisions', async () => {
      const visibleAgent = manager.getById(agentId);
      expect(visibleAgent).not.toBeNull();
      const longHorizonRepo = new SpaceLongHorizonAgentRepository(db as any);
      longHorizonRepo.create({
        id: agentId,
        spaceId: 'space-1',
        handle: visibleAgent?.handle ?? 'original',
        displayName: 'Original',
      });
      longHorizonRepo.create({
        id: 'standalone-lh-agent',
        spaceId: 'space-1',
        handle: 'taken-handle',
        displayName: 'Standalone Agent',
      });

      await call(hubData.handlers, 'spaceAgent.update', {
        id: agentId,
        handle: 'taken-handle',
      });

      expect(manager.getById(agentId)).toEqual(expect.objectContaining({ handle: 'taken-handle' }));
      expect(longHorizonRepo.getById(agentId)).toEqual(
        expect.objectContaining({ handle: visibleAgent?.handle })
      );
    });

    it('does not sync standalone long-horizon rows matched only by handle', async () => {
      const visibleAgent = manager.getById(agentId);
      expect(visibleAgent).not.toBeNull();
      const longHorizonRepo = new SpaceLongHorizonAgentRepository(db as any);
      const standaloneAgent = longHorizonRepo.create({
        id: 'standalone-lh-agent',
        spaceId: 'space-1',
        handle: visibleAgent?.handle ?? 'original',
        displayName: 'Standalone Agent',
        instructions: 'Standalone prompt',
      });

      await call(hubData.handlers, 'spaceAgent.update', {
        id: agentId,
        handle: 'renamed-visible',
        customPrompt: 'Updated visible prompt',
      });

      expect(longHorizonRepo.getById(standaloneAgent.id)).toEqual(
        expect.objectContaining({
          handle: visibleAgent?.handle,
          instructions: 'Standalone prompt',
        })
      );
    });

    it('does not sync seeded coordinator long-horizon rows from worker updates', async () => {
      const created = await call<{ agent: { id: string } }>(hubData.handlers, 'spaceAgent.create', {
        spaceId: 'space-1',
        name: 'Coordinator',
        handle: 'space-coordinator',
      });
      const longHorizonRepo = new SpaceLongHorizonAgentRepository(db as any);
      const coordinator = longHorizonRepo.ensureCoordinator('space-1');

      await call(hubData.handlers, 'spaceAgent.update', {
        id: created.agent.id,
        customPrompt: 'Updated coordinator prompt',
        tools: ['Read'],
      });

      expect(longHorizonRepo.getById(coordinator.id)).toEqual(
        expect.objectContaining({
          handle: 'coordinator',
          instructions: coordinator.instructions,
          toolPermissions: {},
        })
      );
    });

    it('emits spaceAgent.updated event', async () => {
      await call(hubData.handlers, 'spaceAgent.update', { id: agentId, name: 'Updated' });
      await new Promise((r) => setTimeout(r, 0));

      expect(daemonData.publishMock).toHaveBeenCalled();
      const [eventName] = daemonData.publishMock.mock.calls[0] as [string, unknown];
      expect(eventName).toBe('spaceAgent.updated');
    });

    it('throws when id is missing', async () => {
      await expect(call(hubData.handlers, 'spaceAgent.update', { name: 'X' })).rejects.toThrow(
        'id is required'
      );
    });

    it('throws when agent does not exist', async () => {
      await expect(
        call(hubData.handlers, 'spaceAgent.update', { id: 'bad-id', name: 'X' })
      ).rejects.toThrow('Agent not found');
    });

    it('throws on duplicate name conflict', async () => {
      await call(hubData.handlers, 'spaceAgent.create', {
        spaceId: 'space-1',
        name: 'OtherAgent',
      });

      await expect(
        call(hubData.handlers, 'spaceAgent.update', { id: agentId, name: 'OtherAgent' })
      ).rejects.toThrow('already exists');
    });

    it('updates agent name successfully', async () => {
      const result = await call<{ agent: { name: string } }>(
        hubData.handlers,
        'spaceAgent.update',
        {
          id: agentId,
          name: 'UpdatedName',
        }
      );
      expect(result.agent.name).toBe('UpdatedName');
    });
  });

  describe('spaceAgent.delete', () => {
    let agentId: string;

    beforeEach(async () => {
      const created = await call<{ agent: { id: string } }>(hubData.handlers, 'spaceAgent.create', {
        spaceId: 'space-1',
        name: 'ToDelete',
      });
      agentId = created.agent.id;
      daemonData.publishMock.mockClear();
    });

    it('registers the handler', () => {
      expect(hubData.handlers.has('spaceAgent.delete')).toBe(true);
    });

    it('deletes the agent and returns success', async () => {
      const result = await call<{ success: boolean }>(hubData.handlers, 'spaceAgent.delete', {
        id: agentId,
      });
      expect(result.success).toBe(true);
    });

    it('does not archive matching long-horizon agent rows before deleting workers', async () => {
      setupSpaceAgentHandlers(
        hubData.hub,
        daemonData.internalEventBus,
        manager,
        spaceManagerData.spaceManager,
        createTestDatabaseFacade(db),
        { removeLongHorizonAgentSubscriptions: mock(() => {}) }
      );
      const visibleAgent = manager.getById(agentId);
      expect(visibleAgent).not.toBeNull();
      const longHorizonRepo = new SpaceLongHorizonAgentRepository(db as any);
      const longHorizonAgent = longHorizonRepo.create({
        id: agentId,
        spaceId: 'space-1',
        handle: visibleAgent?.handle ?? 'todelete',
        displayName: 'ToDelete',
      });

      await call(hubData.handlers, 'spaceAgent.delete', { id: agentId });

      expect(longHorizonRepo.getById(longHorizonAgent.id)?.status).toBe('active');
    });

    it('does not archive standalone long-horizon rows matched only by handle', async () => {
      setupSpaceAgentHandlers(
        hubData.hub,
        daemonData.internalEventBus,
        manager,
        spaceManagerData.spaceManager,
        createTestDatabaseFacade(db),
        { removeLongHorizonAgentSubscriptions: mock(() => {}) }
      );
      const visibleAgent = manager.getById(agentId);
      expect(visibleAgent).not.toBeNull();
      const longHorizonRepo = new SpaceLongHorizonAgentRepository(db as any);
      const standaloneAgent = longHorizonRepo.create({
        id: 'standalone-lh-agent-delete',
        spaceId: 'space-1',
        handle: visibleAgent?.handle ?? 'todelete',
        displayName: 'Standalone To Keep',
      });

      await call(hubData.handlers, 'spaceAgent.delete', { id: agentId });

      expect(longHorizonRepo.getById(standaloneAgent.id)?.status).toBe('active');
    });

    it('does not archive seeded coordinator long-horizon rows when deleting workers', async () => {
      const removeLongHorizonAgentSubscriptions = mock(() => {});
      setupSpaceAgentHandlers(
        hubData.hub,
        daemonData.internalEventBus,
        manager,
        spaceManagerData.spaceManager,
        createTestDatabaseFacade(db),
        { removeLongHorizonAgentSubscriptions }
      );
      const created = await call<{ agent: { id: string } }>(hubData.handlers, 'spaceAgent.create', {
        spaceId: 'space-1',
        name: 'Coordinator',
        handle: 'space-coordinator',
      });
      const longHorizonRepo = new SpaceLongHorizonAgentRepository(db as any);
      const coordinator = longHorizonRepo.ensureCoordinator('space-1');
      const subscription = longHorizonRepo.createSubscription({
        spaceId: 'space-1',
        agentId: coordinator.id,
        source: 'github',
        topic: 'github/*/*/pull_request/*',
      });

      await call(hubData.handlers, 'spaceAgent.delete', { id: created.agent.id });

      expect(longHorizonRepo.getById(coordinator.id)?.status).toBe('active');
      expect(longHorizonRepo.getSubscription(subscription.id)?.status).toBe('active');
      expect(removeLongHorizonAgentSubscriptions).not.toHaveBeenCalled();
    });

    it('emits spaceAgent.deleted event', async () => {
      await call(hubData.handlers, 'spaceAgent.delete', { id: agentId });

      expect(daemonData.publishMock).toHaveBeenCalled();
      const [eventName, payload] = daemonData.publishMock.mock.calls[0] as [
        string,
        { agentId: string },
      ];
      expect(eventName).toBe('spaceAgent.deleted');
      expect(payload.agentId).toBe(agentId);
    });

    it('throws when id is missing', async () => {
      await expect(call(hubData.handlers, 'spaceAgent.delete', {})).rejects.toThrow(
        'id is required'
      );
    });

    it('throws when agent does not exist', async () => {
      await expect(call(hubData.handlers, 'spaceAgent.delete', { id: 'ghost-id' })).rejects.toThrow(
        'Agent not found'
      );
    });

    it('throws clear error when agent is referenced by a workflow node', async () => {
      insertWorkflow(db, 'wf-1', 'space-1', 'My Workflow');
      insertWorkflowNode(db, 'node-1', 'wf-1', agentId);

      await expect(call(hubData.handlers, 'spaceAgent.delete', { id: agentId })).rejects.toThrow(
        /Cannot delete agent.*referenced by workflow nodes/
      );
    });

    it('throws and includes workflow names in error when referenced', async () => {
      insertWorkflow(db, 'wf-2', 'space-1', 'Important Workflow');
      insertWorkflowNode(db, 'node-2', 'wf-2', agentId);

      await expect(call(hubData.handlers, 'spaceAgent.delete', { id: agentId })).rejects.toThrow(
        'Important Workflow'
      );
    });

    it('allows deletion after the node reference is removed', async () => {
      insertWorkflow(db, 'wf-3', 'space-1', 'Temp Workflow');
      insertWorkflowNode(db, 'node-3', 'wf-3', agentId);

      db.prepare(`UPDATE space_workflow_nodes SET config = '{}' WHERE id = 'node-3'`).run();

      const result = await call<{ success: boolean }>(hubData.handlers, 'spaceAgent.delete', {
        id: agentId,
      });
      expect(result.success).toBe(true);
    });
  });

  describe('spaceAgent.getDriftReport', () => {
    it('registers the handler', () => {
      expect(hubData.handlers.has('spaceAgent.getDriftReport')).toBe(true);
    });

    it('returns an empty agents array for a space with no preset-tracked agents', async () => {
      const result = await call<{
        report: {
          spaceId: string;
          agents: Array<{ updateAvailable: boolean; customized: boolean }>;
        };
      }>(hubData.handlers, 'spaceAgent.getDriftReport', { spaceId: 'space-1' });

      expect(result.report.spaceId).toBe('space-1');
      expect(result.report.agents).toEqual([]);
    });

    it('reports an updateAvailable+customized entry when stored hash differs and row was edited', async () => {
      await manager.create({
        spaceId: 'space-1',
        name: 'Coder',
        description: 'old',
        tools: ['Read'],
        customPrompt: 'old',
        templateName: 'Coder',
        templateHash: 'stale-hash',
      });

      const result = await call<{
        report: {
          spaceId: string;
          agents: Array<{
            agentName: string;
            updateAvailable: boolean;
            customized: boolean;
            storedHash: string | null;
          }>;
        };
      }>(hubData.handlers, 'spaceAgent.getDriftReport', { spaceId: 'space-1' });

      expect(result.report.agents).toHaveLength(1);
      expect(result.report.agents[0].agentName).toBe('Coder');
      expect(result.report.agents[0].updateAvailable).toBe(true);
      expect(result.report.agents[0].customized).toBe(true);
      expect(result.report.agents[0].storedHash).toBe('stale-hash');
    });

    it('throws when spaceId is missing', async () => {
      await expect(call(hubData.handlers, 'spaceAgent.getDriftReport', {})).rejects.toThrow(
        'spaceId is required'
      );
    });

    it('throws when space does not exist', async () => {
      await expect(
        call(hubData.handlers, 'spaceAgent.getDriftReport', { spaceId: 'ghost' })
      ).rejects.toThrow('Space not found');
    });
  });

  describe('spaceAgent.syncFromTemplate', () => {
    it('registers the handler', () => {
      expect(hubData.handlers.has('spaceAgent.syncFromTemplate')).toBe(true);
    });

    it('throws when spaceId is missing', async () => {
      await expect(
        call(hubData.handlers, 'spaceAgent.syncFromTemplate', { agentId: 'a-1' })
      ).rejects.toThrow('spaceId is required');
    });

    it('throws when agentId is missing', async () => {
      await expect(
        call(hubData.handlers, 'spaceAgent.syncFromTemplate', { spaceId: 'space-1' })
      ).rejects.toThrow('agentId is required');
    });

    it('throws when space does not exist', async () => {
      await expect(
        call(hubData.handlers, 'spaceAgent.syncFromTemplate', {
          spaceId: 'ghost',
          agentId: 'a-1',
        })
      ).rejects.toThrow('Space not found');
    });

    it('throws when agent does not exist', async () => {
      await expect(
        call(hubData.handlers, 'spaceAgent.syncFromTemplate', {
          spaceId: 'space-1',
          agentId: 'ghost-agent',
        })
      ).rejects.toThrow('Agent not found');
    });

    it('throws when agent belongs to a different space (cross-space attack)', async () => {
      insertSpace(db, 'space-2');
      spaceManagerData.getSpaceMock.mockImplementation(async (id: string) => {
        if (id === 'space-1' || id === 'space-2') return { id } as never;
        return null;
      });
      const created = await manager.create({
        spaceId: 'space-2',
        name: 'Coder',
        templateName: 'Coder',
        templateHash: 'h',
      });
      if (!created.ok) throw new Error('create failed');

      await expect(
        call(hubData.handlers, 'spaceAgent.syncFromTemplate', {
          spaceId: 'space-1',
          agentId: created.value.id,
        })
      ).rejects.toThrow('Agent not found');
    });

    it('does not sync matching long-horizon event agents after template sync', async () => {
      const created = await manager.create({
        spaceId: 'space-1',
        name: 'Coder',
        description: 'old',
        tools: ['Read'],
        customPrompt: 'old',
        templateName: 'Coder',
        templateHash: 'stale',
      });
      if (!created.ok) throw new Error('create failed');
      const longHorizonRepo = new SpaceLongHorizonAgentRepository(db as any);
      const longHorizonAgent = longHorizonRepo.create({
        id: created.value.id,
        spaceId: 'space-1',
        handle: created.value.handle,
        displayName: created.value.name,
        instructions: 'old',
        toolPermissions: { tools: ['Read'] },
      });

      await call(hubData.handlers, 'spaceAgent.syncFromTemplate', {
        spaceId: 'space-1',
        agentId: created.value.id,
      });

      expect(longHorizonRepo.getById(longHorizonAgent.id)).toEqual(
        expect.objectContaining({
          instructions: 'old',
          toolPermissions: { tools: ['Read'] },
        })
      );
    });

    it('returns the updated agent and emits spaceAgent.updated', async () => {
      const created = await manager.create({
        spaceId: 'space-1',
        name: 'Coder',
        description: 'old',
        tools: ['Read'],
        customPrompt: 'old',
        templateName: 'Coder',
        templateHash: 'stale',
      });
      if (!created.ok) throw new Error('create failed');

      daemonData.publishMock.mockClear();

      const result = await call<{ agent: { id: string; templateName: string | null } }>(
        hubData.handlers,
        'spaceAgent.syncFromTemplate',
        { spaceId: 'space-1', agentId: created.value.id }
      );

      expect(result.agent.id).toBe(created.value.id);
      expect(result.agent.templateName).toBe('Coder');

      await new Promise((r) => setTimeout(r, 0));
      expect(daemonData.publishMock).toHaveBeenCalled();
      const [eventName, payload] = daemonData.publishMock.mock.calls[0] as [
        string,
        { spaceId: string; agent: { id: string } },
      ];
      expect(eventName).toBe('spaceAgent.updated');
      expect(payload.spaceId).toBe('space-1');
      expect(payload.agent.id).toBe(created.value.id);
    });
  });

  describe('spaceAgent.previewTemplateSync', () => {
    it('registers the handler', () => {
      expect(hubData.handlers.has('spaceAgent.previewTemplateSync')).toBe(true);
    });

    it('throws when spaceId is missing', async () => {
      await expect(
        call(hubData.handlers, 'spaceAgent.previewTemplateSync', { agentId: 'a-1' })
      ).rejects.toThrow('spaceId is required');
    });

    it('throws when agentId is missing', async () => {
      await expect(
        call(hubData.handlers, 'spaceAgent.previewTemplateSync', { spaceId: 'space-1' })
      ).rejects.toThrow('agentId is required');
    });

    it('throws when space does not exist', async () => {
      await expect(
        call(hubData.handlers, 'spaceAgent.previewTemplateSync', {
          spaceId: 'ghost',
          agentId: 'a-1',
        })
      ).rejects.toThrow('Space not found');
    });

    it('throws when agent does not exist', async () => {
      await expect(
        call(hubData.handlers, 'spaceAgent.previewTemplateSync', {
          spaceId: 'space-1',
          agentId: 'ghost-agent',
        })
      ).rejects.toThrow('Agent not found');
    });

    it('throws when agent belongs to a different space (cross-space attack)', async () => {
      insertSpace(db, 'space-2');
      spaceManagerData.getSpaceMock.mockImplementation(async (id: string) => {
        if (id === 'space-1' || id === 'space-2') return { id } as never;
        return null;
      });
      const created = await manager.create({
        spaceId: 'space-2',
        name: 'Coder',
        templateName: 'Coder',
        templateHash: 'h',
      });
      if (!created.ok) throw new Error('create failed');

      await expect(
        call(hubData.handlers, 'spaceAgent.previewTemplateSync', {
          spaceId: 'space-1',
          agentId: created.value.id,
        })
      ).rejects.toThrow('Agent not found');
    });

    it('rejects user-created (non-seeded) agents', async () => {
      const created = await manager.create({ spaceId: 'space-1', name: 'CustomBot' });
      if (!created.ok) throw new Error('create failed');

      await expect(
        call(hubData.handlers, 'spaceAgent.previewTemplateSync', {
          spaceId: 'space-1',
          agentId: created.value.id,
        })
      ).rejects.toThrow(/not linked to a preset/i);
    });

    it('returns a before/after diff for a drifted seeded agent', async () => {
      const created = await manager.create({
        spaceId: 'space-1',
        name: 'Coder',
        description: 'old description',
        tools: ['Read'],
        customPrompt: 'old prompt',
        templateName: 'Coder',
        templateHash: 'stale-hash',
      });
      if (!created.ok) throw new Error('create failed');

      const result = await call<{
        preview: {
          updateAvailable: boolean;
          customized: boolean;
          storedHash: string | null;
          diff: { customPrompt?: { before: string; after: string } };
        };
      }>(hubData.handlers, 'spaceAgent.previewTemplateSync', {
        spaceId: 'space-1',
        agentId: created.value.id,
      });

      expect(result.preview.updateAvailable).toBe(true);
      expect(result.preview.customized).toBe(true);
      expect(result.preview.storedHash).toBe('stale-hash');
      expect(result.preview.diff.customPrompt?.before).toBe('old prompt');
      expect(result.preview.diff.customPrompt?.after.length).toBeGreaterThan(0);

      expect(manager.getById(created.value.id)?.customPrompt).toBe('old prompt');
    });

    it('returns updateAvailable=false with an empty diff for an in-sync agent', async () => {
      const { getPresetAgentTemplates } = await import(
        '../../../../src/lib/space/agents/seed-agents'
      );
      const { computeAgentTemplateHash } = await import(
        '../../../../src/lib/space/agents/agent-template-hash'
      );
      const coder = getPresetAgentTemplates().find((p) => p.name === 'Coder');
      if (!coder) throw new Error('Coder preset missing');

      const created = await manager.create({
        spaceId: 'space-1',
        name: 'Coder',
        description: coder.description,
        tools: coder.tools,
        customPrompt: coder.customPrompt,
        templateName: 'Coder',
        templateHash: computeAgentTemplateHash(coder),
      });
      if (!created.ok) throw new Error('create failed');

      const result = await call<{
        preview: {
          updateAvailable: boolean;
          customized: boolean;
          diff: Record<string, unknown>;
        };
      }>(hubData.handlers, 'spaceAgent.previewTemplateSync', {
        spaceId: 'space-1',
        agentId: created.value.id,
      });

      expect(result.preview.updateAvailable).toBe(false);
      expect(result.preview.customized).toBe(false);
      expect(result.preview.diff).toEqual({});
    });
  });
});
