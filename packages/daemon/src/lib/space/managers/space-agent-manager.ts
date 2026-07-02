/**
 * Space Agent Manager
 *
 * Business logic for creating, updating, and deleting Space agents.
 * Enforces:
 *   - Name uniqueness within a Space (DB-level check via LOWER())
 *   - Model must be recognized; when a provider is also given, validation is
 *     scoped to that provider via the provider-aware isValidModel() API
 *   - Tool names must be from KNOWN_TOOLS (validated on create and non-null update)
 *   - Deletion blocked when agent is referenced by workflow nodes
 */

import type {
  SpaceWorkerAgent,
  CreateSpaceWorkerAgentParams,
  UpdateSpaceWorkerAgentParams,
  SpaceWorkerAgentDriftEntry,
  SpaceWorkerAgentDriftReport,
} from '@hyperneo/shared';
import { KNOWN_TOOLS } from '@hyperneo/shared';
import type { SpaceAgentRepository } from '../../../storage/repositories/space-agent-repository';

type LongHorizonAgentHandleSource = {
  listBySpaceId(spaceId: string): Array<{ id: string; handle: string }>;
};
import { RESERVED_SPACE_AGENT_HANDLES, slugifyWithinLimit, validateSlug } from '../slug';
import { isValidModel, getAvailableModels, getModelInfoUnfiltered } from '../../model-service';
import { Logger } from '../../logger';
import { getPresetAgentTemplates } from '../agents/seed-agents';
import { computeAgentTemplateHash } from '../agents/agent-template-hash';

const log = new Logger('space-agent-manager');

const KNOWN_TOOLS_SET = new Set<string>(KNOWN_TOOLS);
const RESERVED_AGENT_HANDLES = new Set<string>(RESERVED_SPACE_AGENT_HANDLES);

export type SpaceAgentResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; details?: string[] };

export class SpaceAgentManager {
  constructor(
    private repo: SpaceAgentRepository,
    private longHorizonAgentHandles?: LongHorizonAgentHandleSource
  ) {}

  /**
   * Create a new agent within a Space.
   */
  async create(params: CreateSpaceWorkerAgentParams): Promise<SpaceAgentResult<SpaceWorkerAgent>> {
    // Validate name uniqueness (DB-level, case-insensitive)
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

    // Validate tool names against KNOWN_TOOLS
    if (params.tools) {
      const toolError = validateTools(params.tools);
      if (toolError) return { ok: false, error: toolError };
    }

    // Validate model (provider-aware when provider is supplied)
    if (params.model) {
      const modelError = await this.validateModel(params.model, params.provider);
      if (modelError) return { ok: false, error: modelError };
    }

    const agent = this.repo.create(params);
    return { ok: true, value: agent };
  }

