import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { MessageHub, SDKMessage, Session } from '@hyperneo/shared';
import type {
  DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus';
import { setModelsCache } from '../../../../src/lib/model-service';
import {
  ensureSessionAdmitSpaceStage,
  ensureSessionProvisionStage,
  ensureSessionResolveTargetStage,
  ensureSessionValidateStage,
  setupSpaceAgentHandlers,
} from '../../../../src/lib/rpc-handlers/space-agent-handlers';
import { SpaceAgentTemplateManager } from '../../../../src/lib/space/managers/space-agent-template-manager';
import type { SpaceManager } from '../../../../src/lib/space/managers/space-manager';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository';
import { SpaceAgentTemplateRepository } from '../../../../src/storage/repositories/space-agent-template-repository';
import {
  coordinatorLongHorizonAgentId,
  SpaceLongHorizonAgentRepository,
} from '../../../../src/storage/repositories/space-long-horizon-agent-repository';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository';
import { runMigration226 } from '../../../../src/storage/schema/m226-space-agent-templates-version';
import { runMigration227 } from '../../../../src/storage/schema/m227-space-agent-template-version-seq';
import { runMigration238 } from '../../../../src/storage/schema/m238-space-agent-template-labels';
import { createSpaceAgentTemplatesTable } from '../../../../src/storage/schema/space-agent-templates';
import { Database } from '../../../../src/storage/sqlite-compat';
import { seedWorkerMirror } from '../../helpers/seed-worker-mirror';
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

function createRuntimeServiceMock(): {
  refreshLongHorizonAgentSubscriptions: ReturnType<typeof mock>;
  refreshLongHorizonSubscription: ReturnType<typeof mock>;
  removeLongHorizonSubscription: ReturnType<typeof mock>;
  removeLongHorizonAgentSubscriptions: ReturnType<typeof mock>;
  clearLongTermAgentSessionProvider: ReturnType<typeof mock>;
  ensureAgentSession: ReturnType<typeof mock>;
  refreshLongHorizonAgentSession: ReturnType<typeof mock>;
} {
  return {
    refreshLongHorizonAgentSubscriptions: mock(() => ({ success: true })),
    refreshLongHorizonSubscription: mock(() => ({ success: true })),
    removeLongHorizonSubscription: mock(() => {}),
    removeLongHorizonAgentSubscriptions: mock(() => {}),
    clearLongTermAgentSessionProvider: mock(async () => {}),
    ensureAgentSession: mock(async () => ({ getSessionData: () => ({ status: 'active' }) })),
    refreshLongHorizonAgentSession: mock(async () => {}),
  };
}

describe('Space Agent RPC Handlers', () => {
  let db: Database;
  let hubData: ReturnType<typeof createMockMessageHub>;
  let daemonData: ReturnType<typeof createMockInternalEventBus>;
  let spaceManagerData: ReturnType<typeof createMockSpaceManager>;
  let longHorizonRepo: SpaceLongHorizonAgentRepository;
  let workflowRepo: SpaceWorkflowRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceAgentSchema(db);
    createSpaceAgentTemplatesTable(db);
    runMigration226(db);
    runMigration227(db);
    runMigration238(db);
    insertSpace(db, 'space-1');

    longHorizonRepo = new SpaceLongHorizonAgentRepository(db as any);
    workflowRepo = new SpaceWorkflowRepository(db as any);
    hubData = createMockMessageHub();
    daemonData = createMockInternalEventBus();
    spaceManagerData = createMockSpaceManager();

    setModelsCache(new Map());

    setupSpaceAgentHandlers(
      hubData.hub,
      daemonData.internalEventBus,
      spaceManagerData.spaceManager,
      createTestDatabaseFacade(db),
      longHorizonRepo,
      workflowRepo,
      undefined,
      new SpaceAgentTemplateManager(new SpaceAgentTemplateRepository(db as any))
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

    it('returns unified long-horizon templates on the spaceAgent namespace', async () => {
      const result = await call<{
        templates: Array<{ key: string; displayName: string; instructions: string }>;
      }>(hubData.handlers, 'spaceAgent.listBuiltInTemplates', {
        spaceId: 'space-1',
      });

      expect(Array.isArray(result.templates)).toBe(true);
      expect(result.templates.length).toBeGreaterThan(0);
      for (const template of result.templates) {
        expect(template.displayName.length).toBeGreaterThan(0);
        expect(template.instructions.length).toBeGreaterThan(0);
      }
    });

    it('returns exactly the current 5 built-in templates (ATC-1/ATC-3/ATC-4 pin)', async () => {
      const result = await call<{ templates: Array<{ key: string; handle: string }> }>(
        hubData.handlers,
        'spaceAgent.listBuiltInTemplates',
        { spaceId: 'space-1' }
      );

      expect(result.templates).toHaveLength(5);
      expect(result.templates.map((template) => template.key)).toEqual([
        'task-manager.default',
        'worker.swe',
        'worker.research',
        'worker.reviewer',
        'worker.qa',
      ]);
      expect(result.templates.map((template) => template.handle)).toEqual([
        'task-manager',
        'swe',
        'research',
        'reviewer',
        'qa',
      ]);
    });

    it('returns labels on built-in templates (ATC-2)', async () => {
      const result = await call<{ templates: Array<{ key: string; labels?: string[] }> }>(
        hubData.handlers,
        'spaceAgent.listBuiltInTemplates',
        { spaceId: 'space-1' }
      );

      for (const template of result.templates) {
        expect(template.labels, template.key).toBeDefined();
        if (template.key.startsWith('worker.')) {
          expect(template.labels).toEqual(['workflow-worker']);
        } else {
          expect(template.labels).toEqual(['long-horizon']);
        }
      }
    });

    it('omits the reserved coordinator card (ATC-3)', async () => {
      const result = await call<{ templates: Array<{ key: string; handle: string }> }>(
        hubData.handlers,
        'spaceAgent.listBuiltInTemplates',
        { spaceId: 'space-1' }
      );

      expect(result.templates.map((template) => template.key)).not.toContain('coordinator.default');
      expect(result.templates.map((template) => template.handle)).not.toContain('coordinator');
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

  describe('spaceAgent.listTemplates', () => {
    it('registers the handler', () => {
      expect(hubData.handlers.has('spaceAgent.listTemplates')).toBe(true);
    });

    it('returns built-in templates in the unified template shape', async () => {
      const result = await call<{
        templates: Array<{
          key: string;
          displayName: string;
          model: string | null;
          createdAt: number;
        }>;
      }>(hubData.handlers, 'spaceAgent.listTemplates', {});

      expect(Array.isArray(result.templates)).toBe(true);
      expect(result.templates.map((template) => template.key)).toContain('worker.swe');
      expect(result.templates.map((template) => template.key)).not.toContain('coordinator.default');
      for (const template of result.templates) {
        expect(typeof template.createdAt).toBe('number');
        expect(template.model).toBe(null);
      }
    });

    it('merges custom templates with built-ins', async () => {
      await call(hubData.handlers, 'spaceAgent.createTemplate', {
        key: 'review.custom',
        handle: 'review',
        displayName: 'Review',
      });

      const result = await call<{ templates: Array<{ key: string }> }>(
        hubData.handlers,
        'spaceAgent.listTemplates',
        {}
      );

      const keys = result.templates.map((template) => template.key);
      expect(keys).toContain('review.custom');
      expect(keys).toContain('worker.swe');
      expect(keys).not.toContain('coordinator.default');
    });
  });

  describe('spaceAgent.createTemplate', () => {
    it('creates a custom template and returns it', async () => {
      const result = await call<{
        template: { key: string; handle: string; displayName: string };
      }>(hubData.handlers, 'spaceAgent.createTemplate', {
        key: 'release.custom',
        handle: 'release',
        displayName: 'Release',
      });

      expect(result.template.key).toBe('release.custom');
      expect(result.template.handle).toBe('release');
      expect(result.template.displayName).toBe('Release');
    });

    it('throws when key is missing', async () => {
      await expect(
        call(hubData.handlers, 'spaceAgent.createTemplate', { handle: 'release' })
      ).rejects.toThrow('key is required');
    });

    it('throws when handle is missing', async () => {
      await expect(
        call(hubData.handlers, 'spaceAgent.createTemplate', { key: 'release.custom' })
      ).rejects.toThrow('handle is required');
    });

    it('surfaces manager validation errors for a duplicate key', async () => {
      await call(hubData.handlers, 'spaceAgent.createTemplate', {
        key: 'dup.custom',
        handle: 'dup',
      });

      await expect(
        call(hubData.handlers, 'spaceAgent.createTemplate', { key: 'dup.custom', handle: 'dup' })
      ).rejects.toThrow('already exists');
    });
  });

  describe('spaceAgent.updateTemplate', () => {
    it('updates a custom template and returns it', async () => {
      await call(hubData.handlers, 'spaceAgent.createTemplate', {
        key: 'update.custom',
        handle: 'update',
        displayName: 'Before',
      });

      const result = await call<{ template: { displayName: string } | null }>(
        hubData.handlers,
        'spaceAgent.updateTemplate',
        { key: 'update.custom', displayName: 'After' }
      );

      expect(result.template?.displayName).toBe('After');
    });

    it('throws when key is missing', async () => {
      await expect(
        call(hubData.handlers, 'spaceAgent.updateTemplate', { displayName: 'X' })
      ).rejects.toThrow('key is required');
    });

    it('throws for an unknown key', async () => {
      await expect(
        call(hubData.handlers, 'spaceAgent.updateTemplate', {
          key: 'missing.custom',
          displayName: 'X',
        })
      ).rejects.toThrow('Template not found: missing.custom');
    });
  });

  describe('spaceAgent.deleteTemplate', () => {
    it('deletes a custom template', async () => {
      await call(hubData.handlers, 'spaceAgent.createTemplate', {
        key: 'delete.custom',
        handle: 'delete',
      });

      const result = await call<{ success: boolean }>(
        hubData.handlers,
        'spaceAgent.deleteTemplate',
        { key: 'delete.custom' }
      );

      expect(result.success).toBe(true);
      const list = await call<{ templates: Array<{ key: string }> }>(
        hubData.handlers,
        'spaceAgent.listTemplates',
        {}
      );
      expect(list.templates.map((template) => template.key)).not.toContain('delete.custom');
    });

    it('throws when key is missing', async () => {
      await expect(call(hubData.handlers, 'spaceAgent.deleteTemplate', {})).rejects.toThrow(
        'key is required'
      );
    });

    it('throws for an unknown key', async () => {
      await expect(
        call(hubData.handlers, 'spaceAgent.deleteTemplate', { key: 'missing.custom' })
      ).rejects.toThrow('Template not found: missing.custom');
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

    it('keeps scoped Bash patterns and drops bare Bash when promoting a scoped session', async () => {
      insertSession(db, {
        id: 'session-scoped-bash',
        type: 'space_chat',
        context: { spaceId: 'space-1' },
        config: {
          model: 'claude-sonnet-4-5',
          maxTokens: 4096,
          temperature: 0,
          sdkToolsPreset: { type: 'preset', preset: 'claude_code' },
          allowedTools: ['Task', 'Bash(gh pr view:*)', 'Bash(jq:*)'],
          disallowedTools: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'],
        },
      });

      const result = await call<{ draft: { tools?: string[] } }>(
        hubData.handlers,
        'spaceAgent.getPromotionDraft',
        { spaceId: 'space-1', sessionId: 'session-scoped-bash' }
      );

      expect(result.draft.tools).toContain('Bash(gh pr view:*)');
      expect(result.draft.tools).toContain('Bash(jq:*)');
      expect(result.draft.tools).toContain('Task');
      expect(result.draft.tools).not.toContain('Bash');
      expect(result.draft.tools).not.toContain('Write');
      expect(result.draft.tools).not.toContain('Edit');
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

    it('creates a unified agent from a reviewed promotion draft', async () => {
      insertSession(db, {
        id: 'session-3',
        type: 'space_chat',
        context: { spaceId: 'space-1' },
      });

      const result = await call<{
        agent: {
          id: string;
          displayName: string;
          instructions: string;
          toolPermissions: Record<string, unknown>;
        };
      }>(hubData.handlers, 'spaceAgent.promoteSession', {
        spaceId: 'space-1',
        sessionId: 'session-3',
        name: 'Release Agent',
        customPrompt: 'Reviewed profile',
        tools: ['Read'],
      });

      expect(result.agent.displayName).toBe('Release Agent');
      expect(result.agent.instructions).toBe('Reviewed profile');
      expect(result.agent.toolPermissions).toEqual({ tools: ['Read'] });
      expect(longHorizonRepo.listBySpaceId('space-1').some((a) => a.id === result.agent.id)).toBe(
        true
      );
      expect(daemonData.publishMock).toHaveBeenCalledWith(
        'spaceAgent.created',
        expect.objectContaining({ spaceId: 'space-1' })
      );
    });

    it('persists template key metadata when promoting from a template', async () => {
      insertSession(db, {
        id: 'session-template-promotion',
        type: 'space_chat',
        context: { spaceId: 'space-1' },
      });

      const result = await call<{ agent: { templateKey: string | null } }>(
        hubData.handlers,
        'spaceAgent.promoteSession',
        {
          spaceId: 'space-1',
          sessionId: 'session-template-promotion',
          name: 'Template Promotion',
          templateName: 'Coder',
        }
      );

      expect(result.agent.templateKey).toBe('Coder');
    });
  });

  describe('spaceAgent.create', () => {
    it('registers the handler', () => {
      expect(hubData.handlers.has('spaceAgent.create')).toBe(true);
    });

    it('creates a unified agent with required params', async () => {
      const result = await call<{ agent: { id: string; displayName: string; handle: string } }>(
        hubData.handlers,
        'spaceAgent.create',
        { spaceId: 'space-1', name: 'MyAgent' }
      );

      expect(result.agent).toBeDefined();
      expect(result.agent.displayName).toBe('MyAgent');
      expect(result.agent.handle).toBe('myagent');
      expect(longHorizonRepo.getById(result.agent.id)?.displayName).toBe('MyAgent');
    });

    it('creates a unified agent with all optional params', async () => {
      const result = await call<{
        agent: {
          displayName: string;
          description: string;
          model: string | null;
          instructions: string;
          toolPermissions: Record<string, unknown>;
        };
      }>(hubData.handlers, 'spaceAgent.create', {
        spaceId: 'space-1',
        name: 'FullAgent',
        description: 'A detailed agent',
        model: 'claude-opus-4-5',
        provider: 'anthropic',
        customPrompt: 'You are helpful.',
        tools: ['Read', 'Grep'],
        settingSources: ['project'],
      });

      expect(result.agent.displayName).toBe('FullAgent');
      expect(result.agent.description).toBe('A detailed agent');
      expect(result.agent.instructions).toBe('You are helpful.');
      expect(result.agent.model).toBe('claude-opus-4-5');
      expect(result.agent.toolPermissions).toEqual({ tools: ['Read', 'Grep'] });
    });

    it('creates a unified agent from long-horizon vocabulary params', async () => {
      const result = await call<{
        agent: {
          handle: string;
          displayName: string;
          instructions: string;
          autonomyLevel: number | null;
        };
      }>(hubData.handlers, 'spaceAgent.create', {
        spaceId: 'space-1',
        handle: 'observer',
        displayName: 'Observer',
        instructions: 'Watch for events',
        autonomyLevel: 2,
        toolPermissions: { tools: ['Read'] },
      });

      expect(result.agent.handle).toBe('observer');
      expect(result.agent.displayName).toBe('Observer');
      expect(result.agent.instructions).toBe('Watch for events');
      expect(result.agent.autonomyLevel).toBe(2);
    });

    it('persists template key metadata on create', async () => {
      const result = await call<{ agent: { templateKey: string | null } }>(
        hubData.handlers,
        'spaceAgent.create',
        {
          spaceId: 'space-1',
          name: 'TemplateAgent',
          templateName: 'Coder',
        }
      );

      expect(result.agent.templateKey).toBe('Coder');
    });

    it('seeds suggested event subscriptions and reminder defaults on create', async () => {
      const result = await call<{ agent: { id: string } }>(hubData.handlers, 'spaceAgent.create', {
        spaceId: 'space-1',
        name: 'SeededAgent',
        templateKey: 'coordinator.default',
        suggestedEventSubscriptions: [
          { source: 'space', topic: 'task.*', filter: { statuses: ['blocked'] } },
        ],
        reminderDefaults: [
          {
            title: 'Review Space plan',
            body: 'Review active goals and blocked work.',
            triggerType: 'cron',
            cronExpression: '0 9 * * 1',
            timezone: 'UTC',
          },
        ],
      });

      const subscriptions = longHorizonRepo.listSubscriptions(result.agent.id);
      expect(subscriptions).toHaveLength(1);
      expect(subscriptions[0]).toMatchObject({
        source: 'space',
        topic: 'task.*',
        status: 'active',
        filter: { statuses: ['blocked'] },
      });

      const reminders = longHorizonRepo.listReminders(result.agent.id);
      expect(reminders).toHaveLength(1);
      expect(reminders[0]).toMatchObject({
        title: 'Review Space plan',
        status: 'active',
        cronExpression: '0 9 * * 1',
        timezone: 'UTC',
      });
      expect(reminders[0].nextRunAt).toBeGreaterThan(0);
    });

    it('seeds no subscriptions or reminders when none are provided', async () => {
      const result = await call<{ agent: { id: string } }>(hubData.handlers, 'spaceAgent.create', {
        spaceId: 'space-1',
        name: 'UnseededAgent',
      });

      expect(longHorizonRepo.listSubscriptions(result.agent.id)).toEqual([]);
      expect(longHorizonRepo.listReminders(result.agent.id)).toEqual([]);
    });

    it('skips suggested subscriptions the runtime cannot route on create', async () => {
      const result = await call<{ agent: { id: string } }>(hubData.handlers, 'spaceAgent.create', {
        spaceId: 'space-1',
        name: 'MixedSubsAgent',
        suggestedEventSubscriptions: [
          { source: 'crm', topic: 'deal.*', filter: {} },
          { source: 'github', topic: 'release.published', filter: {} },
          { source: 'space', topic: 'bad topic!', filter: {} },
          { source: 'space', topic: 'task.*', filter: {} },
        ],
      });

      const subscriptions = longHorizonRepo.listSubscriptions(result.agent.id);
      expect(subscriptions).toHaveLength(1);
      expect(subscriptions[0]).toMatchObject({ source: 'space', topic: 'task.*' });
    });

    it('creates the agent even when every suggested subscription is unroutable', async () => {
      const result = await call<{ agent: { id: string; handle: string } }>(
        hubData.handlers,
        'spaceAgent.create',
        {
          spaceId: 'space-1',
          name: 'SalesAgent',
          templateKey: 'sales.default',
          suggestedEventSubscriptions: [{ source: 'crm', topic: 'deal.*', filter: {} }],
        }
      );

      expect(result.agent.handle).toBe('salesagent');
      expect(longHorizonRepo.listSubscriptions(result.agent.id)).toEqual([]);
    });

    it('rejects invalid reminder default cron expressions on create', async () => {
      await expect(
        call(hubData.handlers, 'spaceAgent.create', {
          spaceId: 'space-1',
          name: 'BadReminderAgent',
          reminderDefaults: [
            {
              title: 'Broken',
              body: '',
              triggerType: 'cron',
              cronExpression: 'not-a-cron',
              timezone: 'UTC',
            },
          ],
        })
      ).rejects.toThrow('invalid cron expression');
    });

    it('rejects reminder defaults that cannot be scheduled on create', async () => {
      await expect(
        call(hubData.handlers, 'spaceAgent.create', {
          spaceId: 'space-1',
          name: 'AtReminderAgent',
          reminderDefaults: [
            { title: 'Once', body: '', triggerType: 'at', cronExpression: null, timezone: 'UTC' },
          ],
        })
      ).rejects.toThrow('reminderDefaults only supports triggerType "cron"');

      await expect(
        call(hubData.handlers, 'spaceAgent.create', {
          spaceId: 'space-1',
          name: 'BadTzAgent',
          reminderDefaults: [
            {
              title: 'Weekly',
              body: '',
              triggerType: 'cron',
              cronExpression: '0 9 * * 1',
              timezone: 'Not/AZone',
            },
          ],
        })
      ).rejects.toThrow('Invalid timezone or cron expression');
    });

    it('drops a seeded subscription when the runtime refresh rejects it', async () => {
      const runtimeService = {
        ...createRuntimeServiceMock(),
        refreshLongHorizonSubscription: mock(() => ({ success: false, error: 'invalid pattern' })),
      };
      const freshHub = createMockMessageHub();
      setupSpaceAgentHandlers(
        freshHub.hub,
        daemonData.internalEventBus,
        spaceManagerData.spaceManager,
        createTestDatabaseFacade(db),
        longHorizonRepo,
        workflowRepo,
        runtimeService,
        new SpaceAgentTemplateManager(new SpaceAgentTemplateRepository(db as any))
      );

      const result = await call<{ agent: { id: string } }>(freshHub.handlers, 'spaceAgent.create', {
        spaceId: 'space-1',
        name: 'RefreshFailAgent',
        suggestedEventSubscriptions: [{ source: 'space', topic: 'task.*', filter: {} }],
      });

      expect(longHorizonRepo.listSubscriptions(result.agent.id)).toEqual([]);
    });

    it('emits unified created events after creation', async () => {
      await call(hubData.handlers, 'spaceAgent.create', {
        spaceId: 'space-1',
        name: 'EventAgent',
      });

      await new Promise((r) => setTimeout(r, 0));

      expect(daemonData.publishMock).toHaveBeenCalled();
      const published = daemonData.publishMock.mock.calls as Array<
        [string, { spaceId: string; agent: { displayName: string } }]
      >;
      expect(published.map(([name]) => name)).toEqual(
        expect.arrayContaining(['spaceAgent.created'])
      );
      for (const [, payload] of published) {
        expect(payload.spaceId).toBe('space-1');
        expect(payload.agent.displayName).toBe('EventAgent');
      }
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

    it('rejects unknown tools with the worker-path validation error', async () => {
      await expect(
        call(hubData.handlers, 'spaceAgent.create', {
          spaceId: 'space-1',
          name: 'BadTools',
          tools: ['Read', 'NotARealTool'],
        })
      ).rejects.toThrow('Unknown tool: "NotARealTool"');
    });

    it('rejects unknown tools passed via toolPermissions', async () => {
      await expect(
        call(hubData.handlers, 'spaceAgent.create', {
          spaceId: 'space-1',
          handle: 'bad-tools-lh',
          displayName: 'BadTools LH',
          toolPermissions: { tools: ['NotARealTool'] },
        })
      ).rejects.toThrow('Unknown tool: "NotARealTool"');
    });

    it('rejects unrecognized models when the model cache is populated', async () => {
      setModelsCache(
        new Map([
          [
            'global',
            [
              {
                id: 'known-model',
                name: 'known-model',
                alias: 'known-model',
                family: 'sonnet',
                provider: 'anthropic',
                contextWindow: 128000,
                description: 'known model',
                releaseDate: '',
                available: true,
              },
            ],
          ],
        ])
      );

      await expect(
        call(hubData.handlers, 'spaceAgent.create', {
          spaceId: 'space-1',
          name: 'BadModel',
          model: 'unknown-model',
        })
      ).rejects.toThrow('Unrecognized model');
    });

    it('suffixes a colliding explicit handle on create', async () => {
      await call(hubData.handlers, 'spaceAgent.create', {
        spaceId: 'space-1',
        name: 'Duplicate Handle',
      });

      const result = await call<{ agent: { handle: string } }>(
        hubData.handlers,
        'spaceAgent.create',
        {
          spaceId: 'space-1',
          name: 'Duplicate Handle 2',
          handle: 'duplicate-handle',
        }
      );

      expect(result.agent.handle).toBe('duplicate-handle-2');
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
      ).rejects.toThrow(/already used by/);
    });

    it('throws on names colliding with a worker mirror display name', async () => {
      seedWorkerMirror(db, { id: 'worker-named', spaceId: 'space-1', name: 'Worker Named' });

      await expect(
        call(hubData.handlers, 'spaceAgent.create', {
          spaceId: 'space-1',
          name: 'worker named',
        })
      ).rejects.toThrow('already used by');
    });
  });

  describe('spaceAgent.list', () => {
    it('registers the handler', () => {
      expect(hubData.handlers.has('spaceAgent.list')).toBe(true);
    });

    it('self-heals the coordinator into the unified list (C-3)', async () => {
      const result = await call<{ agents: { handle: string; displayName: string }[] }>(
        hubData.handlers,
        'spaceAgent.list',
        {
          spaceId: 'space-1',
        }
      );
      expect(result.agents).toHaveLength(1);
      expect(result.agents[0].handle).toBe('space-manager');
      expect(longHorizonRepo.getById(coordinatorLongHorizonAgentId('space-1'))).not.toBeNull();
    });

    it('returns unified agents for a space alongside the coordinator', async () => {
      await call(hubData.handlers, 'spaceAgent.create', {
        spaceId: 'space-1',
        name: 'Alpha',
      });
      await call(hubData.handlers, 'spaceAgent.create', {
        spaceId: 'space-1',
        name: 'Beta',
      });

      const result = await call<{ agents: { displayName: string }[] }>(
        hubData.handlers,
        'spaceAgent.list',
        { spaceId: 'space-1' }
      );
      expect(result.agents).toHaveLength(3);
      const names = result.agents.map((a) => a.displayName).sort();
      expect(names).toEqual(['Alpha', 'Beta', 'Space Manager']);
    });

    it('includes worker mirrors in the unified list', async () => {
      seedWorkerMirror(db, { id: 'worker-listed', spaceId: 'space-1', name: 'Worker Listed' });

      const result = await call<{ agents: { displayName: string }[] }>(
        hubData.handlers,
        'spaceAgent.list',
        { spaceId: 'space-1' }
      );
      const names = result.agents.map((a) => a.displayName);
      expect(names).toContain('Worker Listed');
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

    it('returns the unified agent by id', async () => {
      const created = await call<{ agent: { id: string; displayName: string } }>(
        hubData.handlers,
        'spaceAgent.create',
        { spaceId: 'space-1', name: 'GetMe' }
      );

      const result = await call<{ agent: { id: string; displayName: string } }>(
        hubData.handlers,
        'spaceAgent.get',
        { id: created.agent.id }
      );
      expect(result.agent.id).toBe(created.agent.id);
      expect(result.agent.displayName).toBe('GetMe');
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

  describe('spaceAgent.ensureSession', () => {
    it('registers the handler', () => {
      expect(hubData.handlers.has('spaceAgent.ensureSession')).toBe(true);
    });

    it('ensures the agent session and returns the deterministic id', async () => {
      const runtimeService = createRuntimeServiceMock();
      const freshHub = createMockMessageHub();
      setupSpaceAgentHandlers(
        freshHub.hub,
        daemonData.internalEventBus,
        spaceManagerData.spaceManager,
        createTestDatabaseFacade(db),
        longHorizonRepo,
        workflowRepo,
        runtimeService
      );
      longHorizonRepo.create({ id: 'lh-ensure-1', spaceId: 'space-1', handle: 'researcher' });

      const result = await call<{ sessionId: string }>(
        freshHub.handlers,
        'spaceAgent.ensureSession',
        {
          spaceId: 'space-1',
          agentId: 'lh-ensure-1',
        }
      );

      expect(result.sessionId).toBe('space:agent:space-1:lh-ensure-1');
      expect(runtimeService.ensureAgentSession).toHaveBeenCalledWith('space-1', 'lh-ensure-1');
    });

    it('maps the coordinator agent to the space chat session', async () => {
      const runtimeService = createRuntimeServiceMock();
      const freshHub = createMockMessageHub();
      setupSpaceAgentHandlers(
        freshHub.hub,
        daemonData.internalEventBus,
        spaceManagerData.spaceManager,
        createTestDatabaseFacade(db),
        longHorizonRepo,
        workflowRepo,
        runtimeService
      );
      const coordinatorId = coordinatorLongHorizonAgentId('space-1');
      longHorizonRepo.create({
        id: coordinatorId,
        spaceId: 'space-1',
        handle: 'coordinator',
      });

      const result = await call<{ sessionId: string }>(
        freshHub.handlers,
        'spaceAgent.ensureSession',
        {
          spaceId: 'space-1',
          agentId: coordinatorId,
        }
      );

      expect(result.sessionId).toBe('space:chat:space-1');
      expect(runtimeService.ensureAgentSession).toHaveBeenCalledWith('space-1', coordinatorId);
    });

    it('maps the coordinator alias to the space chat session', async () => {
      const runtimeService = createRuntimeServiceMock();
      const freshHub = createMockMessageHub();
      setupSpaceAgentHandlers(
        freshHub.hub,
        daemonData.internalEventBus,
        spaceManagerData.spaceManager,
        createTestDatabaseFacade(db),
        longHorizonRepo,
        workflowRepo,
        runtimeService
      );
      longHorizonRepo.create({
        id: coordinatorLongHorizonAgentId('space-1'),
        spaceId: 'space-1',
        handle: 'coordinator',
      });

      const result = await call<{ sessionId: string }>(
        freshHub.handlers,
        'spaceAgent.ensureSession',
        {
          spaceId: 'space-1',
          agentId: 'coordinator:space-1',
        }
      );

      expect(result.sessionId).toBe('space:chat:space-1');
      expect(runtimeService.ensureAgentSession).toHaveBeenCalledWith(
        'space-1',
        'coordinator:space-1'
      );
    });

    it('maps the bare coordinator alias even before a coordinator record exists', async () => {
      const runtimeService = createRuntimeServiceMock();
      const freshHub = createMockMessageHub();
      setupSpaceAgentHandlers(
        freshHub.hub,
        daemonData.internalEventBus,
        spaceManagerData.spaceManager,
        createTestDatabaseFacade(db),
        longHorizonRepo,
        workflowRepo,
        runtimeService
      );

      const result = await call<{ sessionId: string }>(
        freshHub.handlers,
        'spaceAgent.ensureSession',
        {
          spaceId: 'space-1',
          agentId: 'coordinator',
        }
      );

      expect(result.sessionId).toBe('space:chat:space-1');
    });

    it('rejects unknown agents before provisioning', async () => {
      const runtimeService = createRuntimeServiceMock();
      const freshHub = createMockMessageHub();
      setupSpaceAgentHandlers(
        freshHub.hub,
        daemonData.internalEventBus,
        spaceManagerData.spaceManager,
        createTestDatabaseFacade(db),
        longHorizonRepo,
        workflowRepo,
        runtimeService
      );

      await expect(
        call(freshHub.handlers, 'spaceAgent.ensureSession', {
          spaceId: 'space-1',
          agentId: 'never-created',
        })
      ).rejects.toThrow('Agent not found: never-created');
      expect(runtimeService.ensureAgentSession).not.toHaveBeenCalled();
    });

    it('rejects when the runtime cannot ensure the session', async () => {
      const runtimeService = createRuntimeServiceMock();
      runtimeService.ensureAgentSession.mockResolvedValueOnce(null);
      const freshHub = createMockMessageHub();
      setupSpaceAgentHandlers(
        freshHub.hub,
        daemonData.internalEventBus,
        spaceManagerData.spaceManager,
        createTestDatabaseFacade(db),
        longHorizonRepo,
        workflowRepo,
        runtimeService
      );
      longHorizonRepo.create({ id: 'lh-ensure-1', spaceId: 'space-1', handle: 'researcher' });

      await expect(
        call(freshHub.handlers, 'spaceAgent.ensureSession', {
          spaceId: 'space-1',
          agentId: 'lh-ensure-1',
        })
      ).rejects.toThrow('Agent session unavailable: lh-ensure-1');
    });

    it('throws when spaceId is missing or the space is unknown', async () => {
      const runtimeService = createRuntimeServiceMock();
      const freshHub = createMockMessageHub();
      setupSpaceAgentHandlers(
        freshHub.hub,
        daemonData.internalEventBus,
        spaceManagerData.spaceManager,
        createTestDatabaseFacade(db),
        longHorizonRepo,
        workflowRepo,
        runtimeService
      );

      await expect(
        call(freshHub.handlers, 'spaceAgent.ensureSession', { agentId: 'lh-1' })
      ).rejects.toThrow('spaceId is required');
      await expect(
        call(freshHub.handlers, 'spaceAgent.ensureSession', {
          spaceId: 'missing-space',
          agentId: 'lh-1',
        })
      ).rejects.toThrow('Space not found: missing-space');
    });
  });

  describe('ensure-agent-session-rpc stages', () => {
    it('validate stage lifts params and rejects missing fields', () => {
      expect(() => ensureSessionValidateStage({})).toThrow('spaceId is required');
      expect(() => ensureSessionValidateStage({ spaceId: 'space-1' })).toThrow(
        'agentId is required'
      );
      expect(ensureSessionValidateStage({ spaceId: 'space-1', agentId: 'lh-1' })).toEqual({
        spaceId: 'space-1',
        agentId: 'lh-1',
      });
    });

    it('admit-space stage rejects unknown spaces and passes known ones', async () => {
      await expect(
        ensureSessionAdmitSpaceStage(spaceManagerData.spaceManager, 'missing-space')
      ).rejects.toThrow('Space not found: missing-space');
      await expect(
        ensureSessionAdmitSpaceStage(spaceManagerData.spaceManager, 'space-1')
      ).resolves.toBeDefined();
    });

    it('resolve-target stage derives the session id per target shape', () => {
      longHorizonRepo.create({ id: 'lh-stage-1', spaceId: 'space-1', handle: 'researcher' });
      longHorizonRepo.create({
        id: coordinatorLongHorizonAgentId('space-1'),
        spaceId: 'space-1',
        handle: 'coordinator',
      });

      expect(ensureSessionResolveTargetStage(longHorizonRepo, 'space-1', 'lh-stage-1')).toBe(
        'space:agent:space-1:lh-stage-1'
      );
      expect(ensureSessionResolveTargetStage(longHorizonRepo, 'space-1', 'coordinator')).toBe(
        'space:chat:space-1'
      );
      expect(
        ensureSessionResolveTargetStage(longHorizonRepo, 'space-1', 'coordinator:space-1')
      ).toBe('space:chat:space-1');
      expect(
        ensureSessionResolveTargetStage(
          longHorizonRepo,
          'space-1',
          coordinatorLongHorizonAgentId('space-1')
        )
      ).toBe('space:chat:space-1');
    });

    it('resolve-target stage rejects unknown or foreign agents', () => {
      longHorizonRepo.create({ id: 'lh-stage-1', spaceId: 'space-1', handle: 'researcher' });

      expect(() =>
        ensureSessionResolveTargetStage(longHorizonRepo, 'space-1', 'never-created')
      ).toThrow('Agent not found: never-created');
      expect(() =>
        ensureSessionResolveTargetStage(longHorizonRepo, 'space-other', 'lh-stage-1')
      ).toThrow('Agent not found: lh-stage-1');
    });

    it('provision stage rejects missing runtime, failed ensure, and passes results', async () => {
      await expect(ensureSessionProvisionStage(undefined, 'space-1', 'lh-1')).rejects.toThrow(
        'Agent runtime unavailable'
      );

      const failed = createRuntimeServiceMock();
      failed.ensureAgentSession.mockResolvedValueOnce(null);
      await expect(ensureSessionProvisionStage(failed, 'space-1', 'lh-1')).rejects.toThrow(
        'Agent session unavailable: lh-1'
      );

      const runtimeService = createRuntimeServiceMock();
      await expect(ensureSessionProvisionStage(runtimeService, 'space-1', 'lh-1')).resolves.toEqual(
        { ensured: true }
      );
      expect(runtimeService.ensureAgentSession).toHaveBeenCalledWith('space-1', 'lh-1');
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

    it('updates the unified agent name', async () => {
      const result = await call<{ agent: { displayName: string } }>(
        hubData.handlers,
        'spaceAgent.update',
        { id: agentId, name: 'Renamed' }
      );
      expect(result.agent.displayName).toBe('Renamed');
      expect(longHorizonRepo.getById(agentId)?.displayName).toBe('Renamed');
    });

    it('accepts long-horizon vocabulary updates', async () => {
      const result = await call<{ agent: { displayName: string; instructions: string } }>(
        hubData.handlers,
        'spaceAgent.update',
        { agentId, displayName: 'LH Renamed', instructions: 'LH prompt' }
      );
      expect(result.agent.displayName).toBe('LH Renamed');
      expect(result.agent.instructions).toBe('LH prompt');
    });

    it('updates description and customPrompt-mapped instructions', async () => {
      const result = await call<{
        agent: { description: string | null; instructions: string };
      }>(hubData.handlers, 'spaceAgent.update', {
        id: agentId,
        description: 'New desc',
        customPrompt: 'New prompt',
      });
      expect(result.agent.description).toBe('New desc');
      expect(result.agent.instructions).toBe('New prompt');
    });

    it('clears tools to an empty permission set when tools is nulled', async () => {
      await call(hubData.handlers, 'spaceAgent.update', {
        id: agentId,
        tools: ['Read'],
      });

      const result = await call<{ agent: { toolPermissions: Record<string, unknown> } }>(
        hubData.handlers,
        'spaceAgent.update',
        { id: agentId, tools: null }
      );
      expect(result.agent.toolPermissions).toEqual({});
    });

    it('clears template tracking metadata on update', async () => {
      const created = await call<{ agent: { id: string } }>(hubData.handlers, 'spaceAgent.create', {
        spaceId: 'space-1',
        name: 'TemplateTracked',
        templateName: 'Coder',
      });

      const result = await call<{ agent: { templateKey: string | null } }>(
        hubData.handlers,
        'spaceAgent.update',
        {
          id: created.agent.id,
          templateName: null,
        }
      );

      expect(result.agent.templateKey).toBeNull();
    });

    it('rejects reserved handles on unified updates', async () => {
      await expect(
        call(hubData.handlers, 'spaceAgent.update', {
          id: agentId,
          handle: 'system-runtime',
        })
      ).rejects.toThrow('is reserved');
    });

    it('rejects handle changes and deactivating statuses on the default agent row (C-2 lock)', async () => {
      const coordinator = longHorizonRepo.ensureCoordinator('space-1');

      await expect(
        call(hubData.handlers, 'spaceAgent.update', {
          id: coordinator.id,
          spaceId: 'space-1',
          handle: 'renamed',
        })
      ).rejects.toThrow('handle is locked');

      for (const status of ['paused', 'archived', 'disabled']) {
        await expect(
          call(hubData.handlers, 'spaceAgent.update', {
            id: coordinator.id,
            spaceId: 'space-1',
            status,
          })
        ).rejects.toThrow('cannot be paused, archived, or disabled');
      }

      expect(longHorizonRepo.getById(coordinator.id)?.status).toBe('active');

      const edited = await call<{ agent: { instructions: string } }>(
        hubData.handlers,
        'spaceAgent.update',
        { id: coordinator.id, spaceId: 'space-1', instructions: 'Coordinate everything.' }
      );
      expect(edited.agent.instructions).toBe('Coordinate everything.');
    });

    it('clears the session provider when the override is explicitly cleared (P2)', async () => {
      const runtimeService = createRuntimeServiceMock();
      const freshHub = createMockMessageHub();
      setupSpaceAgentHandlers(
        freshHub.hub,
        daemonData.internalEventBus,
        spaceManagerData.spaceManager,
        createTestDatabaseFacade(db),
        longHorizonRepo,
        workflowRepo,
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
      const runtimeService = createRuntimeServiceMock();
      const freshHub = createMockMessageHub();
      setupSpaceAgentHandlers(
        freshHub.hub,
        daemonData.internalEventBus,
        spaceManagerData.spaceManager,
        createTestDatabaseFacade(db),
        longHorizonRepo,
        workflowRepo,
        runtimeService
      );

      await call(freshHub.handlers, 'spaceAgent.update', { id: agentId, provider: 'kimi' });
      await call(freshHub.handlers, 'spaceAgent.update', { id: agentId, name: 'Renamed' });

      expect(runtimeService.clearLongTermAgentSessionProvider).not.toHaveBeenCalled();
    });

    it('rejects unknown tools on unified updates', async () => {
      await expect(
        call(hubData.handlers, 'spaceAgent.update', {
          id: agentId,
          tools: ['NotARealTool'],
        })
      ).rejects.toThrow('Unknown tool: "NotARealTool"');
    });

    it('refreshes the stamped session after updating an agent', async () => {
      const runtimeService = createRuntimeServiceMock();
      const freshHub = createMockMessageHub();
      setupSpaceAgentHandlers(
        freshHub.hub,
        daemonData.internalEventBus,
        spaceManagerData.spaceManager,
        createTestDatabaseFacade(db),
        longHorizonRepo,
        workflowRepo,
        runtimeService
      );
      longHorizonRepo.create({
        id: 'lh-stamped',
        spaceId: 'space-1',
        handle: 'stamped',
        sessionId: 'space:agent:space-1:lh-stamped',
      });

      await call(freshHub.handlers, 'spaceAgent.update', {
        id: 'lh-stamped',
        instructions: 'Newly saved instructions',
      });

      expect(runtimeService.refreshLongHorizonAgentSession).toHaveBeenCalledWith(
        'space-1',
        'lh-stamped'
      );
    });

    it('delays the update event until the stamped-session refresh succeeds', async () => {
      const runtimeService = createRuntimeServiceMock();
      runtimeService.refreshLongHorizonAgentSession.mockRejectedValueOnce(
        new Error('refresh failed')
      );
      const freshHub = createMockMessageHub();
      setupSpaceAgentHandlers(
        freshHub.hub,
        daemonData.internalEventBus,
        spaceManagerData.spaceManager,
        createTestDatabaseFacade(db),
        longHorizonRepo,
        workflowRepo,
        runtimeService
      );
      longHorizonRepo.create({
        id: 'lh-stamped-late',
        spaceId: 'space-1',
        handle: 'stamped-late',
        sessionId: 'space:agent:space-1:lh-stamped-late',
      });
      daemonData.publishMock.mockClear();

      await expect(
        call(freshHub.handlers, 'spaceAgent.update', {
          id: 'lh-stamped-late',
          instructions: 'Newly saved instructions',
        })
      ).rejects.toThrow('refresh failed');

      expect(
        daemonData.publishMock.mock.calls.filter(([name]) => name === 'spaceAgent.updated')
      ).toHaveLength(0);
    });

    it('publishes a fresh repository read after the refresh', async () => {
      const runtimeService = createRuntimeServiceMock();
      runtimeService.refreshLongHorizonAgentSession.mockImplementationOnce(async () => {
        longHorizonRepo.update('lh-raced-stamp', { sessionId: null });
      });
      const freshHub = createMockMessageHub();
      setupSpaceAgentHandlers(
        freshHub.hub,
        daemonData.internalEventBus,
        spaceManagerData.spaceManager,
        createTestDatabaseFacade(db),
        longHorizonRepo,
        workflowRepo,
        runtimeService
      );
      longHorizonRepo.create({
        id: 'lh-raced-stamp',
        spaceId: 'space-1',
        handle: 'raced-stamp',
        sessionId: 'space:agent:space-1:lh-raced-stamp',
      });
      daemonData.publishMock.mockClear();

      const result = await call<{ agent: { id: string } }>(freshHub.handlers, 'spaceAgent.update', {
        id: 'lh-raced-stamp',
        instructions: 'Newly saved instructions',
      });

      expect(result.agent.id).toBe('lh-raced-stamp');
      const published = daemonData.publishMock.mock.calls.filter(
        ([name]) => name === 'spaceAgent.updated'
      ) as Array<[string, { agent: { id: string; sessionId: string | null } }]>;
      expect(published).toHaveLength(1);
      expect(published[0][1].agent.sessionId).toBeNull();
    });

    it('skips the update event when the agent is deleted mid-update', async () => {
      const runtimeService = createRuntimeServiceMock();
      runtimeService.refreshLongHorizonAgentSession.mockImplementationOnce(async () => {
        longHorizonRepo.delete('lh-deleted-mid-update');
      });
      const freshHub = createMockMessageHub();
      setupSpaceAgentHandlers(
        freshHub.hub,
        daemonData.internalEventBus,
        spaceManagerData.spaceManager,
        createTestDatabaseFacade(db),
        longHorizonRepo,
        workflowRepo,
        runtimeService
      );
      longHorizonRepo.create({
        id: 'lh-deleted-mid-update',
        spaceId: 'space-1',
        handle: 'deleted-mid-update',
        sessionId: 'space:agent:space-1:lh-deleted-mid-update',
      });
      daemonData.publishMock.mockClear();

      await call(freshHub.handlers, 'spaceAgent.update', {
        id: 'lh-deleted-mid-update',
        instructions: 'Updated before deletion',
      });

      expect(
        daemonData.publishMock.mock.calls.filter(([name]) => name === 'spaceAgent.updated')
      ).toHaveLength(0);
    });

    it('serializes concurrent updates for the same agent', async () => {
      const runtimeService = createRuntimeServiceMock();
      let resolveFirstRefresh: () => void = () => {};
      runtimeService.refreshLongHorizonAgentSession.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFirstRefresh = resolve;
          })
      );
      const freshHub = createMockMessageHub();
      setupSpaceAgentHandlers(
        freshHub.hub,
        daemonData.internalEventBus,
        spaceManagerData.spaceManager,
        createTestDatabaseFacade(db),
        longHorizonRepo,
        workflowRepo,
        runtimeService
      );
      const created = await call<{ agent: { id: string } }>(
        freshHub.handlers,
        'spaceAgent.create',
        { spaceId: 'space-1', name: 'Serial Target' }
      );
      longHorizonRepo.update(created.agent.id, {
        sessionId: `space:agent:space-1:${created.agent.id}`,
      });

      const first = call(freshHub.handlers, 'spaceAgent.update', {
        id: created.agent.id,
        name: 'First Rename',
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      const second = call(freshHub.handlers, 'spaceAgent.update', {
        id: created.agent.id,
        name: 'Second Rename',
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(longHorizonRepo.getById(created.agent.id)?.displayName).toBe('First Rename');

      resolveFirstRefresh();
      await first;
      await second;

      expect(longHorizonRepo.getById(created.agent.id)?.displayName).toBe('Second Rename');
    });

    it('rejects create ids containing reserved characters', async () => {
      await expect(
        call(hubData.handlers, 'spaceAgent.create', {
          spaceId: 'space-1',
          name: 'Bad Id',
          id: 'agent:id',
        })
      ).rejects.toThrow('id may only contain letters, digits, underscores, and hyphens');
      await expect(
        call(hubData.handlers, 'spaceAgent.create', {
          spaceId: 'space-1',
          name: 'Bad Path',
          id: 'a/b c',
        })
      ).rejects.toThrow('id may only contain letters, digits, underscores, and hyphens');
      await expect(
        call(hubData.handlers, 'spaceAgent.create', {
          spaceId: 'space-1',
          name: 'Alias Clash',
          id: 'coordinator',
        })
      ).rejects.toThrow('id "coordinator" is reserved');

      const created = await call<{ agent: { id: string } }>(hubData.handlers, 'spaceAgent.create', {
        spaceId: 'space-1',
        name: 'Good Id',
        id: 'custom-agent_1',
      });
      expect(created.agent.id).toBe('custom-agent_1');
    });

    it('routes mirror-row updates through the unified table', async () => {
      const workerId = 'worker-original';
      seedWorkerMirror(db, {
        id: workerId,
        spaceId: 'space-1',
        name: 'Worker Original',
        instructions: 'Worker prompt',
        tools: ['Read'],
      });

      const result = await call<{ agent: { displayName: string; instructions: string } }>(
        hubData.handlers,
        'spaceAgent.update',
        { id: workerId, name: 'Worker Renamed', customPrompt: 'Renamed prompt' }
      );

      expect(result.agent.displayName).toBe('Worker Renamed');
      expect(longHorizonRepo.getById(workerId)?.displayName).toBe('Worker Renamed');
      expect(longHorizonRepo.getById(workerId)?.instructions).toBe('Renamed prompt');
    });

    it('clears tools when long-horizon vocabulary sends empty toolPermissions', async () => {
      const workerId = 'twin-tool-clear';
      seedWorkerMirror(db, {
        id: workerId,
        spaceId: 'space-1',
        name: 'Twin Tool Clear',
        tools: ['Read'],
      });
      expect(longHorizonRepo.getById(workerId)?.toolPermissions).toEqual({ tools: ['Read'] });

      await call(hubData.handlers, 'spaceAgent.update', {
        id: workerId,
        toolPermissions: null,
      });

      expect(longHorizonRepo.getById(workerId)?.toolPermissions).toEqual({});
    });

    it('rejects deleting the coordinator through the unified namespace', async () => {
      const coordinator = longHorizonRepo.ensureCoordinator('space-1');

      await expect(
        call(hubData.handlers, 'spaceAgent.delete', { id: coordinator.id })
      ).rejects.toThrow('The Space Manager agent cannot be deleted');
      expect(longHorizonRepo.getById(coordinator.id)?.status).toBe('active');
    });

    it('rejects the reserved migration template key on native updates', async () => {
      await expect(
        call(hubData.handlers, 'spaceAgent.update', {
          id: agentId,
          templateKey: 'migration.legacy_space_agent',
        })
      ).rejects.toThrow('is reserved for migrated worker mirrors');
    });

    it('rejects unknown statuses on mirror updates instead of reactivating', async () => {
      const workerId = 'twin-bad-status';
      seedWorkerMirror(db, { id: workerId, spaceId: 'space-1', name: 'Twin Bad Status' });

      await expect(
        call(hubData.handlers, 'spaceAgent.update', {
          id: workerId,
          status: 'archive',
        })
      ).rejects.toThrow('Invalid agent status: archive');
      expect(longHorizonRepo.getById(workerId)?.status).toBe('active');
    });

    it('rejects autonomyLevel ceilings on mirror updates', async () => {
      const workerId = 'twin-autonomy';
      seedWorkerMirror(db, { id: workerId, spaceId: 'space-1', name: 'Twin Autonomy' });

      await expect(
        call(hubData.handlers, 'spaceAgent.update', { id: workerId, autonomyLevel: 3 })
      ).rejects.toThrow('autonomyLevel cannot be set on a migrated worker agent');
      expect(longHorizonRepo.getById(workerId)?.autonomyLevel).toBeNull();
    });

    it('rejects mirror rekeys through the templateName alias', async () => {
      const workerId = 'twin-alias-rekey';
      seedWorkerMirror(db, { id: workerId, spaceId: 'space-1', name: 'Twin Alias Rekey' });

      await expect(
        call(hubData.handlers, 'spaceAgent.update', {
          id: workerId,
          templateName: 'coordinator.default',
        })
      ).rejects.toThrow('Template key cannot be changed on a migrated worker agent');
      expect(longHorizonRepo.getById(workerId)?.templateKey).toBe('migration.legacy_space_agent');
    });

    it('rejects templateKey rewrites on mirror updates', async () => {
      const workerId = 'twin-rekey';
      seedWorkerMirror(db, { id: workerId, spaceId: 'space-1', name: 'Twin Rekey' });

      await expect(
        call(hubData.handlers, 'spaceAgent.update', {
          id: workerId,
          templateKey: 'coordinator.default',
        })
      ).rejects.toThrow('Template key cannot be changed on a migrated worker agent');
      expect(longHorizonRepo.getById(workerId)?.templateKey).toBe('migration.legacy_space_agent');
    });

    it('rejects disabled status on mirror updates', async () => {
      const workerId = 'twin-disabled';
      seedWorkerMirror(db, { id: workerId, spaceId: 'space-1', name: 'Twin Disabled' });

      await expect(
        call(hubData.handlers, 'spaceAgent.update', {
          id: workerId,
          status: 'disabled',
        })
      ).rejects.toThrow('Agent status "disabled" cannot be set on a migrated worker agent');
      expect(longHorizonRepo.getById(workerId)?.status).toBe('active');
    });

    it('refreshes runtime subscriptions after mirror updates', async () => {
      const runtimeService = createRuntimeServiceMock();
      const freshHub = createMockMessageHub();
      setupSpaceAgentHandlers(
        freshHub.hub,
        daemonData.internalEventBus,
        spaceManagerData.spaceManager,
        createTestDatabaseFacade(db),
        longHorizonRepo,
        workflowRepo,
        runtimeService
      );
      const workerId = 'twin-refresh';
      seedWorkerMirror(db, { id: workerId, spaceId: 'space-1', name: 'Twin Refresh' });

      await call(freshHub.handlers, 'spaceAgent.update', {
        id: workerId,
        status: 'paused',
      });

      expect(runtimeService.refreshLongHorizonAgentSubscriptions).toHaveBeenCalledWith(
        'space-1',
        workerId
      );
    });

    it('rejects blank display names before mirror updates persist', async () => {
      const workerId = 'twin-blank-name';
      seedWorkerMirror(db, { id: workerId, spaceId: 'space-1', name: 'Twin Blank Name' });

      await expect(
        call(hubData.handlers, 'spaceAgent.update', {
          id: workerId,
          displayName: '   ',
        })
      ).rejects.toThrow('displayName cannot be blank');
      expect(longHorizonRepo.getById(workerId)?.displayName).toBe('Twin Blank Name');
    });

    it('treats an empty model pool as a clear on unified updates', async () => {
      const result = await call<{ agent: { modelPool: Array<{ model: string }> | null } }>(
        hubData.handlers,
        'spaceAgent.update',
        { id: agentId, modelPool: [] }
      );
      expect(result.agent.modelPool ?? null).toBeNull();
    });

    it('emits unified updated events', async () => {
      await call(hubData.handlers, 'spaceAgent.update', { id: agentId, name: 'Updated' });
      await new Promise((r) => setTimeout(r, 0));

      expect(daemonData.publishMock).toHaveBeenCalled();
      const published = daemonData.publishMock.mock.calls as Array<[string, unknown]>;
      expect(published.map(([name]) => name)).toEqual(
        expect.arrayContaining(['spaceAgent.updated'])
      );
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
      ).rejects.toThrow(/already used by/);
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

    it('deletes the unified agent and returns success', async () => {
      const result = await call<{ success: boolean }>(hubData.handlers, 'spaceAgent.delete', {
        id: agentId,
      });
      expect(result.success).toBe(true);
      expect(longHorizonRepo.getById(agentId)).toBeNull();
    });

    it('accepts the long-horizon agentId parameter shape', async () => {
      const result = await call<{ success: boolean }>(hubData.handlers, 'spaceAgent.delete', {
        agentId,
        spaceId: 'space-1',
      });
      expect(result.success).toBe(true);
    });

    it('deletes mirror rows and removes their subscriptions', async () => {
      const runtimeService = createRuntimeServiceMock();
      const freshHub = createMockMessageHub();
      setupSpaceAgentHandlers(
        freshHub.hub,
        daemonData.internalEventBus,
        spaceManagerData.spaceManager,
        createTestDatabaseFacade(db),
        longHorizonRepo,
        workflowRepo,
        runtimeService
      );

      const workerId = 'worker-to-delete';
      seedWorkerMirror(db, { id: workerId, spaceId: 'space-1', name: 'Worker ToDelete' });
      expect(longHorizonRepo.getById(workerId)).not.toBeNull();

      await call(freshHub.handlers, 'spaceAgent.delete', { id: workerId });

      expect(longHorizonRepo.getById(workerId)).toBeNull();
      expect(runtimeService.removeLongHorizonAgentSubscriptions).toHaveBeenCalledWith(
        'space-1',
        workerId
      );
    });

    it('does not archive seeded coordinator long-horizon rows when deleting agents', async () => {
      const runtimeService = createRuntimeServiceMock();
      const freshHub = createMockMessageHub();
      setupSpaceAgentHandlers(
        freshHub.hub,
        daemonData.internalEventBus,
        spaceManagerData.spaceManager,
        createTestDatabaseFacade(db),
        longHorizonRepo,
        workflowRepo,
        runtimeService
      );
      const created = await call<{ agent: { id: string } }>(
        freshHub.handlers,
        'spaceAgent.create',
        {
          spaceId: 'space-1',
          name: 'Coordinator Named',
          handle: 'space-coordinator',
        }
      );
      const coordinator = longHorizonRepo.ensureCoordinator('space-1');
      const subscription = longHorizonRepo.createSubscription({
        spaceId: 'space-1',
        agentId: coordinator.id,
        source: 'github',
        topic: 'github/*/*/pull_request/*',
      });

      await call(freshHub.handlers, 'spaceAgent.delete', { id: created.agent.id });

      expect(longHorizonRepo.getById(coordinator.id)?.status).toBe('active');
      expect(longHorizonRepo.getSubscription(subscription.id)?.status).toBe('active');
      expect(runtimeService.removeLongHorizonAgentSubscriptions).toHaveBeenCalledTimes(1);
      expect(runtimeService.removeLongHorizonAgentSubscriptions).toHaveBeenCalledWith(
        'space-1',
        created.agent.id
      );
    });

    it('emits deleted events', async () => {
      await call(hubData.handlers, 'spaceAgent.delete', { id: agentId });

      expect(daemonData.publishMock).toHaveBeenCalled();
      const published = daemonData.publishMock.mock.calls as Array<[string, { agentId: string }]>;
      expect(published.map(([name]) => name)).toEqual(
        expect.arrayContaining(['spaceAgent.deleted'])
      );
      for (const [, payload] of published) {
        expect(payload.agentId).toBe(agentId);
      }
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

  describe('spaceAgent reminders and subscriptions', () => {
    it('registers reminder and subscription CRUD on the spaceAgent namespace', async () => {
      for (const name of [
        'spaceAgent.listReminders',
        'spaceAgent.listReminderCounts',
        'spaceAgent.createReminder',
        'spaceAgent.deleteReminder',
        'spaceAgent.listSubscriptions',
        'spaceAgent.createSubscription',
        'spaceAgent.updateSubscription',
        'spaceAgent.deleteSubscription',
      ]) {
        expect(hubData.handlers.has(name)).toBe(true);
      }
    });

    it('creates and counts reminders through the spaceAgent namespace', async () => {
      const created = await call<{ agent: { id: string } }>(hubData.handlers, 'spaceAgent.create', {
        spaceId: 'space-1',
        name: 'Reminder Holder',
      });

      const { reminder } = await call<{ reminder: { id: string; status: string } }>(
        hubData.handlers,
        'spaceAgent.createReminder',
        {
          spaceId: 'space-1',
          agentId: created.agent.id,
          title: 'Check in',
          triggerType: 'at',
          runAt: Date.now() + 60_000,
        }
      );
      expect(reminder.status).toBe('active');

      const { counts } = await call<{ counts: Record<string, number> }>(
        hubData.handlers,
        'spaceAgent.listReminderCounts',
        { agentIds: [created.agent.id] }
      );
      expect(counts[created.agent.id]).toBe(1);
    });
  });

  describe('spaceAgent.reapplyTemplate', () => {
    it('registers the handler', () => {
      expect(hubData.handlers.has('spaceAgent.reapplyTemplate')).toBe(true);
    });

    it('reapplies a custom template onto an agent by agentId', async () => {
      const templateRepo = new SpaceAgentTemplateRepository(db);
      templateRepo.create({
        key: 'release-readiness.custom',
        handle: 'release-readiness',
        displayName: 'Release Readiness',
        description: 'Tracks release readiness signals.',
        instructions: 'Coordinate release checks.',
        suggestedAutonomyLevel: 3,
        model: 'claude-opus-5',
        provider: 'anthropic',
        modelPool: [{ model: 'claude-opus-5', provider: 'anthropic', maxConcurrent: 2, weight: 3 }],
        thinkingLevel: 'think16k',
        settingSources: ['user', 'project'],
        tools: ['Read', 'Grep', 'Glob'],
      });

      const created = await call<{ agent: { id: string } }>(hubData.handlers, 'spaceAgent.create', {
        spaceId: 'space-1',
        name: 'Drifted Agent',
        templateName: 'release-readiness.custom',
      });

      const before = longHorizonRepo.getById(created.agent.id)!;
      expect(before.instructions).toBe('');
      expect(before.templateKey).toBe('release-readiness.custom');

      daemonData.publishMock.mockClear();

      const result = await call<{ agent: { instructions: string; model: string | null } }>(
        hubData.handlers,
        'spaceAgent.reapplyTemplate',
        { agentId: created.agent.id }
      );

      expect(result.agent.instructions).toBe('Coordinate release checks.');
      expect(result.agent.model).toBe('claude-opus-5');
      expect(longHorizonRepo.getById(created.agent.id)?.instructions).toBe(
        'Coordinate release checks.'
      );

      const published = daemonData.publishMock.mock.calls as Array<
        [string, { agent: { id: string } }]
      >;
      const update = published.find(
        ([name, payload]) => name === 'spaceAgent.updated' && payload.agent.id === created.agent.id
      );
      expect(update).toBeTruthy();
    });

    it('accepts id as an alias for agentId', async () => {
      const templateRepo = new SpaceAgentTemplateRepository(db);
      templateRepo.create({
        key: 'alias.custom',
        handle: 'alias',
        displayName: 'Alias',
        instructions: 'Alias template.',
        suggestedAutonomyLevel: 2,
      });

      const created = await call<{ agent: { id: string } }>(hubData.handlers, 'spaceAgent.create', {
        spaceId: 'space-1',
        name: 'Alias Agent',
        templateName: 'alias.custom',
      });

      const result = await call<{ agent: { id: string } }>(
        hubData.handlers,
        'spaceAgent.reapplyTemplate',
        { id: created.agent.id }
      );

      expect(result.agent.id).toBe(created.agent.id);
    });

    it('delays the reapply event until the stamped-session refresh succeeds', async () => {
      const runtimeService = createRuntimeServiceMock();
      runtimeService.refreshLongHorizonAgentSession.mockRejectedValueOnce(
        new Error('refresh failed')
      );
      const freshHub = createMockMessageHub();
      setupSpaceAgentHandlers(
        freshHub.hub,
        daemonData.internalEventBus,
        spaceManagerData.spaceManager,
        createTestDatabaseFacade(db),
        longHorizonRepo,
        workflowRepo,
        runtimeService,
        new SpaceAgentTemplateManager(new SpaceAgentTemplateRepository(db))
      );
      const templateRepo = new SpaceAgentTemplateRepository(db);
      templateRepo.create({
        key: 'late-reapply.custom',
        handle: 'late-reapply',
        displayName: 'Late Reapply',
        instructions: 'Late reapplied instructions.',
        suggestedAutonomyLevel: 2,
      });
      const created = await call<{ agent: { id: string } }>(
        freshHub.handlers,
        'spaceAgent.create',
        { spaceId: 'space-1', name: 'Late Agent', templateName: 'late-reapply.custom' }
      );
      longHorizonRepo.update(created.agent.id, {
        sessionId: `space:agent:space-1:${created.agent.id}`,
      });
      daemonData.publishMock.mockClear();

      await expect(
        call(freshHub.handlers, 'spaceAgent.reapplyTemplate', { agentId: created.agent.id })
      ).rejects.toThrow('Failed to refresh session: refresh failed');

      expect(
        daemonData.publishMock.mock.calls.filter(([name]) => name === 'spaceAgent.updated')
      ).toHaveLength(0);
    });

    it('refreshes the stamped session after reapplying a template', async () => {
      const runtimeService = createRuntimeServiceMock();
      const freshHub = createMockMessageHub();
      setupSpaceAgentHandlers(
        freshHub.hub,
        daemonData.internalEventBus,
        spaceManagerData.spaceManager,
        createTestDatabaseFacade(db),
        longHorizonRepo,
        workflowRepo,
        runtimeService,
        new SpaceAgentTemplateManager(new SpaceAgentTemplateRepository(db))
      );
      const templateRepo = new SpaceAgentTemplateRepository(db);
      templateRepo.create({
        key: 'stamped-reapply.custom',
        handle: 'stamped-reapply',
        displayName: 'Stamped Reapply',
        instructions: 'Reapplied instructions.',
        suggestedAutonomyLevel: 2,
      });
      const created = await call<{ agent: { id: string } }>(
        freshHub.handlers,
        'spaceAgent.create',
        { spaceId: 'space-1', name: 'Stamped Agent', templateName: 'stamped-reapply.custom' }
      );
      longHorizonRepo.update(created.agent.id, {
        sessionId: `space:agent:space-1:${created.agent.id}`,
      });

      await call(freshHub.handlers, 'spaceAgent.reapplyTemplate', { agentId: created.agent.id });

      expect(runtimeService.refreshLongHorizonAgentSession).toHaveBeenCalledWith(
        'space-1',
        created.agent.id
      );
    });

    it('clears the long-term session provider when the template removes the provider', async () => {
      const templateRepo = new SpaceAgentTemplateRepository(db);
      templateRepo.create({
        key: 'clear-provider.custom',
        handle: 'clear-provider',
        displayName: 'Clear Provider',
        instructions: 'Clears the provider.',
        suggestedAutonomyLevel: 2,
        model: null,
        provider: null,
      });

      const runtimeService = createRuntimeServiceMock();
      const freshHub = createMockMessageHub();
      setupSpaceAgentHandlers(
        freshHub.hub,
        daemonData.internalEventBus,
        spaceManagerData.spaceManager,
        createTestDatabaseFacade(db),
        longHorizonRepo,
        workflowRepo,
        runtimeService as any,
        new SpaceAgentTemplateManager(new SpaceAgentTemplateRepository(db as any))
      );

      const created = await call<{ agent: { id: string } }>(
        freshHub.handlers,
        'spaceAgent.create',
        {
          spaceId: 'space-1',
          name: 'Provided Agent',
          templateName: 'clear-provider.custom',
          provider: 'anthropic',
        }
      );

      const before = longHorizonRepo.getById(created.agent.id)!;
      expect(before.provider).toBe('anthropic');

      const result = await call<{ agent: { provider: string | null } }>(
        freshHub.handlers,
        'spaceAgent.reapplyTemplate',
        { agentId: created.agent.id }
      );

      expect(result.agent.provider).toBeNull();
      expect(longHorizonRepo.getById(created.agent.id)?.provider).toBeNull();
      expect(runtimeService.clearLongTermAgentSessionProvider).toHaveBeenCalledWith(
        'space-1',
        created.agent.id
      );
    });

    it('throws when agentId and id are missing', async () => {
      await expect(call(hubData.handlers, 'spaceAgent.reapplyTemplate', {})).rejects.toThrow(
        'agentId is required'
      );
    });

    it('throws when the agent does not exist', async () => {
      await expect(
        call(hubData.handlers, 'spaceAgent.reapplyTemplate', { agentId: 'ghost-id' })
      ).rejects.toThrow('Agent not found: ghost-id');
    });

    it('throws when the agent has no template', async () => {
      const created = await call<{ agent: { id: string } }>(hubData.handlers, 'spaceAgent.create', {
        spaceId: 'space-1',
        name: 'No Template',
      });

      await expect(
        call(hubData.handlers, 'spaceAgent.reapplyTemplate', { agentId: created.agent.id })
      ).rejects.toThrow(`Agent ${created.agent.id} has no template to re-apply`);
    });
  });
});
