import type {
  SettingSource,
  SpaceLongHorizonAgentStatus,
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

export function workerAgentToLongHorizonParams(
  worker: WorkerAgentRowSource,
  options: WorkerAgentToLongHorizonOptions
): WorkerAgentToLongHorizonParams {
  const baseHandle = worker.handle ?? worker.name ?? worker.id;
  let handle = baseHandle;
  while (options.occupiedHandles.has(handle)) {
    handle = `${handle}-${worker.id}`;
  }
  const tools = worker.tools ?? [];
  return {
    id: worker.id,
    spaceId: worker.spaceId,
    handle,
    displayName: worker.name ?? worker.handle ?? worker.id,
    templateKey: 'migration.legacy_space_agent',
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