  /**
   * Update an existing agent.
   */
  async update(
    id: string,
    params: UpdateSpaceWorkerAgentParams
  ): Promise<SpaceAgentResult<SpaceWorkerAgent>> {
    const existing = this.repo.getById(id);
    if (!existing) return { ok: false, error: `Agent not found: ${id}` };

    // Validate name uniqueness if name is being changed
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

    // Validate tool names against KNOWN_TOOLS (only when setting to a non-null value;
    // null means clearing the override which is always valid)
    if (params.tools) {
      const toolError = validateTools(params.tools);
      if (toolError) return { ok: false, error: toolError };
    }

    // Validate model if being set to a non-null value.
    // Provider resolution:
    //   - params.provider is a string  → use that provider (scoped validation)
    //   - params.provider is null       → caller is clearing the provider; validate unfiltered
    //   - params.provider is undefined  → not being changed; use existing agent's provider
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

  /**
   * Delete an agent, unless it is referenced by workflow nodes.
   */
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

  /**
   * Get a single agent by ID.
   */
  getById(id: string): SpaceWorkerAgent | null {
    return this.repo.getById(id);
  }

  /**
   * List all agents for a space.
   */
  listBySpaceId(spaceId: string): SpaceWorkerAgent[] {
    return this.repo.getBySpaceId(spaceId);
  }

  /**
   * Batch-fetch agents by IDs.
   */
  getAgentsByIds(ids: string[]): SpaceWorkerAgent[] {
    return this.repo.getAgentsByIds(ids);
  }

  /**
   * Build a drift report for every preset-tracked agent in a space.
   *
   * For each `SpaceWorkerAgent` row that has a non-null `templateName`, this
   * recomputes the current preset's hash from `getPresetAgentTemplates()`
   * and compares it to the stored `templateHash`. Rows whose `templateName`
   * doesn't match any current preset (e.g. a preset was deleted in code) are
   * silently skipped — there's nothing to sync against.
   *
   * User-created agents (`templateName === null`) are NOT included in the
   * report at all; the UI relies on this to decide which cards get a badge.
   */
  getAgentDriftReport(spaceId: string): SpaceWorkerAgentDriftReport {
    const agents = this.repo.getBySpaceId(spaceId);
    const presetByName = new Map(getPresetAgentTemplates().map((p) => [p.name.toLowerCase(), p]));

    const entries: SpaceWorkerAgentDriftEntry[] = [];
    for (const agent of agents) {
      if (!agent.templateName) continue;
      const preset = presetByName.get(agent.templateName.toLowerCase());
      if (!preset) continue;

      const currentHash = computeAgentTemplateHash(preset);
      const storedHash = agent.templateHash ?? null;
      const drifted = storedHash !== currentHash;
      entries.push({
        agentId: agent.id,
        agentName: agent.name,
        templateName: agent.templateName,
        storedHash,
        currentHash,
        drifted,
      });
    }

    return { spaceId, agents: entries };
  }

  /**
   * Reset a preset-tracked agent's `description`, `tools`, and
   * `customPrompt` to the current preset definition, then re-stamp the
   * stored `templateHash`. Throws when the agent is not preset-tracked or
   * when the preset can no longer be found in code.
   *
   * The agent's `id`, `spaceId`, `name`, `model`, and `provider` are
   * preserved — only the fields that participate in the fingerprint are
   * overwritten.
   */
  async syncFromTemplate(agentId: string): Promise<SpaceAgentResult<SpaceWorkerAgent>> {
    const existing = this.repo.getById(agentId);
    if (!existing) return { ok: false, error: `Agent not found: ${agentId}` };
    if (!existing.templateName) {
      return {
        ok: false,
        error: `Agent "${existing.name}" is not linked to a preset template and cannot be synced.`,
      };
    }

    const presetByName = new Map(getPresetAgentTemplates().map((p) => [p.name.toLowerCase(), p]));
    const preset = presetByName.get(existing.templateName.toLowerCase());
    if (!preset) {
      return {
        ok: false,
        error: `Preset template "${existing.templateName}" not found. It may have been removed from the code.`,
      };
    }

    const templateHash = computeAgentTemplateHash(preset);
    log.info('Syncing space agent from preset template', {
      agentId,
      spaceId: existing.spaceId,
      agentName: existing.name,
      templateName: existing.templateName,
      previousTemplateHash: existing.templateHash,
      templateHash,
      source: 'user_sync_from_template',
    });

    const updated = this.repo.update(agentId, {
      description: preset.description,
      tools: preset.tools,
      customPrompt: preset.customPrompt,
      templateHash,
    });
    if (!updated) return { ok: false, error: `Agent not found after sync: ${agentId}` };
    return { ok: true, value: updated };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

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

  /**
   * Validate that a model is recognized.
   * Skips validation entirely when the models cache is empty (not yet loaded).
   * When a provider is known, uses the provider-aware isValidModel() API so
   * that e.g. a GLM model cannot be validated as an Anthropic model.
   * Falls back to getModelInfoUnfiltered() when no provider is given — this
   * path includes legacy model ID mappings (e.g. 'claude-3-5-sonnet-20241022'
   * → 'sonnet') consistent with how the rest of the codebase resolves models.
   */
  private async validateModel(model: string, provider?: string | null): Promise<string | null> {
    // Skip all validation if the models cache is not yet populated
    const available = getAvailableModels('global');
    if (available.length === 0) return null;

    if (provider) {
      // Provider-aware async validation
      const valid = await isValidModel(model, 'global', provider);
      return valid ? null : `Unrecognized model "${model}" for provider "${provider}"`;
    }

    // No provider — unfiltered async check that includes legacy model ID mappings
    const info = await getModelInfoUnfiltered(model, 'global');
    return info ? null : `Unrecognized model: "${model}"`;
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/**
 * Validate that all tool names in the array are in KNOWN_TOOLS.
 * Returns a descriptive error string on failure, or null if all names are valid.
 */
function validateTools(tools: string[]): string | null {
  const invalid = tools.filter((t) => !KNOWN_TOOLS_SET.has(t));
  if (invalid.length === 0) return null;
  return `Unknown tool${invalid.length > 1 ? 's' : ''}: ${invalid.map((t) => `"${t}"`).join(', ')}. Valid tools: ${KNOWN_TOOLS.join(', ')}`;
}
