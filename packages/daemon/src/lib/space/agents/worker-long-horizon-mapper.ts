import type {
  SettingSource,
  SpaceLongHorizonAgent,
  SpaceLongHorizonAgentStatus,
  SpaceWorkerAgent,
  SpaceWorkerAgentStatus,
  ThinkingLevel,
  WorkerAgentModelPoolEntry,
} from '@hyperneo/shared';

export interface WorkerAgentRowSource {
  id: string;
  spaceId: string;
  name: string;
  handle?: string | null;
  status?: string | null;
  description?: string | null;
  model?: string | null;
  thinkingLevel?: ThinkingLevel | null;
  provider?: string | null;
  customPrompt?: string | null;
  instructions?: string | null;
  systemPrompt?: string | null;
  tools?: readonly string[] | null;
  settingSources?: readonly SettingSource[] | null;
  modelPool?: readonly WorkerAgentModelPoolEntry[] | null;
  createdAt?: number | null;
}

export interface WorkerAgentToLongHorizonParams {
  id: string;
  spaceId: string;
  handle: string;
  displayName: string;
  templateKey: string;
  status: SpaceLongHorizonAgentStatus;
  sessionId: null;
  instructions: string;
  autonomyLevel: null;
  model: string | null;
  thinkingLevel: ThinkingLevel | null;
  provider: string | null;
  settingSources: SettingSource[] | null;
  toolPermissions: Record<string, unknown>;
  description: string | undefined;
  modelPool: readonly WorkerAgentModelPoolEntry[] | undefined;
  createdAt: number;
  updatedAt: number;
}

export interface WorkerAgentToLongHorizonOptions {
  occupiedHandles: ReadonlySet<string>;
  now: number;
}

export const MIGRATED_WORKER_TEMPLATE_KEY = 'migration.legacy_space_agent';

export function workerAgentToLongHorizonParams(
  worker: WorkerAgentRowSource,
  options: WorkerAgentToLongHorizonOptions
): WorkerAgentToLongHorizonParams {
  const baseHandle = worker.handle ?? worker.name ?? worker.id;
  const idSegment = `-${worker.id}`;
  let handle = baseHandle.length <= 60 ? baseHandle : baseHandle.slice(0, 60);
  let probe = 0;
  while (options.occupiedHandles.has(handle)) {
    const suffix = probe === 0 ? idSegment : `${idSegment}-${probe + 1}`;
    const room = Math.max(1, 60 - suffix.length);
    const stem = baseHandle.length > room ? baseHandle.slice(0, room) : baseHandle;
    handle = `${stem}${suffix}`;
    probe += 1;
  }
  const tools = worker.tools ?? [];
  return {
    id: worker.id,
    spaceId: worker.spaceId,
    handle,
    displayName: worker.name ?? worker.handle ?? worker.id,
    templateKey: MIGRATED_WORKER_TEMPLATE_KEY,
    status: mapWorkerStatus(worker.status),
    sessionId: null,
    instructions: worker.customPrompt ?? worker.instructions ?? worker.systemPrompt ?? '',
    autonomyLevel: null,
    model: worker.model ?? null,
    thinkingLevel: worker.thinkingLevel ?? null,
    provider: worker.provider ?? null,
    settingSources: worker.settingSources ? [...worker.settingSources] : null,
    toolPermissions: tools.length > 0 ? { tools: [...tools] } : {},
    description: worker.description || undefined,
    modelPool: worker.modelPool ? [...worker.modelPool] : undefined,
    createdAt: worker.createdAt ?? options.now,
    updatedAt: options.now,
  };
}

function mapWorkerStatus(status: string | null | undefined): SpaceLongHorizonAgentStatus {
  if (status === 'paused') return 'paused';
  if (status === 'archived') return 'archived';
  return 'active';
}

export function longHorizonAgentToWorkerView(agent: SpaceLongHorizonAgent): SpaceWorkerAgent {
  const tools = Array.isArray(agent.toolPermissions.tools)
    ? agent.toolPermissions.tools.filter((tool): tool is string => typeof tool === 'string')
    : undefined;
  return {
    id: agent.id,
    spaceId: agent.spaceId,
    name: agent.displayName,
    handle: agent.handle,
    status: mapLongHorizonStatus(agent.status),
    description: agent.description,
    model: agent.model ?? undefined,
    thinkingLevel: agent.thinkingLevel ?? undefined,
    provider: agent.provider ?? undefined,
    customPrompt: agent.instructions,
    tools,
    settingSources: agent.settingSources ?? undefined,
    templateName: agent.templateKey,
    templateHash: null,
    modelPool: agent.modelPool,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  };
}

function mapLongHorizonStatus(status: SpaceLongHorizonAgentStatus): SpaceWorkerAgentStatus {
  if (status === 'paused' || status === 'disabled') return 'paused';
  if (status === 'archived') return 'archived';
  return 'active';
}

export function isRunnableUnifiedAgent(agent: SpaceLongHorizonAgent): boolean {
  if (agent.templateKey === MIGRATED_WORKER_TEMPLATE_KEY) return true;
  return agent.status === 'active';
}

export function unifiedAgentRecordExists(
  unified: SpaceLongHorizonAgent,
  expectedSpaceId: string | undefined,
  getWorkerAgent: (agentId: string) => SpaceWorkerAgent | null | undefined
): boolean {
  if (expectedSpaceId && unified.spaceId !== expectedSpaceId) return false;
  if (unified.templateKey === MIGRATED_WORKER_TEMPLATE_KEY) {
    const worker = getWorkerAgent(unified.id);
    return worker != null && worker.spaceId === unified.spaceId;
  }
  return isRunnableUnifiedAgent(unified);
}
