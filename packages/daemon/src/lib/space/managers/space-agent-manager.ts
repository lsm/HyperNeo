import type {
  SpaceWorkerAgent,
  CreateSpaceWorkerAgentParams,
  UpdateSpaceWorkerAgentParams,
} from '@hyperneo/shared';
import { KNOWN_TOOLS, isKnownToolEntry } from '@hyperneo/shared';
import type { SpaceAgentRepository } from '../../../storage/repositories/space-agent-repository.ts';

type LongHorizonAgentHandleSource = {
  listBySpaceId(spaceId: string): Array<{ id: string; handle: string }>;
};
import { RESERVED_SPACE_AGENT_HANDLES, slugifyWithinLimit, validateSlug } from '../slug.ts';
import {
  isValidModel,
  getAvailableModels,
  getModelsCache,
  getModelInfoUnfiltered,
} from '../../model-service.ts';

const RESERVED_AGENT_HANDLES = new Set<string>(RESERVED_SPACE_AGENT_HANDLES);

export type SpaceAgentResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; details?: string[] };

export class SpaceAgentManager {
  constructor(
    private repo: SpaceAgentRepository,
    private longHorizonAgentHandles?: LongHorizonAgentHandleSource
  ) {}

  async create(params: CreateSpaceWorkerAgentParams): Promise<SpaceAgentResult<SpaceWorkerAgent>> {
    if (this.repo.isNameTaken(params.spaceId, params.name)) {
      return {
        ok: false,
        error: `An agent named "${params.name}" already exists in this Space`,
      };
    }

    const handle = params.handle ?? this.generateUniqueHandle(params.spaceId, params.name);
    const handleError = this.validateHandle(params.spaceId, handle);
    if (handleError) return { ok: false, error: handleError };
    params = { ...params, handle };

    if (params.tools) {
      const toolError = validateSpaceAgentTools(params.tools);
      if (toolError) return { ok: false, error: toolError };
    }

    if (params.model) {
      const modelError = await validateAgentModel(params.model, params.provider);
      if (modelError) return { ok: false, error: modelError };
    }

    if (params.modelPool) {
      const poolError = await validateAgentModelPool(params.modelPool);
      if (poolError) return { ok: false, error: poolError };
    }

    const agent = this.repo.create(params);
    return { ok: true, value: agent };
  }

  async update(
    id: string,
    params: UpdateSpaceWorkerAgentParams
  ): Promise<SpaceAgentResult<SpaceWorkerAgent>> {
    const existing = this.repo.getById(id);
    if (!existing) return { ok: false, error: `Agent not found: ${id}` };

    if (params.name !== undefined && params.name !== existing.name) {
      if (this.repo.isNameTaken(existing.spaceId, params.name, id)) {
        return {
          ok: false,
          error: `An agent named "${params.name}" already exists in this Space`,
        };
      }
    }

    if (params.handle !== undefined && params.handle !== existing.handle) {
      const handleError = this.validateHandle(existing.spaceId, params.handle, id);
      if (handleError) return { ok: false, error: handleError };
    }

    if (params.tools) {
      const toolError = validateSpaceAgentTools(params.tools);
      if (toolError) return { ok: false, error: toolError };
    }

    if (params.model) {
      const provider =
        params.provider !== undefined ? (params.provider ?? undefined) : existing.provider;
      const modelError = await validateAgentModel(params.model, provider);
      if (modelError) return { ok: false, error: modelError };
    }

    if (params.modelPool) {
      const poolError = await validateAgentModelPool(params.modelPool);
      if (poolError) return { ok: false, error: poolError };
    }

    const updated = this.repo.update(id, params);
    if (!updated) return { ok: false, error: `Agent not found after update: ${id}` };
    return { ok: true, value: updated };
  }

  delete(id: string): SpaceAgentResult<void> {
    const existing = this.repo.getById(id);
    if (!existing) return { ok: false, error: `Agent not found: ${id}` };

    const { referenced, workflowNames } = this.repo.isAgentReferenced(id);
    if (referenced) {
      return {
        ok: false,
        error: `Cannot delete agent "${existing.name}" - it is referenced by workflow nodes`,
        details: workflowNames.map((n) => `Workflow: ${n}`),
      };
    }

    this.repo.delete(id);
    return { ok: true, value: undefined };
  }

