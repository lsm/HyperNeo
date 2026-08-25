import type {
  MessageHub,
  Session,
  SettingSource,
  SpaceWorkerAgent,
  SpaceWorkerAgentPromotionDraft,
  ThinkingLevel,
} from '@hyperneo/shared';
import { isKnownToolEntry, isScopedBashToolEntry } from '@hyperneo/shared';
import type { Database } from '../../storage/index.ts';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import type { SpaceAgentManager } from '../space/managers/space-agent-manager.ts';
import type { SpaceManager } from '../space/managers/space-manager.ts';
import { getPresetAgentTemplates } from '../space/agents/seed-agents.ts';
import { computeAgentTemplateHash } from '../space/agents/agent-template-hash.ts';
import { Logger } from '../logger.ts';

const log = new Logger('space-agent-handlers');

const PROMOTION_MESSAGE_LIMIT = 24;
const PROMOTION_CONTEXT_CHAR_LIMIT = 6000;

function clampText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1).trimEnd()}…`;
}

function clampTextEnd(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `…${value.slice(value.length - limit + 1).trimStart()}`;
}

function deriveAgentName(session: Session): string {
  const base = (session.title || 'Promoted Agent')
    .replace(/^space chat:?\s*/i, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim();
  return clampText(base || 'Promoted Agent', 64);
}

function extractTools(session: Session): string[] | undefined {
  const preset = session.config.sdkToolsPreset;
  if (Array.isArray(preset)) {
    const tools = preset.filter((tool) => isKnownToolEntry(tool));
    return [...new Set(tools)];
  }

  const disallowedTools =
    session.config.disallowedTools?.filter((tool) => isKnownToolEntry(tool)) ?? [];
  if (disallowedTools.length === 0) return undefined;

  const hasScopedBash = (session.config.allowedTools ?? []).some((tool) =>
    isScopedBashToolEntry(tool)
  );
  const defaultTools = [
    'Read',
    'Write',
    'Edit',
    'MultiEdit',
    ...(hasScopedBash ? [] : ['Bash']),
    'Grep',
    'Glob',
    'WebFetch',
    'WebSearch',
    'NotebookEdit',
    'TodoWrite',
    'AskUserQuestion',
    'EnterPlanMode',
    'ExitPlanMode',
    'Skill',
    'ToolSearch',
  ];
  const preservedAllowedTools =
    session.config.allowedTools?.filter((tool) => isKnownToolEntry(tool)) ?? [];
  const disallowed = new Set(disallowedTools);
  return [...new Set([...defaultTools, ...preservedAllowedTools])].filter(
    (tool) => !disallowed.has(tool)
  );
}

function extractSettingSources(session: Session): SettingSource[] | undefined {
  if (session.config.settingSources !== undefined) return session.config.settingSources;
  const toolSources = session.config.tools?.settingSources;
  return toolSources !== undefined ? toolSources : undefined;
}

function buildPromotionDraft(session: Session, db: Database): SpaceWorkerAgentPromotionDraft {
  const messages = db.getRenderableTextMessages(session.id, PROMOTION_MESSAGE_LIMIT);
  const context = messages.length
    ? messages
        .map((message) => {
          const speaker = message.type === 'assistant' ? 'Assistant' : 'User';
          return `${speaker}: ${message.text}`;
        })
        .join('\n\n---\n\n')
    : 'No renderable chat messages were available. Fill in standing context manually before creating this agent.';
  const standingContext = clampTextEnd(context, PROMOTION_CONTEXT_CHAR_LIMIT);
  const name = deriveAgentName(session);
  const responsibility = `Continue the durable role that emerged in "${session.title || session.id}".`;
  const standingInstructions =
    'Use the standing context below as background, not as a transcript to replay. Keep future work goal-oriented, cite uncertainty, and ask for human input before high-impact actions.';
  const autonomy =
    'Supervised by default: propose actions and wait for explicit approval before destructive, external, or irreversible changes.';
  const managedGoals =
    'Review and narrow this list to the goals this long-horizon agent should own.';
  const managedScopes =
    'Review and narrow this list to repositories, files, systems, or product areas this agent may manage.';
  const reminders =
    'Periodically summarize progress, blockers, decisions, and needed human follow-up.';
  const eventSubscriptions =
    'Review and list events this agent should react to, such as task changes, PR reviews, CI failures, mentions, or scheduled check-ins.';
  const customPrompt = `## Responsibility\n${responsibility}\n\n## Standing Instructions\n${standingInstructions}\n\n## Autonomy\n${autonomy}\n\n## Managed Goals\n${managedGoals}\n\n## Managed Scopes\n${managedScopes}\n\n## Reminders\n${reminders}\n\n## Event Subscriptions\n${eventSubscriptions}\n\n## Standing Context From Promoted Session\n${standingContext}`;

  return {
    sourceSessionId: session.id,
    sourceSessionTitle: session.title || session.id,
    name,
    description: responsibility,
    model: session.config.model,
    thinkingLevel: session.config.thinkingLevel as ThinkingLevel | undefined,
    provider: session.config.provider,
    customPrompt,
    tools: extractTools(session),
    settingSources: extractSettingSources(session),
    profile: {
      responsibility,
      standingInstructions,
      autonomy,
      managedGoals,
      managedScopes,
      reminders,
      eventSubscriptions,
      standingContext,
    },
  };
}

