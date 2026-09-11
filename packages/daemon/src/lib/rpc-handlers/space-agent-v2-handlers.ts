import type { MessageHub, SpaceAgent, SpaceAgentTemplate } from '@hyperneo/shared';
import type { SpaceAgentRepository } from '../../storage/repositories/space-agent-repository.ts';
import type { SpaceLongHorizonAgentRepository } from '../../storage/repositories/space-long-horizon-agent-repository.ts';
import type { SpaceAgentTemplateRepository } from '../../storage/repositories/space-agent-template-repository.ts';
import { SPACE_MANAGER_HANDLE } from '../space/agent-handle.ts';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import {
  validateAgentModel,
  validateAgentModelPool,
  validateSpaceAgentTools,
} from '../space/agents/agent-validation.ts';
import {
  type BindableSession,
  buildCreateSpaceAgentPipeline,
  type CreateSpaceAgentInput,
  isCreateSpaceAgentRejection,
} from '../space/agents/create-space-agent-pipeline.ts';
import {
  buildUpdateSpaceAgentPipeline,
  type UpdateSpaceAgentInput,
} from '../space/agents/update-space-agent-pipeline.ts';
import { getBuiltInSpaceAgentTemplates } from '../space/managers/space-agent-template-manager.ts';
import {
  publishUnifiedAgentCreated,
  publishUnifiedAgentDeleted,
  publishUnifiedAgentUpdated,
} from '../space/agents/unified-agent-events.ts';

const METHOD_PREFIX = 'spaceAgentV2';

export interface SessionLookup {
  type?: string;
  context?: { spaceId?: string | null } | null;
}

export interface SpaceAgentV2Deps {
  agents: SpaceAgentRepository;
  templates: Pick<SpaceAgentTemplateRepository, 'getByKey'>;
  spaceExists(spaceId: string): Promise<boolean>;
  getSession(sessionId: string): SessionLookup | null;
  internalEventBus?: InternalEventBus<DaemonInternalEventMap>;
  legacyAgents?: Pick<SpaceLongHorizonAgentRepository, 'getById'>;
  reminders: Pick<SpaceLongHorizonAgentRepository, 'listReminders'>;
  removeAgentSubscriptions?(spaceId: string, agentId: string): void;
  refreshAgentSubscriptions?(
    spaceId: string,
    agentId: string
  ): { success: boolean; error?: string };
  clearSessionProvider?(spaceId: string, agentId: string): Promise<void>;
  seedTemplateExtras?(agent: SpaceAgent, template: SpaceAgentTemplate): void;
}

const COORDINATOR_HANDLES = new Set([SPACE_MANAGER_HANDLE, 'coordinator']);

export function assertAgentDeletable(agent: SpaceAgent): void {
  if (COORDINATOR_HANDLES.has(agent.handle)) {
    throw new Error('The Space Manager agent cannot be deleted');
  }
}

export function toBindableSession(session: SessionLookup | null): BindableSession | null {
  if (!session) return null;
  return { type: session.type ?? '', spaceId: session.context?.spaceId ?? null };
}

async function publishAgentEvent(
  deps: SpaceAgentV2Deps,
  topic: 'spaceAgentV2.created' | 'spaceAgentV2.updated',
  agent: SpaceAgent
): Promise<void> {
  if (!deps.internalEventBus) return;
  await deps.internalEventBus
    .publish(topic, { sessionId: `space:${agent.spaceId}`, spaceId: agent.spaceId, agent })
    .catch(() => {});
  const legacy = deps.legacyAgents?.getById(agent.id);
  if (!legacy) return;
  if (topic === 'spaceAgentV2.created') {
    await publishUnifiedAgentCreated(deps.internalEventBus, legacy);
    return;
  }
  await publishUnifiedAgentUpdated(deps.internalEventBus, legacy);
}

async function publishAgentDeleted(
  deps: SpaceAgentV2Deps,
  spaceId: string,
  agentId: string
): Promise<void> {
  if (!deps.internalEventBus) return;
  await deps.internalEventBus
    .publish('spaceAgentV2.deleted', { sessionId: `space:${spaceId}`, spaceId, agentId })
    .catch(() => {});
  await publishUnifiedAgentDeleted(deps.internalEventBus, spaceId, agentId);
}

