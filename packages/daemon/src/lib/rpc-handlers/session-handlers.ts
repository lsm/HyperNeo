import type {
  ImageContent,
  ListRuntimeMcpServersRequest,
  ListRuntimeMcpServersResponse,
  MessageContent,
  MessageDeliveryMode,
  MessageHub,
  MessageImage,
  ModelInfo,
  Session,
  SessionMetadata,
  HyperNeoActionMessage,
  RuntimeMcpServerEntry,
} from '@hyperneo/shared';
import { normalizeThinkingLevel } from '@hyperneo/shared';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
import { composeDraftWhole, generateUUID, matchesDraftOrComposition } from '@hyperneo/shared';
import type { SessionManager } from '../session-manager';
import type { CreateSessionRequest, UpdateSessionRequest } from '@hyperneo/shared';
import { isSDKUserMessage } from '@hyperneo/shared/sdk/type-guards';
import {
  clearModelsCache,
  hasRefreshBeenAttemptedFor,
  isCuratedOutModel,
  markRefreshAttemptedFor,
} from '../model-service.js';
import { getProviderRegistry, inferProviderForModel } from '../providers/registry.js';
import {
  deliverAndMarkQueued,
  isMessageDeliveryV2Enabled,
  withSessionResetCoordination,
} from '../agent/message-delivery';
import {
  archiveSDKSessionFiles,
  deleteSDKSessionFiles,
  scanSDKSessionFiles,
  identifyOrphanedSDKFiles,
} from '../sdk-session-file-manager';
import type { SpaceManager } from '../space/managers/space-manager';
import type { SpaceRuntimeService } from '../space/runtime/space-runtime-service';
import { Logger } from '../logger';

const log = new Logger('session-handlers');

const STRANDED_PROBE_TIMEOUT_MS = 3000;

const VOICE_APPEND_LOG_TTL_MS = 24 * 60 * 60 * 1000 + 5 * 60 * 1000;

function raceWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export async function detectStrandedProviders(
  cachedModels: ModelInfo[],
  probeTimeoutMs: number = STRANDED_PROBE_TIMEOUT_MS
): Promise<string[]> {
  const cachedProviders = new Set(
    cachedModels.map((m) => m.provider).filter((p): p is string => !!p)
  );
  const registry = getProviderRegistry();
  const toProbe = registry
    .getAll()
    .filter(
      (provider) =>
        !cachedProviders.has(provider.id) &&
        registry.getCuratedModels(provider.id)?.length !== 0 &&
        !hasRefreshBeenAttemptedFor(provider.id)
    );
  if (toProbe.length === 0) return [];
  markRefreshAttemptedFor(toProbe.map((p) => p.id));
  const stranded: string[] = [];
  await Promise.all(
    toProbe.map(async (provider) => {
      try {
        const available = await raceWithTimeout(
          Promise.resolve(provider.isAvailable()),
          probeTimeoutMs
        );
        if (available === true) stranded.push(provider.id);
      } catch {}
    })
  );
  return stranded;
}