async function publishAgentCreated(
  internalEventBus: InternalEventBus<DaemonInternalEventMap>,
  agent: SpaceWorkerAgent
): Promise<void> {
  await internalEventBus
    .publish('spaceAgent.created', {
      sessionId: `space:${agent.spaceId}`,
      spaceId: agent.spaceId,
      agent,
    })
    .catch((err) => {
      log.warn('Failed to emit spaceAgent.created:', err);
    });
}

export function setupSpaceAgentHandlers(
  messageHub: MessageHub,
  internalEventBus: InternalEventBus<DaemonInternalEventMap>,
  spaceAgentManager: SpaceAgentManager,
  spaceManager: SpaceManager,
  db: Database,
  runtimeService?: {
    removeLongHorizonAgentSubscriptions(spaceId: string, agentId: string): void;
    clearLongTermAgentSessionProvider(spaceId: string, agentId: string): Promise<void>;
  }
): void {
  messageHub.onRequest('spaceAgent.listBuiltInTemplates', async (data) => {
    const params = data as { spaceId: string };
    if (!params.spaceId) throw new Error('spaceId is required');

    const space = await spaceManager.getSpace(params.spaceId);
    if (!space) throw new Error(`Space not found: ${params.spaceId}`);

    return {
      templates: getPresetAgentTemplates().map((template) => ({
        ...template,
        templateHash: computeAgentTemplateHash(template),
      })),
    };
  });

  messageHub.onRequest('spaceAgent.create', async (data) => {
    const params = data as {
      spaceId: string;
      name: string;
      handle?: string;
      description?: string;
      model?: string;
      thinkingLevel?: import('@hyperneo/shared').ThinkingLevel;
      provider?: string;
      customPrompt?: string | null;
      tools?: string[];
      settingSources?: import('@hyperneo/shared').SettingSource[];
      templateName?: string | null;
      templateHash?: string | null;
      modelPool?: import('@hyperneo/shared').WorkerAgentModelPoolEntry[];
    };

    if (!params.spaceId) throw new Error('spaceId is required');
    if (!params.name) throw new Error('name is required');

    const result = await spaceAgentManager.create({
      spaceId: params.spaceId,
      name: params.name,
      handle: params.handle,
      description: params.description,
      model: params.model,
      thinkingLevel: params.thinkingLevel,
      provider: params.provider,
      customPrompt: params.customPrompt,
      tools: params.tools,
      settingSources: params.settingSources,
      templateName: params.templateName,
      templateHash: params.templateHash,
      modelPool: params.modelPool,
    });

    if (!result.ok) throw new Error(result.error);

    await publishAgentCreated(internalEventBus, result.value);

    return { agent: result.value };
  });

  messageHub.onRequest('spaceAgent.getPromotionDraft', async (data) => {
    const params = data as { spaceId: string; sessionId: string };
    if (!params.spaceId) throw new Error('spaceId is required');
    if (!params.sessionId) throw new Error('sessionId is required');

    const space = await spaceManager.getSpace(params.spaceId);
    if (!space) throw new Error(`Space not found: ${params.spaceId}`);

    const session = db.getSession(params.sessionId);
    if (!session) throw new Error(`Session not found: ${params.sessionId}`);
    if (session.context?.spaceId !== params.spaceId) {
      throw new Error(`Session not found: ${params.sessionId}`);
    }
    if (session.type === 'space_task_agent') {
      throw new Error('Task agent sessions cannot be promoted');
    }

    return { draft: buildPromotionDraft(session, db) };
  });

  messageHub.onRequest('spaceAgent.promoteSession', async (data) => {
    const params = data as {
      spaceId: string;
      sessionId: string;
      name: string;
      handle?: string;
      description?: string;
      model?: string;
      thinkingLevel?: import('@hyperneo/shared').ThinkingLevel;
      provider?: string;
      customPrompt?: string | null;
      tools?: string[];
      settingSources?: import('@hyperneo/shared').SettingSource[];
      templateName?: string | null;
      templateHash?: string | null;
      modelPool?: import('@hyperneo/shared').WorkerAgentModelPoolEntry[];
    };
    if (!params.spaceId) throw new Error('spaceId is required');
    if (!params.sessionId) throw new Error('sessionId is required');
    if (!params.name) throw new Error('name is required');

    const space = await spaceManager.getSpace(params.spaceId);
    if (!space) throw new Error(`Space not found: ${params.spaceId}`);

    const session = db.getSession(params.sessionId);
    if (!session) throw new Error(`Session not found: ${params.sessionId}`);
    if (session.context?.spaceId !== params.spaceId) {
      throw new Error(`Session not found: ${params.sessionId}`);
    }
    if (session.type === 'space_task_agent') {
      throw new Error('Task agent sessions cannot be promoted');
    }

    const result = await spaceAgentManager.create({
      spaceId: params.spaceId,
      name: params.name,
      handle: params.handle,
      description: params.description,
      model: params.model,
      thinkingLevel: params.thinkingLevel,
      provider: params.provider,
      customPrompt: params.customPrompt,
      tools: params.tools,
      settingSources: params.settingSources,
      templateName: params.templateName,
      templateHash: params.templateHash,
      modelPool: params.modelPool,
    });
    if (!result.ok) throw new Error(result.error);

    await publishAgentCreated(internalEventBus, result.value);
    return { agent: result.value };
  });

  messageHub.onRequest('spaceAgent.list', async (data) => {
    const params = data as { spaceId: string };
    if (!params.spaceId) throw new Error('spaceId is required');

    const agents = spaceAgentManager.listBySpaceId(params.spaceId);
    return { agents };
  });

  messageHub.onRequest('spaceAgent.get', async (data) => {
    const params = data as { id: string };
    if (!params.id) throw new Error('id is required');

    const agent = spaceAgentManager.getById(params.id);
    if (!agent) throw new Error(`Agent not found: ${params.id}`);

    return { agent };
  });

  messageHub.onRequest('spaceAgent.update', async (data) => {
    const params = data as {
      id: string;
      name?: string;
      handle?: string;
      description?: string | null;
      model?: string | null;
      thinkingLevel?: import('@hyperneo/shared').ThinkingLevel | null;
      provider?: string | null;
      customPrompt?: string | null;
      tools?: string[] | null;
      settingSources?: import('@hyperneo/shared').SettingSource[] | null;
      templateName?: string | null;
      templateHash?: string | null;
      modelPool?: import('@hyperneo/shared').WorkerAgentModelPoolEntry[] | null;
    };

    if (!params.id) throw new Error('id is required');

    const { id, ...updateFields } = params;
    const result = await spaceAgentManager.update(id, {
      name: updateFields.name,
      handle: updateFields.handle,
      description: updateFields.description,
      model: updateFields.model,
      thinkingLevel: updateFields.thinkingLevel,
      provider: updateFields.provider,
      customPrompt: updateFields.customPrompt,
      tools: updateFields.tools,
      settingSources: updateFields.settingSources,
      templateName: updateFields.templateName,
      templateHash: updateFields.templateHash,
      modelPool: updateFields.modelPool,
    });

    if (!result.ok) throw new Error(result.error);

    if (updateFields.provider === null && runtimeService) {
      await runtimeService.clearLongTermAgentSessionProvider(result.value.spaceId, result.value.id);
    }

    internalEventBus
      .publish('spaceAgent.updated', {
        sessionId: `space:${result.value.spaceId}`,
        spaceId: result.value.spaceId,
        agent: result.value,
      })
      .catch((err) => {
        log.warn('Failed to emit spaceAgent.updated:', err);
      });

    return { agent: result.value };
  });

  messageHub.onRequest('spaceAgent.getDriftReport', async (data) => {
    const params = data as { spaceId: string };
    if (!params.spaceId) throw new Error('spaceId is required');

    const space = await spaceManager.getSpace(params.spaceId);
    if (!space) throw new Error(`Space not found: ${params.spaceId}`);

    const report = spaceAgentManager.getAgentDriftReport(params.spaceId);
    return { report };
  });

  messageHub.onRequest('spaceAgent.previewTemplateSync', async (data) => {
    const params = data as { spaceId: string; agentId: string };
    if (!params.spaceId) throw new Error('spaceId is required');
    if (!params.agentId) throw new Error('agentId is required');

    const space = await spaceManager.getSpace(params.spaceId);
    if (!space) throw new Error(`Space not found: ${params.spaceId}`);

    const existing = spaceAgentManager.getById(params.agentId);
    if (!existing) throw new Error(`Agent not found: ${params.agentId}`);
    if (existing.spaceId !== params.spaceId) {
      throw new Error(`Agent not found: ${params.agentId}`);
    }

    const result = await spaceAgentManager.getTemplateSyncPreview(params.agentId);
    if (!result.ok) throw new Error(result.error);

    return { preview: result.value };
  });

  messageHub.onRequest('spaceAgent.syncFromTemplate', async (data) => {
    const params = data as { spaceId: string; agentId: string; expectedRowHash?: string };
    if (!params.spaceId) throw new Error('spaceId is required');
    if (!params.agentId) throw new Error('agentId is required');

    const space = await spaceManager.getSpace(params.spaceId);
    if (!space) throw new Error(`Space not found: ${params.spaceId}`);

    const existing = spaceAgentManager.getById(params.agentId);
    if (!existing) throw new Error(`Agent not found: ${params.agentId}`);
    if (existing.spaceId !== params.spaceId) {
      throw new Error(`Agent not found: ${params.agentId}`);
    }

    const result = await spaceAgentManager.syncFromTemplate(params.agentId, params.expectedRowHash);
    if (!result.ok) throw new Error(result.error);

    internalEventBus
      .publish('spaceAgent.updated', {
        sessionId: `space:${result.value.spaceId}`,
        spaceId: result.value.spaceId,
        agent: result.value,
      })
      .catch((err) => {
        log.warn('Failed to emit spaceAgent.updated:', err);
      });

    return { agent: result.value };
  });

  messageHub.onRequest('spaceAgent.delete', async (data) => {
    const params = data as { id: string };
    if (!params.id) throw new Error('id is required');

    const existing = spaceAgentManager.getById(params.id);
    if (!existing) throw new Error(`Agent not found: ${params.id}`);

    const result = spaceAgentManager.delete(params.id);
    if (!result.ok) {
      const detailsMsg = result.details?.length ? `\n${result.details.join('\n')}` : '';
      throw new Error(`${result.error}${detailsMsg}`);
    }
    void runtimeService;

    await internalEventBus
      .publish('spaceAgent.deleted', {
        sessionId: `space:${existing.spaceId}`,
        spaceId: existing.spaceId,
        agentId: params.id,
      })
      .catch((err) => {
        log.warn('Failed to emit spaceAgent.deleted:', err);
      });

    return { success: true };
  });
}