function method(name: string): string {
  return `${METHOD_PREFIX}.${name}`;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} is required`);
  }
  return value;
}

export function resolveTemplate(
  deps: SpaceAgentV2Deps
): (key: string) => ReturnType<SpaceAgentTemplateRepository['getByKey']> {
  const builtIns = new Map(
    getBuiltInSpaceAgentTemplates().map((template) => [template.key, template])
  );
  return (key) => builtIns.get(key) ?? deps.templates.getByKey(key);
}

export function buildAgentCreate(
  deps: SpaceAgentV2Deps
): (input: CreateSpaceAgentInput) => Promise<SpaceAgent> {
  const run = buildCreateSpaceAgentPipeline({
    spaceExists: deps.spaceExists,
    sessionOwner: (sessionId) => deps.agents.getBySessionId(sessionId)?.id ?? null,
    getSession: (sessionId) => toBindableSession(deps.getSession(sessionId)),
    getTemplate: resolveTemplate(deps),
    listHandles: (spaceId) =>
      deps.agents.listIdentitiesBySpaceId(spaceId).map((agent) => agent.handle),
    listDisplayNames: (spaceId) =>
      deps.agents
        .listIdentitiesBySpaceId(spaceId)
        .filter((agent) => agent.status !== 'archived')
        .map((agent) => agent.displayName),
    createAgent: (params) => deps.agents.create(params),
    publishCreated: (agent) => publishAgentEvent(deps, 'spaceAgentV2.created', agent),
    seedTemplateExtras: deps.seedTemplateExtras,
    validateTools: validateSpaceAgentTools,
    validateModel: (model, provider) => validateAgentModel(model, provider),
    validateModelPool: validateAgentModelPool,
  });

  return async (input) => {
    const outcome = await run(input);
    if (isCreateSpaceAgentRejection(outcome)) throw new Error(outcome.message);
    return outcome;
  };
}

export function buildAgentUpdate(
  deps: SpaceAgentV2Deps
): (input: UpdateSpaceAgentInput) => Promise<SpaceAgent> {
  const run = buildUpdateSpaceAgentPipeline({
    getAgent: (id) => deps.agents.getById(id),
    getSession: (sessionId) => toBindableSession(deps.getSession(sessionId)),
    sessionOwner: (sessionId) => deps.agents.getBySessionId(sessionId)?.id ?? null,
    listHandles: (spaceId) =>
      deps.agents.listIdentitiesBySpaceId(spaceId).map((agent) => agent.handle),
    listDisplayNames: (spaceId, excludeAgentId) =>
      deps.agents
        .listIdentitiesBySpaceId(spaceId)
        .filter((agent) => agent.status !== 'archived' && agent.id !== excludeAgentId)
        .map((agent) => agent.displayName),
    applyUpdate: (id, changes) => deps.agents.update(id, changes),
    publishUpdated: (agent) => publishAgentEvent(deps, 'spaceAgentV2.updated', agent),
    applyRuntimeEffects: (agent, input) => applyUpdateRuntimeEffects(deps, agent, input),
    validateTools: validateSpaceAgentTools,
    validateModel: (model, provider) => validateAgentModel(model, provider),
    validateModelPool: validateAgentModelPool,
  });

  return async (input) => {
    const outcome = await run(input);
    if (isCreateSpaceAgentRejection(outcome)) throw new Error(outcome.message);
    return outcome;
  };
}

export async function applyUpdateRuntimeEffects(
  deps: SpaceAgentV2Deps,
  agent: SpaceAgent,
  input: UpdateSpaceAgentInput
): Promise<void> {
  if (input.provider === null) {
    await deps.clearSessionProvider?.(agent.spaceId, agent.id);
  }
  const refresh = deps.refreshAgentSubscriptions?.(agent.spaceId, agent.id);
  if (refresh && !refresh.success) {
    throw new Error(refresh.error ?? 'Failed to refresh subscriptions');
  }
}

export function setupSpaceAgentV2Handlers(messageHub: MessageHub, deps: SpaceAgentV2Deps): void {
  const createAgent = buildAgentCreate(deps);
  const updateAgent = buildAgentUpdate(deps);

  messageHub.onRequest(method('list'), async (data) => {
    const params = data as { spaceId?: string };
    const spaceId = requireString(params.spaceId, 'spaceId');
    return { agents: deps.agents.listOwnedBySpaceId(spaceId) };
  });

  messageHub.onRequest(method('get'), async (data) => {
    const params = data as { id?: string };
    const id = requireString(params.id, 'id');
    const agent = deps.agents.getById(id);
    if (!agent) throw new Error(`Agent not found: ${id}`);
    return { agent };
  });

  messageHub.onRequest(method('create'), async (data) => {
    const params = data as CreateSpaceAgentInput;
    requireString(params?.spaceId, 'spaceId');
    return { agent: await createAgent(params) };
  });

  messageHub.onRequest(method('update'), async (data) => {
    const params = data as UpdateSpaceAgentInput;
    requireString(params?.id, 'id');
    return { agent: await updateAgent(params) };
  });

  messageHub.onRequest(method('listReminderCounts'), async (data) => {
    const params = data as { spaceId?: string };
    const spaceId = requireString(params.spaceId, 'spaceId');
    const counts: Record<string, number> = {};
    for (const agent of deps.agents.listOwnedBySpaceId(spaceId)) {
      const reminders = deps.reminders.listReminders(agent.id);
      counts[agent.id] = reminders.filter((reminder) => reminder.status === 'active').length;
    }
    return { counts };
  });

  messageHub.onRequest(method('delete'), async (data) => {
    const params = data as { id?: string };
    const id = requireString(params.id, 'id');
    const existing = deps.agents.getById(id);
    if (!existing) throw new Error(`Agent not found: ${id}`);
    assertAgentDeletable(existing);
    deps.agents.delete(id);
    deps.removeAgentSubscriptions?.(existing.spaceId, id);
    await publishAgentDeleted(deps, existing.spaceId, id);
    return { id };
  });
}