function extractMessageText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((block) => {
      if (typeof block !== 'object' || block === null) return '';
      const record = block as Record<string, unknown>;
      if (record.type === 'text' && typeof record.text === 'string') {
        return record.text;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function toReplayContent(
  content: string | Array<{ type: string; text?: string }>
): string | MessageContent[] | null {
  if (typeof content === 'string') {
    return content || null;
  }

  if (Array.isArray(content)) {
    if (content.some((block) => block.type !== 'text')) {
      return content as MessageContent[];
    }

    const textContent = content
      .filter(
        (block): block is { type: 'text'; text: string } => block.type === 'text' && !!block.text
      )
      .map((block) => block.text)
      .join('\n');
    return textContent || null;
  }

  return null;
}

export function setupSessionHandlers(
  messageHub: MessageHub,
  sessionManager: SessionManager,
  internalEventBus: InternalEventBus<DaemonInternalEventMap>,
  spaceManager: SpaceManager,
  spaceRuntimeService?: SpaceRuntimeService
): void {
  messageHub.onRequest('session.create', async (data) => {
    const req = data as CreateSessionRequest;
    if (
      req.worktreeMode !== undefined &&
      req.worktreeMode !== 'worktree' &&
      req.worktreeMode !== 'direct'
    ) {
      throw new Error(
        `Invalid worktreeMode: ${String(req.worktreeMode)}. Must be 'worktree' or 'direct'`
      );
    }

    const sessionId = await sessionManager.createSession({
      workspacePath: req.workspacePath,
      initialTools: req.initialTools,
      config: req.config,
      worktreeBaseBranch: req.worktreeBaseBranch,
      worktreeMode: req.worktreeMode,
      title: req.title,
      spaceId: req.spaceId,
      createdBy: req.createdBy ?? 'human',
    });

    if (req.spaceId) {
      const updatedSpace = await spaceManager.addSession(req.spaceId, sessionId);
      internalEventBus
        .publish('space.updated', {
          sessionId: 'global',
          spaceId: req.spaceId,
          space: updatedSpace,
        })
        .catch(() => {});
    }

    const agentSession = sessionManager.getSession(sessionId);
    const session = agentSession?.getSessionData();

    if (session && session.context?.spaceId && spaceRuntimeService) {
      try {
        await spaceRuntimeService.attachSpaceToolsToMemberSession(session);
      } catch (err) {
        log.warn(
          `Failed to attach space tools to session ${sessionId} (space ${session.context.spaceId}):`,
          err
        );
      }
    }

    if (session) {
      internalEventBus.publish('session.created', { sessionId, session }).catch(() => {});
    }

    return { sessionId, session };
  });

  messageHub.onRequest('session.listRuntimeMcpServers', async (data) => {
    const { sessionId } = data as ListRuntimeMcpServersRequest;
    const agentSession = await sessionManager.getSessionAsync(sessionId);
    if (!agentSession) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const mcpServers = agentSession.getSessionData().config?.mcpServers;
    const servers: RuntimeMcpServerEntry[] = [];
    if (mcpServers) {
      for (const [name, config] of Object.entries(mcpServers)) {
        if ((config as { type?: string } | undefined)?.type === 'sdk') {
          servers.push({ name });
        }
      }
    }

    return { servers } satisfies ListRuntimeMcpServersResponse;
  });

  messageHub.onRequest('session.setWorktreeMode', async (data) => {
    const { sessionId, mode } = data as { sessionId: string; mode: 'worktree' | 'direct' };

    if (!sessionId || !mode) {
      throw new Error('Missing required fields: sessionId and mode');
    }

    if (mode !== 'worktree' && mode !== 'direct') {
      throw new Error(`Invalid mode: ${mode}. Must be 'worktree' or 'direct'`);
    }

    const sessionLifecycle = sessionManager.getSessionLifecycle();

    const updatedSession = await sessionLifecycle.completeWorktreeChoice(sessionId, mode);

    messageHub.event('session.updated', updatedSession, {
      channel: `session:${sessionId}`,
    });

    return { success: true, session: updatedSession };
  });

  messageHub.onRequest('session.setWorkspace', async (data) => {
    const { sessionId, workspacePath, worktreeMode } = data as {
      sessionId: string;
      workspacePath: string;
      worktreeMode: 'worktree' | 'direct';
    };

    if (!sessionId || !workspacePath || !worktreeMode) {
      throw new Error('Missing required fields: sessionId, workspacePath, and worktreeMode');
    }

    if (worktreeMode !== 'worktree' && worktreeMode !== 'direct') {
      throw new Error(`Invalid worktreeMode: ${worktreeMode}. Must be 'worktree' or 'direct'`);
    }

    const sessionLifecycle = sessionManager.getSessionLifecycle();
    const updatedSession = await sessionLifecycle.setWorkspace(
      sessionId,
      workspacePath,
      worktreeMode
    );

    messageHub.event('session.updated', updatedSession, {
      channel: `session:${sessionId}`,
    });

    return { success: true, session: updatedSession };
  });

  messageHub.onRequest(
    'session.list',
    async (data: { status?: string; includeArchived?: boolean } | undefined) => {
      const sessions = sessionManager.listSessions({
        status: data?.status,
        includeArchived: data?.includeArchived,
      });
      return { sessions };
    }
  );

  messageHub.onRequest('session.get', async (data) => {
    const { sessionId: targetSessionId } = data as { sessionId: string };
    const agentSession = await sessionManager.getSessionAsync(targetSessionId);

    if (!agentSession) {
      throw new Error('Session not found');
    }

    let session = agentSession.getSessionData();
    const voicePending = session.metadata?.inputDraftVoicePending;
    if (voicePending && voicePending.trim()) {
      const draft = session.metadata?.inputDraft ?? '';
      const composed = composeDraftWhole(draft, voicePending);
      if (composed !== null && session.metadata) {
        session = { ...session, metadata: { ...session.metadata, inputDraft: composed } };
      }
    }

    return {
      session,
      activeTools: [],
      context: {
        files: [],
        workingDirectory: session.worktree?.worktreePath ?? session.workspacePath ?? null,
      },
    };
  });

  messageHub.onRequest('session.validate', async (data) => {
    const { sessionId: targetSessionId } = data as { sessionId: string };
    try {
      const agentSession = await sessionManager.getSessionAsync(targetSessionId);
      return { valid: agentSession !== null, error: null };
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  messageHub.onRequest('session.getSkillMcpServers', async (data) => {
    const { sessionId: targetSessionId } = data as { sessionId: string };
    const agentSession = await sessionManager.getSessionAsync(targetSessionId);
    if (!agentSession) {
      throw new Error(`Session not found: ${targetSessionId}`);
    }
    const servers = agentSession.optionsBuilder.getSkillMcpServers();
    return { servers };
  });

  messageHub.onRequest('session.update', async (data, _ctx) => {
    const { sessionId: targetSessionId, ...updates } = data as UpdateSessionRequest & {
      sessionId: string;
    };

    const draftWrite = (updates.metadata as Partial<SessionMetadata> | undefined)?.inputDraft;
    if (draftWrite !== undefined) {
      const existing = sessionManager.getSessionFromDB(targetSessionId);
      const meta = existing?.metadata;
      const pending = meta?.inputDraftVoicePending;
      const pendingStaged = !!pending && pending.trim() !== '';
      const written = draftWrite ?? '';
      if (pendingStaged && written.trim() !== '' && written.includes(pending.trim())) {
        (updates.metadata as Partial<SessionMetadata>).inputDraftVoicePending = null;
      }
    }

    const agentSessionForUpdate = sessionManager.getSession(targetSessionId);
    const roomIdForUpdate = agentSessionForUpdate?.getSessionData().context?.roomId;

    const configUpdate = (updates as Partial<Session>).config;
    if (configUpdate && (configUpdate.model !== undefined || configUpdate.provider !== undefined)) {
      const existingConfig =
        agentSessionForUpdate?.getSessionData().config ??
        sessionManager.getSessionFromDB(targetSessionId)?.config;
      const currentModel = existingConfig?.model;
      const currentProvider =
        existingConfig?.provider ??
        (currentModel ? inferProviderForModel(currentModel) : undefined);
      const effectiveModel = configUpdate.model ?? currentModel;
      const providerId =
        configUpdate.provider ??
        existingConfig?.provider ??
        (effectiveModel ? inferProviderForModel(effectiveModel) : undefined);
      const rewritesOwnPair =
        existingConfig !== undefined &&
        effectiveModel === currentModel &&
        providerId === currentProvider;
      if (
        providerId &&
        effectiveModel &&
        !rewritesOwnPair &&
        isCuratedOutModel(effectiveModel, providerId)
      ) {
        throw new Error(
          `Model '${effectiveModel}' is curated out for provider '${providerId}' and cannot be set on a session`
        );
      }
    }

    await sessionManager.updateSession(targetSessionId, updates as Partial<Session>);

    const updatedPayload = { ...updates, sessionId: targetSessionId, roomId: roomIdForUpdate };

    messageHub.event('session.updated', updatedPayload, {
      channel: `session:${targetSessionId}`,
    });

    return { success: true };
  });

  messageHub.onRequest('session.appendVoiceDraft', async (data, _ctx) => {
    const { sessionId, text, dedupId } = data as {
      sessionId: string;
      text: string;
      dedupId?: string;
    };
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new Error('Text to append is required');
    }
    if (dedupId !== undefined && typeof dedupId !== 'string') {
      throw new Error('dedupId must be a string when provided');
    }
    const session = sessionManager.getSessionFromDB(sessionId);
    if (!session) throw new Error('Session not found');
    const metadata = session.metadata ?? {};
    const appendLogTtlCutoff = Date.now() - VOICE_APPEND_LOG_TTL_MS;
    const processedLog = (metadata.inputDraftVoiceAppendLog ?? []).filter(
      (entry) =>
        typeof entry?.id === 'string' &&
        typeof entry?.ts === 'number' &&
        entry.ts > appendLogTtlCutoff
    );
    if (dedupId && processedLog.some((entry) => entry.id === dedupId)) {
      return { success: true, deduped: true };
    }
    const existingPending = (metadata.inputDraftVoicePending ?? '').trim();
    const stagedText = text.trim();
    const pending = composeDraftWhole(existingPending, stagedText);
    if (pending === null) throw new Error('Pending voice draft is at the character limit');
    const metadataUpdate: Partial<SessionMetadata> = { inputDraftVoicePending: pending };
    if (dedupId) {
      metadataUpdate.inputDraftVoiceAppendLog = [...processedLog, { id: dedupId, ts: Date.now() }];
    }
    const updates: UpdateSessionRequest = { metadata: metadataUpdate };
    await sessionManager.updateSession(sessionId, updates as Partial<Session>);
    messageHub.event(
      'session.updated',
      { ...updates, sessionId },
      {
        channel: `session:${sessionId}`,
      }
    );
    messageHub.event('session.voiceLanded', { sessionId }, { channel: `session:${sessionId}` });
    return { success: true };
  });

  messageHub.onRequest('session.clearInputDraftIf', async (data, _ctx) => {
    const { sessionId, expected } = data as { sessionId: string; expected: string };
    if (typeof expected !== 'string') throw new Error('Expected draft value is required');
    const session = sessionManager.getSessionFromDB(sessionId);
    if (!session) throw new Error('Session not found');
    const draft = session.metadata?.inputDraft ?? '';
    const pending = session.metadata?.inputDraftVoicePending ?? '';
    const match = matchesDraftOrComposition(draft, pending, expected);
    if (!match) {
      return { cleared: false };
    }
    const updates: UpdateSessionRequest = {
      metadata: {
        inputDraft: null,
        ...(match === 'composition' ? { inputDraftVoicePending: null } : {}),
      },
    };
    await sessionManager.updateSession(sessionId, updates as Partial<Session>);
    messageHub.event(
      'session.updated',
      { ...updates, sessionId },
      {
        channel: `session:${sessionId}`,
      }
    );
    return { cleared: true };
  });

  messageHub.onRequest('session.delete', async (data, _ctx) => {
    const { sessionId: targetSessionId } = data as { sessionId: string };

    const agentSessionForDelete = sessionManager.getSession(targetSessionId);
    const contextForDelete = agentSessionForDelete?.getSessionData().context;
    const spaceIdForDelete = contextForDelete?.spaceId;

    await sessionManager.deleteSessionResources(targetSessionId, 'ui_session_delete');

    if (spaceIdForDelete) {
      try {
        const updatedSpace = await spaceManager.removeSession(spaceIdForDelete, targetSessionId);
        internalEventBus
          .publish('space.updated', {
            sessionId: 'global',
            spaceId: spaceIdForDelete,
            space: updatedSpace,
          })
          .catch(() => {});
      } catch {}
    }

    return { success: true };
  });

  messageHub.onRequest('session.archive', async (data, _ctx) => {
    const { sessionId: targetSessionId, confirmed = false } = data as {
      sessionId: string;
      confirmed?: boolean;
    };

    const agentSession = await sessionManager.getSessionAsync(targetSessionId);
    if (!agentSession) {
      throw new Error('Session not found');
    }

    const session = agentSession.getSessionData();

    const hadWorktree = !!session.worktree;
    const roomIdForArchive = session.context?.roomId;
    const spaceIdForArchive = session.context?.spaceId;
    let commitsRemoved = 0;
    if (session.worktree) {
      const { WorktreeManager } = await import('../worktree-manager');
      const worktreeManager = new WorktreeManager();
      const commitStatus = await worktreeManager.getCommitsAhead(session.worktree);

      if (!confirmed && commitStatus.hasCommitsAhead) {
        return {
          success: false,
          requiresConfirmation: true,
          commitStatus,
        };
      }
      commitsRemoved = commitStatus.commits.length;
    }

    try {
      await sessionManager.archiveSessionResources(targetSessionId, 'ui_session_archive');
    } catch (error) {
      throw new Error(
        `Failed to archive: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    if (spaceIdForArchive) {
      try {
        const updatedSpace = await spaceManager.removeSession(spaceIdForArchive, targetSessionId);
        internalEventBus
          .publish('space.updated', {
            sessionId: 'global',
            spaceId: spaceIdForArchive,
            space: updatedSpace,
          })
          .catch(() => {});
      } catch {}
    }

    const archivedPayload = {
      sessionId: targetSessionId,
      status: 'archived',
      roomId: roomIdForArchive,
    };
    messageHub.event('session.updated', archivedPayload, {
      channel: `session:${targetSessionId}`,
    });

    return {
      success: true,
      requiresConfirmation: false,
      ...(hadWorktree ? { commitsRemoved } : {}),
    };
  });

  messageHub.onRequest('message.send', async (data) => {
    const {
      sessionId: targetSessionId,
      content,
      images,
      deliveryMode = 'immediate',
    } = data as {
      sessionId: string;
      content: string;
      images?: Array<MessageImage | ImageContent>;
      deliveryMode?: MessageDeliveryMode;
    };

    if (deliveryMode !== 'immediate' && deliveryMode !== 'defer') {
      throw new Error('Invalid deliveryMode');
    }

    const agentSession = await sessionManager.getSessionAsync(targetSessionId);
    if (!agentSession) {
      throw new Error('Session not found');
    }

    const messageId = generateUUID();

    await sessionManager.sendUserMessage({
      sessionId: targetSessionId,
      messageId,
      content,
      images,
      deliveryMode,
    });

    return { messageId };
  });

  messageHub.onRequest('client.interrupt', async (data) => {
    const { sessionId: targetSessionId } = data as { sessionId: string };

    const agentSession = await sessionManager.getSessionAsync(targetSessionId);
    if (!agentSession) {
      throw new Error('Session not found');
    }

    internalEventBus
      .publish('agent.interruptRequest', { sessionId: targetSessionId })
      .catch((error) => {
        log.warn(`Failed to emit agent.interruptRequest for session ${targetSessionId}:`, error);
      });

    return { accepted: true };
  });

  messageHub.onRequest('session.model.get', async (data) => {
    const { sessionId: targetSessionId } = data as { sessionId: string };

    const agentSession = await sessionManager.getSessionAsync(targetSessionId);
    if (!agentSession) {
      throw new Error('Session not found');
    }

    const rawModelId = agentSession.getCurrentModel().id;
    const sessionProvider = agentSession.getSessionData().config.provider;

    if (!sessionProvider) {
      throw new Error('Session has no provider configured');
    }

    const { getSessionModelInfo } = await import('../model-service.js');
    const modelInfo = await getSessionModelInfo(agentSession.getSessionData(), 'global');

    return {
      currentModel: modelInfo?.id ?? rawModelId,
      currentProvider: sessionProvider,
      modelInfo,
    };
  });

  messageHub.onRequest('session.model.switch', async (data) => {
    const {
      sessionId: targetSessionId,
      model,
      provider,
    } = data as {
      sessionId: string;
      model: string;
      provider?: string;
    };

    if (!provider) {
      throw new Error('Missing required field: provider');
    }

    const agentSession = await sessionManager.getSessionAsync(targetSessionId);
    if (!agentSession) {
      throw new Error('Session not found');
    }

    const result = await agentSession.handleModelSwitch(model, provider);

    if (result.success) {
      messageHub.event(
        'session.updated',
        { model: result.model },
        { channel: `session:${targetSessionId}` }
      );
    }

    return result;
  });

  messageHub.onRequest('session.coordinator.switch', async (data) => {
    const { sessionId: targetSessionId, coordinatorMode } = data as {
      sessionId: string;
      coordinatorMode: boolean;
    };

    const agentSession = await sessionManager.getSessionAsync(targetSessionId);
    if (!agentSession) {
      throw new Error('Session not found');
    }

    const session = agentSession.getSessionData();
    const previousMode = session.config.coordinatorMode ?? false;

    if (previousMode === coordinatorMode) {
      return { success: true, coordinatorMode };
    }

    await sessionManager.updateSession(targetSessionId, {
      config: { ...session.config, coordinatorMode },
    });

    const result = agentSession.isQueryActiveOrStarting()
      ? await agentSession.resetQuery({ restartQuery: true })
      : { success: true as const };

    messageHub.event(
      'session.updated',
      { config: { coordinatorMode } },
      { channel: `session:${targetSessionId}` }
    );

    return { success: result.success, coordinatorMode, error: result.error };
  });

  messageHub.onRequest('session.sandbox.switch', async (data) => {
    const { sessionId: targetSessionId, sandboxEnabled } = data as {
      sessionId: string;
      sandboxEnabled: boolean;
    };

    const agentSession = await sessionManager.getSessionAsync(targetSessionId);
    if (!agentSession) {
      throw new Error('Session not found');
    }

    const session = agentSession.getSessionData();
    const previousMode = session.config.sandbox?.enabled ?? true;

    if (previousMode === sandboxEnabled) {
      return { success: true, sandboxEnabled };
    }

    const updatedSandbox = {
      ...session.config.sandbox,
      enabled: sandboxEnabled,
    };

    await sessionManager.updateSession(targetSessionId, {
      config: { ...session.config, sandbox: updatedSandbox },
    });

    const result = agentSession.isQueryActiveOrStarting()
      ? await agentSession.resetQuery({ restartQuery: true })
      : { success: true as const };

    messageHub.event(
      'session.updated',
      { config: { sandbox: updatedSandbox } },
      { channel: `session:${targetSessionId}` }
    );

    return { success: result.success, sandboxEnabled, error: result.error };
  });

  messageHub.onRequest('session.thinking.set', async (data) => {
    const { sessionId: targetSessionId, level } = data as {
      sessionId: string;
      level: string;
    };

    const agentSession = await sessionManager.getSessionAsync(targetSessionId);
    if (!agentSession) {
      throw new Error('Session not found');
    }

    const thinkingLevel = normalizeThinkingLevel(level);

    await sessionManager.updateSession(targetSessionId, {
      config: {
        ...agentSession.getSessionData().config,
        thinkingLevel,
      },
    });

    messageHub.event(
      'session.updated',
      { config: { thinkingLevel } },
      { channel: `session:${targetSessionId}` }
    );

    return { success: true, thinkingLevel };
  });

  messageHub.onRequest('session.thinking.get', async (data) => {
    const { sessionId: targetSessionId } = data as { sessionId: string };

    const agentSession = await sessionManager.getSessionAsync(targetSessionId);
    if (!agentSession) {
      throw new Error('Session not found');
    }

    const thinkingLevel = normalizeThinkingLevel(
      agentSession.getSessionData().config.thinkingLevel
    );
    return { thinkingLevel };
  });

  messageHub.onRequest('models.list', async (data) => {
    try {
      const { getAvailableModels, getModelsCache, refreshModels } = await import(
        '../model-service.js'
      );

      const params = data as {
        forceRefresh?: boolean;
        useCache?: boolean;
      };
      const forceRefresh = params?.forceRefresh ?? params?.useCache === false;
      let didRefresh = forceRefresh;

      if (forceRefresh) {
        await refreshModels();
      }

      let availableModels = getAvailableModels('global');
      const cachePopulated = getModelsCache().has('global');

      if (!forceRefresh && availableModels.length === 0 && !cachePopulated) {
        await refreshModels();
        availableModels = getAvailableModels('global');
        didRefresh = true;
      }

      if (!forceRefresh && (availableModels.length > 0 || cachePopulated)) {
        const stranded = await detectStrandedProviders(availableModels);
        if (stranded.length > 0) {
          const providersBefore = new Set(
            availableModels.map((m) => m.provider).filter((p): p is string => !!p)
          );
          await refreshModels();
          availableModels = getAvailableModels('global');
          didRefresh = true;
          const recovered = availableModels.some(
            (m) => !!m.provider && !providersBefore.has(m.provider)
          );
          if (recovered) {
            internalEventBus.publishAsync('providers.changed', { sessionId: 'global' });
          }
        }
      }

      return {
        models: availableModels.map((m) => ({
          id: m.id,
          display_name: m.name,
          description: m.description,
          alias: m.alias,
          provider: m.provider,
          contextWindow: m.contextWindow,
          context_window: m.contextWindow,
          thinkingModes: m.thinkingModes,
          type: 'model' as const,
        })),
        cached: !didRefresh && availableModels.length > 0,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to list models: ${errorMessage}`);
    }
  });

  messageHub.onRequest('models.clearCache', async () => {
    clearModelsCache();
    return { success: true };
  });

  messageHub.onRequest('agent.getState', async (data) => {
    const { sessionId: targetSessionId } = data as { sessionId: string };

    const agentSession = await sessionManager.getSessionAsync(targetSessionId);
    if (!agentSession) {
      throw new Error('Session not found');
    }

    const state = agentSession.getProcessingState();

    return { state };
  });

  messageHub.onRequest('worktree.cleanup', async (data) => {
    const { workspacePath: resolvedPath } = data as { workspacePath?: string };
    if (!resolvedPath) {
      throw new Error('workspacePath is required');
    }
    const cleanedPaths = await sessionManager.cleanupOrphanedWorktrees(resolvedPath);

    return {
      success: true,
      cleanedPaths,
      message: `Cleaned up ${cleanedPaths.length} orphaned worktree(s)`,
    };
  });

  messageHub.onRequest('sdk.scan', async (data) => {
    const { workspacePath } = data as { workspacePath: string };

    const files = scanSDKSessionFiles(workspacePath);

    const sessions = sessionManager.listSessions({ includeArchived: true });
    const activeIds = new Set(sessions.filter((s) => s.status === 'active').map((s) => s.id));
    const archivedIds = new Set(sessions.filter((s) => s.status === 'archived').map((s) => s.id));

    const orphaned = identifyOrphanedSDKFiles(files, activeIds, archivedIds);

    return {
      success: true,
      workspacePath,
      summary: {
        totalFiles: files.length,
        totalSize: files.reduce((sum, f) => sum + f.size, 0),
        orphanedFiles: orphaned.length,
        orphanedSize: orphaned.reduce((sum, f) => sum + f.size, 0),
      },
      files,
      orphaned,
    };
  });

  messageHub.onRequest('sdk.cleanup', async (data) => {
    const { workspacePath, mode, sdkSessionIds } = data as {
      workspacePath: string;
      mode: 'archive' | 'delete';
      sdkSessionIds?: string[];
    };

    const errors: string[] = [];
    let processedCount = 0;
    let totalSize = 0;

    let filesToClean = scanSDKSessionFiles(workspacePath);
    if (sdkSessionIds && sdkSessionIds.length > 0) {
      filesToClean = filesToClean.filter((f) => sdkSessionIds.includes(f.sdkSessionId));
    }

    for (const file of filesToClean) {
      const kaiSessionId = file.kaiSessionIds[0] || 'orphan';

      if (mode === 'delete') {
        const result = deleteSDKSessionFiles(workspacePath, file.sdkSessionId, kaiSessionId);
        if (result.success) {
          processedCount++;
          totalSize += result.deletedSize;
        } else {
          errors.push(...result.errors);
        }
      } else {
        const result = archiveSDKSessionFiles(workspacePath, file.sdkSessionId, kaiSessionId);
        if (result.success) {
          processedCount++;
          totalSize += result.totalSize;
        } else {
          errors.push(...result.errors);
        }
      }
    }

    return {
      success: errors.length === 0,
      mode,
      processedCount,
      totalSize,
      errors,
    };
  });

  messageHub.onRequest('session.resetQuery', async (data) => {
    const { sessionId: targetSessionId, restartQuery = true } = data as {
      sessionId: string;
      restartQuery?: boolean;
    };

    const agentSession = await sessionManager.getSessionAsync(targetSessionId);
    if (!agentSession) {
      throw new Error('Session not found');
    }

    const result = await agentSession.resetQuery({ restartQuery, hardReset: true });

    await internalEventBus.publish('agent.reset', {
      sessionId: targetSessionId,
      success: result.success,
      error: result.error,
    });

    return result;
  });

  messageHub.onRequest('session.restart', async (data) => {
    const { sessionId: targetSessionId } = data as { sessionId: string };

    const agentSession = await sessionManager.getSessionAsync(targetSessionId);
    if (!agentSession) {
      throw new Error('Session not found');
    }

    try {
      await agentSession.restart();

      await internalEventBus.publish('agent.restart', {
        sessionId: targetSessionId,
        success: true,
      });

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await internalEventBus.publish('agent.restart', {
        sessionId: targetSessionId,
        success: false,
        error: errorMessage,
      });
      return { success: false, error: errorMessage };
    }
  });

  messageHub.onRequest('session.cancelRateLimitRetry', async (data) => {
    const { sessionId: targetSessionId } = data as { sessionId: string };
    const agentSession = await sessionManager.getSessionAsync(targetSessionId);
    if (!agentSession) {
      throw new Error('Session not found');
    }
    agentSession.cancelRateLimitRetry();
    return { success: true };
  });

  messageHub.onRequest('session.retryNowAfterRateLimit', async (data) => {
    const { sessionId: targetSessionId } = data as { sessionId: string };
    const agentSession = await sessionManager.getSessionAsync(targetSessionId);
    if (!agentSession) {
      throw new Error('Session not found');
    }
    await agentSession.retryNowAfterRateLimit();
    return { success: true };
  });

  messageHub.onRequest('session.query.trigger', async (data) => {
    const { sessionId: targetSessionId } = data as { sessionId: string };

    const agentSession = await sessionManager.getSessionAsync(targetSessionId);
    if (!agentSession) {
      throw new Error('Session not found');
    }

    await agentSession.replayAllPendingMessages();

    return { success: true };
  });

  messageHub.onRequest('session.messages.countByStatus', async (data) => {
    const { sessionId: targetSessionId, status } = data as {
      sessionId: string;
      status: 'deferred' | 'enqueued' | 'consumed';
    };

    const agentSession = await sessionManager.getSessionAsync(targetSessionId);
    if (!agentSession) {
      throw new Error('Session not found');
    }

    const session = agentSession.getSessionData();

    const db = sessionManager.getDatabase();
    const count = db.getMessageCountByStatus(session.id, status);

    return { count };
  });

  messageHub.onRequest('session.messages.byStatus', async (data) => {
    const {
      sessionId: targetSessionId,
      status,
      limit = 20,
    } = data as {
      sessionId: string;
      status: 'deferred' | 'enqueued' | 'consumed';
      limit?: number;
    };

    if (!['deferred', 'enqueued', 'consumed'].includes(status)) {
      throw new Error('Invalid status');
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new Error('Invalid limit: must be an integer between 1 and 1000');
    }

    const agentSession = await sessionManager.getSessionAsync(targetSessionId);
    if (!agentSession) {
      throw new Error('Session not found');
    }

    const db = sessionManager.getDatabase();
    const result = db.getUserMessagesByStatus(targetSessionId, status, limit);
    const messages = result.messages.map((message) => ({
      dbId: message.dbId,
      uuid: message.uuid ?? '',
      timestamp: message.timestamp,
      status,
      text: extractMessageText(message.message.content),
    }));

    return { messages, total: result.total };
  });

  messageHub.onRequest('session.messages.removePending', async (data) => {
    const { sessionId: targetSessionId, messageDbId } = data as {
      sessionId?: string;
      messageDbId?: string;
    };

    if (!targetSessionId || !messageDbId) {
      throw new Error('sessionId and messageDbId are required');
    }

    const agentSession = await sessionManager.getSessionAsync(targetSessionId);
    if (!agentSession) {
      throw new Error('Session not found');
    }

    const removed = await agentSession.revokePendingDelivery(messageDbId, 'remove');
    if (!removed.changed) {
      return { removed: false };
    }

    await internalEventBus.publish('messages.statusChanged', {
      sessionId: targetSessionId,
      messageIds: [removed.dbId],
      status: 'removed',
    });

    return {
      removed: true,
      messageId: removed.dbId,
      status: 'enqueued',
      removedFromMemory: removed.removedFromMemory,
    };
  });

  messageHub.onRequest('session.messages.deferPending', async (data) => {
    const { sessionId: targetSessionId, messageDbId } = data as {
      sessionId?: string;
      messageDbId?: string;
    };

    if (!targetSessionId || !messageDbId) {
      throw new Error('sessionId and messageDbId are required');
    }

    const agentSession = await sessionManager.getSessionAsync(targetSessionId);
    if (!agentSession) {
      throw new Error('Session not found');
    }

    const deferred = await agentSession.revokePendingDelivery(messageDbId, 'defer');
    if (!deferred.changed) {
      return { deferred: false };
    }

    await internalEventBus.publish('messages.statusChanged', {
      sessionId: targetSessionId,
      messageIds: [deferred.dbId],
      status: 'deferred',
    });

    return {
      deferred: true,
      messageId: deferred.dbId,
      status: 'deferred',
      removedFromMemory: deferred.removedFromMemory,
    };
  });

  messageHub.onRequest('session.messages.promotePending', async (data) => {
    const { sessionId: targetSessionId, messageDbId } = data as {
      sessionId?: string;
      messageDbId?: string;
    };

    if (!targetSessionId || !messageDbId) {
      throw new Error('sessionId and messageDbId are required');
    }

    const agentSession = await sessionManager.getSessionAsync(targetSessionId);
    if (!agentSession) {
      throw new Error('Session not found');
    }

    const db = sessionManager.getDatabase();
    const message = db.getMessageByStatusAndDbId(targetSessionId, 'deferred', messageDbId);

    if (!message || !isSDKUserMessage(message) || !message.uuid) {
      return { promoted: false };
    }

    const replayContent = toReplayContent(message.message.content);
    if (!replayContent) {
      return { promoted: false };
    }
    const messageUuid = message.uuid;

    db.updateMessageStatus([message.dbId], 'enqueued');
    await internalEventBus.publish('messages.statusChanged', {
      sessionId: targetSessionId,
      messageIds: [message.dbId],
      status: 'enqueued',
    });

    if (isMessageDeliveryV2Enabled()) {
      await withSessionResetCoordination(targetSessionId, async () =>
        deliverAndMarkQueued({
          jobQueue: db.getJobQueueRepo(),
          stateManager: agentSession.stateManager,
          sessionId: targetSessionId,
          messageUuid,
          origin: 'chat',
        })
      );
    } else {
      await withSessionResetCoordination(targetSessionId, async () => {
        await agentSession.startQueryAndEnqueue(messageUuid, replayContent);
      });
    }

    return {
      promoted: true,
      messageId: message.dbId,
      status: 'enqueued',
    };
  });

  messageHub.onRequest('session.messages.retry', async (data) => {
    const { sessionId: targetSessionId, messageDbId } = data as {
      sessionId?: string;
      messageDbId?: string;
    };

    if (!targetSessionId || !messageDbId) {
      throw new Error('sessionId and messageDbId are required');
    }

    const db = sessionManager.getDatabase();
    const persistedStatus = db.getSession(targetSessionId)?.status;
    if (persistedStatus === 'archived' || persistedStatus === 'ended') {
      return { retried: false };
    }

    const agentSession = await sessionManager.getSessionAsync(targetSessionId);
    if (!agentSession) {
      throw new Error('Session not found');
    }

    const message = db.getMessageByStatusAndDbId(targetSessionId, 'failed', messageDbId);

    if (!message || !isSDKUserMessage(message) || !message.uuid) {
      return { retried: false };
    }

    const reopenedId = db.getSDKMessageRepo().reopenDeliveryByUuid(targetSessionId, message.uuid);
    if (!reopenedId) {
      return { retried: false };
    }
    const messageUuid = message.uuid;

    const rollbackToFailed = async () => {
      const rolledBack = db
        .getSDKMessageRepo()
        .markDeliveryFailedByUuid(targetSessionId, message.uuid!);
      if (rolledBack) {
        await internalEventBus.publish('messages.statusChanged', {
          sessionId: targetSessionId,
          messageIds: [rolledBack],
          status: 'failed',
        });
      }
    };

    try {
      await internalEventBus.publish('messages.statusChanged', {
        sessionId: targetSessionId,
        messageIds: [reopenedId],
        status: 'enqueued',
      });

      if (isMessageDeliveryV2Enabled()) {
        await withSessionResetCoordination(targetSessionId, async () =>
          deliverAndMarkQueued({
            jobQueue: db.getJobQueueRepo(),
            stateManager: agentSession.stateManager,
            sessionId: targetSessionId,
            messageUuid,
            origin: 'chat',
          })
        );
      } else {
        const replayContent = toReplayContent(message.message.content);
        if (replayContent) {
          await withSessionResetCoordination(targetSessionId, async () => {
            await agentSession.startQueryAndEnqueue(messageUuid, replayContent);
          });
        }
      }
    } catch (err) {
      await rollbackToFailed();
      throw err;
    }

    return {
      retried: true,
      messageId: reopenedId,
      status: 'enqueued',
    };
  });

  messageHub.onRequest('session.sdkResumeChoice', async (data) => {
    const {
      sessionId: targetSessionId,
      choice,
      messageUuid,
    } = data as {
      sessionId: string;
      choice: 'start_fresh' | 'leave_as_is';
      messageUuid: string;
    };

    if (!targetSessionId || !choice || !messageUuid) {
      throw new Error('Missing required fields: sessionId, choice, messageUuid');
    }

    if (choice !== 'start_fresh' && choice !== 'leave_as_is') {
      throw new Error(`Invalid choice: ${choice}. Must be 'start_fresh' or 'leave_as_is'`);
    }

    const agentSession = await sessionManager.getSessionAsync(targetSessionId);
    if (!agentSession) {
      throw new Error('Session not found');
    }

    const db = sessionManager.getDatabase();

    if (choice === 'start_fresh') {
      db.updateSession(targetSessionId, { sdkSessionId: undefined, sdkOriginPath: undefined });
      const session = agentSession.getSessionData();
      session.sdkSessionId = undefined;
      session.sdkOriginPath = undefined;
    }

    const resolvedMessage: HyperNeoActionMessage = {
      type: 'hyperneo_action',
      uuid: messageUuid,
      session_id: targetSessionId,
      action: 'sdk_resume_choice',
      resolved: true,
      chosenOption: choice,
      timestamp: Date.now(),
    };

    db.updateHyperNeoActionMessageByUuid(targetSessionId, messageUuid, resolvedMessage);

    messageHub.event(
      'state.sdkMessages.delta',
      { added: [resolvedMessage], timestamp: Date.now() },
      { channel: `session:${targetSessionId}` }
    );

    try {
      await agentSession.restart();
      if (agentSession.getSessionData().config.queryMode !== 'manual') {
        await agentSession.replayPendingMessagesForImmediateMode();
      }
    } catch (err) {
      log.warn(`session.sdkResumeChoice: restart after choice failed: ${err}`);
    }

    return { success: true };
  });
}
