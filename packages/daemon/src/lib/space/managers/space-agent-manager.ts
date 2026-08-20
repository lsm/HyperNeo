import type {
  SpaceWorkerAgent,
  CreateSpaceWorkerAgentParams,
  UpdateSpaceWorkerAgentParams,
  SpaceWorkerAgentDriftEntry,
  SpaceWorkerAgentDriftReport,
  SpaceWorkerAgentSyncDiff,
  SpaceWorkerAgentSyncPreview,
} from '@hyperneo/shared';
import { KNOWN_TOOLS, isKnownToolEntry } from '@hyperneo/shared';
import type { SpaceAgentRepository } from '../../../storage/repositories/space-agent-repository';

type LongHorizonAgentHandleSource = {
  listBySpaceId(spaceId: string): Array<{ id: string; handle: string }>;
};
import { RESERVED_SPACE_AGENT_HANDLES, slugifyWithinLimit, validateSlug } from '../slug';
import { isValidModel, getAvailableModels, getModelInfoUnfiltered } from '../../model-service';
import { Logger } from '../../logger';
import { getPresetAgentTemplates, type PresetAgentTemplate } from '../agents/seed-agents';
import { computeAgentTemplateHash } from '../agents/agent-template-hash';

const log = new Logger('space-agent-manager');

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
      const toolError = validateTools(params.tools);
      if (toolError) return { ok: false, error: toolError };
    }

    if (params.model) {
      const modelError = await this.validateModel(params.model, params.provider);
      if (modelError) return { ok: false, error: modelError };
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
      const toolError = validateTools(params.tools);
      if (toolError) return { ok: false, error: toolError };
    }

    if (params.model) {
      const provider =
        params.provider !== undefined ? (params.provider ?? undefined) : existing.provider;
      const modelError = await this.validateModel(params.model, provider);
      if (modelError) return { ok: false, error: modelError };
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

  listBySpaceId(spaceId: string): SpaceWorkerAgent[] {
    return this.repo.getBySpaceId(spaceId);
  }

  getAgentsByIds(ids: string[]): SpaceWorkerAgent[] {
    return this.repo.getAgentsByIds(ids);
  }

  getAgentDriftReport(spaceId: string): SpaceWorkerAgentDriftReport {
    const agents = this.repo.getBySpaceId(spaceId);
    const presetByName = new Map(getPresetAgentTemplates().map((p) => [p.name.toLowerCase(), p]));

    const entries: SpaceWorkerAgentDriftEntry[] = [];
    for (const agent of agents) {
      const preset = agent.templateName
        ? presetByName.get(agent.templateName.toLowerCase())
        : presetByName.get(agent.name.trim().toLowerCase());

      if (!preset) continue;

      const currentHash = computeAgentTemplateHash(preset);
      const rowHash = computeAgentTemplateHash({
        name: agent.name,
        description: agent.description ?? '',
        tools: agent.tools ?? [],
        customPrompt: agent.customPrompt ?? '',
      });
      const orphaned = !agent.templateName;

      if (orphaned) {
        entries.push({
          agentId: agent.id,
          agentName: agent.name,
          templateName: preset.name,
          storedHash: null,
          currentHash,
          rowHash,
          updateAvailable: true,
          customized: rowHash !== currentHash,
          orphaned: true,
        });
        continue;
      }

      const storedHash = agent.templateHash ?? null;
      entries.push({
        agentId: agent.id,
        agentName: agent.name,
        templateName: agent.templateName!,
        storedHash,
        currentHash,
        rowHash,
        updateAvailable: storedHash !== currentHash,
        customized: rowHash !== storedHash,
        orphaned: false,
      });
    }

    return { spaceId, agents: entries };
  }

  async syncFromTemplate(
    agentId: string,
    expectedRowHash?: string
  ): Promise<SpaceAgentResult<SpaceWorkerAgent>> {
    const existing = this.repo.getById(agentId);
    if (!existing) return { ok: false, error: `Agent not found: ${agentId}` };

    const resolved = this.resolvePresetForAgent(existing);
    if (!resolved.ok) {
      return { ok: false, error: resolved.error };
    }
    const { preset, canonicalName, reattached } = resolved;

    if (expectedRowHash !== undefined) {
      const currentRowHash = computeAgentTemplateHash({
        name: existing.name,
        description: existing.description ?? '',
        tools: existing.tools ?? [],
        customPrompt: existing.customPrompt ?? '',
      });
      if (currentRowHash !== expectedRowHash) {
        return {
          ok: false,
          error:
            'This agent changed since you opened the review. Close and reopen the diff to refresh.',
        };
      }
    }

    const templateHash = computeAgentTemplateHash(preset);
    log.info('Syncing space agent from preset template', {
      agentId,
      spaceId: existing.spaceId,
      agentName: existing.name,
      templateName: canonicalName,
      previousTemplateHash: existing.templateHash,
      templateHash,
      reattached,
      source: 'user_sync_from_template',
    });

    const updated = this.repo.update(agentId, {
      description: preset.description,
      tools: preset.tools,
      customPrompt: preset.customPrompt,
      ...(reattached ? { templateName: canonicalName } : {}),
      templateHash,
    });
    if (!updated) return { ok: false, error: `Agent not found after sync: ${agentId}` };
    return { ok: true, value: updated };
  }

  async getTemplateSyncPreview(
    agentId: string
  ): Promise<SpaceAgentResult<SpaceWorkerAgentSyncPreview>> {
    const existing = this.repo.getById(agentId);
    if (!existing) return { ok: false, error: `Agent not found: ${agentId}` };

    const resolved = this.resolvePresetForAgent(existing);
    if (!resolved.ok) {
      return { ok: false, error: resolved.error };
    }
    const { preset, canonicalName, reattached } = resolved;

    const liveHash = computeAgentTemplateHash(preset);
    const storedHash = existing.templateHash ?? null;
    const rowHash = computeAgentTemplateHash({
      name: existing.name,
      description: existing.description ?? '',
      tools: existing.tools ?? [],
      customPrompt: existing.customPrompt ?? '',
    });
    const diff: SpaceWorkerAgentSyncDiff = {};

    if ((existing.customPrompt ?? '') !== preset.customPrompt) {
      diff.customPrompt = { before: existing.customPrompt ?? '', after: preset.customPrompt };
    }
    if ((existing.description ?? '') !== preset.description) {
      diff.description = { before: existing.description ?? '', after: preset.description };
    }

    const beforeTools = existing.tools ?? [];
    if (!toolSetsEqual(beforeTools, preset.tools)) {
      const beforeSet = new Set(beforeTools);
      const afterSet = new Set(preset.tools);
      diff.tools = {
        before: [...beforeTools],
        after: [...preset.tools],
        added: preset.tools.filter((t) => !beforeSet.has(t)),
        removed: beforeTools.filter((t) => !afterSet.has(t)),
      };
    }

    return {
      ok: true,
      value: {
        agentId: existing.id,
        agentName: existing.name,
        templateName: canonicalName,
        storedHash,
        liveHash,
        rowHash,
        updateAvailable: storedHash !== liveHash,
        customized: reattached ? rowHash !== liveHash : rowHash !== storedHash,
        diff,
      },
    };
  }

  private resolvePresetForAgent(
    agent: SpaceWorkerAgent
  ):
    | { ok: true; preset: PresetAgentTemplate; canonicalName: string; reattached: boolean }
    | { ok: false; error: string } {
    const presetByName = new Map(getPresetAgentTemplates().map((p) => [p.name.toLowerCase(), p]));
    if (agent.templateName) {
      const preset = presetByName.get(agent.templateName.toLowerCase());
      if (!preset) {
        return {
          ok: false,
          error: `Preset template "${agent.templateName}" not found. It may have been removed from the code.`,
        };
      }
      return { ok: true, preset, canonicalName: preset.name, reattached: false };
    }
    const preset = presetByName.get(agent.name.trim().toLowerCase());
    if (!preset) {
      return {
        ok: false,
        error: `Agent "${agent.name}" is not linked to a preset template and cannot be synced.`,
      };
    }
    return { ok: true, preset, canonicalName: preset.name, reattached: true };
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

  private async validateModel(model: string, provider?: string | null): Promise<string | null> {
    const available = getAvailableModels('global');
    if (available.length === 0) return null;

    if (provider) {
      const valid = await isValidModel(model, 'global', provider);
      return valid ? null : `Unrecognized model "${model}" for provider "${provider}"`;
    }

    const info = await getModelInfoUnfiltered(model, 'global');
    return info ? null : `Unrecognized model: "${model}"`;
  }
}

function validateTools(tools: string[]): string | null {
  const invalid = tools.filter((t) => !isKnownToolEntry(t));
  if (invalid.length === 0) return null;
  return `Unknown tool${invalid.length > 1 ? 's' : ''}: ${invalid.map((t) => `"${t}"`).join(', ')}. Valid tools: ${KNOWN_TOOLS.join(', ')} or scoped Bash entries like 'Bash(gh pr view:*)'`;
}

function toolSetsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  for (const tool of b) {
    if (!setA.has(tool)) return false;
  }
  return true;
}