  getById(id: string): SpaceWorkerAgent | null {
    return this.repo.getById(id);
  }

  isAgentReferenced(id: string): { referenced: boolean; workflowNames: string[] } {
    return this.repo.isAgentReferenced(id);
  }

  listBySpaceId(spaceId: string): SpaceWorkerAgent[] {
    return this.repo.getBySpaceId(spaceId);
  }

  getAgentsByIds(ids: string[]): SpaceWorkerAgent[] {
    return this.repo.getAgentsByIds(ids);
  }

  private validateHandle(spaceId: string, handle: string, excludeId?: string): string | null {
    const trimmed = handle.trim();
    if (trimmed !== handle) return 'Agent handle must not have leading or trailing whitespace';
    const slugError = validateSlug(trimmed);
    if (slugError) return `Invalid agent handle: ${slugError}`;
    if (RESERVED_AGENT_HANDLES.has(trimmed)) {
      return `Agent handle "${trimmed}" is reserved`;
    }
    if (this.repo.isHandleTaken(spaceId, trimmed, excludeId)) {
      return `An agent with handle "${trimmed}" already exists in this Space`;
    }
    if (this.longHorizonHandleTaken(spaceId, trimmed, excludeId)) {
      return `An agent with handle "${trimmed}" already exists in this Space`;
    }
    return null;
  }

  private generateUniqueHandle(spaceId: string, name: string): string {
    return slugifyWithinLimit(name, [
      ...this.repo.getHandlesForSpace(spaceId),
      ...this.longHorizonHandlesForSpace(spaceId).map((agent) => agent.handle),
      ...RESERVED_AGENT_HANDLES,
    ]);
  }

  private longHorizonHandleTaken(spaceId: string, handle: string, excludeId?: string): boolean {
    return this.longHorizonHandlesForSpace(spaceId).some(
      (agent) => agent.handle === handle && agent.id !== excludeId
    );
  }

  private longHorizonHandlesForSpace(spaceId: string): Array<{ id: string; handle: string }> {
    return this.longHorizonAgentHandles?.listBySpaceId(spaceId) ?? [];
  }
}

export function validateSpaceAgentTools(tools: string[]): string | null {
  const invalid = tools.filter((t) => !isKnownToolEntry(t));
  if (invalid.length === 0) return null;
  return `Unknown tool${invalid.length > 1 ? 's' : ''}: ${invalid.map((t) => `"${t}"`).join(', ')}. Valid tools: ${KNOWN_TOOLS.join(', ')} or scoped Bash entries like 'Bash(gh pr view:*)'`;
}

export async function validateAgentModel(
  model: string,
  provider?: string | null
): Promise<string | null> {
  const available = getAvailableModels('global');
  if (available.length === 0 && !getModelsCache().has('global')) return null;

  if (provider) {
    const valid = await isValidModel(model, 'global', provider);
    return valid ? null : `Unrecognized model "${model}" for provider "${provider}"`;
  }

  const info = await getModelInfoUnfiltered(model, 'global');
  return info ? null : `Unrecognized model: "${model}"`;
}

export async function validateAgentModelPool(
  pool: NonNullable<CreateSpaceWorkerAgentParams['modelPool']>
): Promise<string | null> {
  const seen = new Set<string>();
  for (const entry of pool) {
    if (!entry.model) return 'Model pool entries must specify a model';
    if (seen.has(entry.model)) {
      return `Model pool contains duplicate entries for "${entry.model}"`;
    }
    seen.add(entry.model);
    if (!Number.isInteger(entry.maxConcurrent) || entry.maxConcurrent < 1) {
      return `Model pool entry for "${entry.model}" must have an integer maxConcurrent >= 1`;
    }
    if (!Number.isFinite(entry.weight) || entry.weight < 0) {
      return `Model pool entry for "${entry.model}" must have weight >= 0`;
    }
    const modelError = await validateAgentModel(entry.model);
    if (modelError) return modelError;
  }
  if (!pool.some((entry) => entry.weight > 0)) {
    return 'Model pool must have at least one entry with weight > 0';
  }
  return null;
}
