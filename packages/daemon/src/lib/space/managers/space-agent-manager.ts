/**
 * Space Agent Manager
 *
 * Business logic for creating, updating, and deleting Space agents.
 * Enforces:
 *   - Name uniqueness within a Space (DB-level check via LOWER())
 *   - Model must be recognized; when a provider is also given, validation is
 *     scoped to that provider via the provider-aware isValidModel() API
 *   - Tool names must be from KNOWN_TOOLS (validated on create and non-null update)
 *   - Deletion blocked when agent is referenced by workflow nodes, or by an
 *     in-flight (non-archived) run pinned to a definition version that still
 *     references it (RFC §4 #5)
 */

import type {
  SpaceWorkerAgent,
  CreateSpaceWorkerAgentParams,
  UpdateSpaceWorkerAgentParams,
  SpaceWorkerAgentDriftEntry,
  SpaceWorkerAgentDriftReport,
  SpaceWorkerAgentSyncDiff,
  SpaceWorkerAgentSyncPreview,
} from '@hyperneo/shared';
import { KNOWN_TOOLS } from '@hyperneo/shared';
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
   * Delete an agent, unless it is referenced by the mutable head (workflow nodes)
   * or by an in-flight (non-archived) run pinned to a definition version that
   * still references it.
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

    // RFC §4 #5: the head no longer references this agent, but an in-flight run
    // may still be pinned to an older definition version that does. Deleting the
    // agent would strand that run — `resolveAgentInit` throws "Agent not found"
    // at spawn. Block (rather than strand) when any non-archived run is pinned to
    // a referencing version.
    const { referenced: pinnedReferenced, runIds } = this.repo.isReferencedByActivePinnedRun(id);
    if (pinnedReferenced) {
      return {
        ok: false,
        error:
          `Cannot delete agent "${existing.name}" - it is referenced by an in-flight run ` +
          `pinned to an older workflow version`,
        details: runIds.map((rid) => `Run: ${rid}`),
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
   * Two independent signals are derived, both measured against the stored
   * hash as the common reference:
   *   - `updateAvailable` — the template moved in code (currentHash !== storedHash).
   *     This is byte-identical to the former `drifted` flag.
   *   - `customized` — the row moved (rowHash !== storedHash), i.e. the user
   *     edited the fingerprint fields. Informational only.
   *
   * ORPHAN RECOVERY: a row that lost preset tracking (`templateName === null`)
   * but whose name matches a known preset is included as an `orphaned` entry,
   * so the UI can offer a re-attach. For these rows `storedHash` is null,
   * `updateAvailable` is always true (a re-attach is available), and
   * `customized` reflects whether the row's fields already diverge from the
   * current preset (forcing a diff review before the re-attach overwrites
   * anything). Genuinely user-created agents — no `templateName` AND a name
   * that matches no preset — are still excluded entirely.
   */
  getAgentDriftReport(spaceId: string): SpaceWorkerAgentDriftReport {
    const agents = this.repo.getBySpaceId(spaceId);
    const presetByName = new Map(getPresetAgentTemplates().map((p) => [p.name.toLowerCase(), p]));

    const entries: SpaceWorkerAgentDriftEntry[] = [];
    for (const agent of agents) {
      const preset = agent.templateName
        ? presetByName.get(agent.templateName.toLowerCase())
        : presetByName.get(agent.name.trim().toLowerCase());

      // Tracked row whose templateName no longer matches a live preset —
      // nothing to sync against. And an untracked row whose name matches no
      // preset is a genuinely user-created agent. Both are excluded.
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
        // No stored hash to compare against. A re-attach is always available;
        // `customized` flags rows whose fields already diverge from the preset
        // so the UI forces a diff review before overwriting them.
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

  /**
   * Reset a preset-tracked agent's `description`, `tools`, and
   * `customPrompt` to the current preset definition, then re-stamp the
   * stored `templateHash`. Throws when the agent is not preset-tracked or
   * when the preset can no longer be found in code.
   *
   * ORPHAN RE-ATTACH: an agent that lost preset tracking (`templateName` is
   * null) but whose name matches a known preset is re-attached — the preset is
   * resolved by name, its fields are written, and `templateName` is stamped
   * alongside the hash. Genuinely user-created agents (no `templateName` and a
   * name matching no preset) are still rejected.
   *
   * The agent's `id`, `spaceId`, `name`, `model`, and `provider` are
   * preserved — only the fields that participate in the fingerprint are
   * overwritten.
   *
   * `expectedRowHash` is an optional optimistic-concurrency guard: when a
   * caller reviewed a diff, it passes the row hash observed at review time, and
   * the sync is rejected if the row has changed since (e.g. another client
   * edited it), so unseen edits aren't silently overwritten.
   */
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

    // Optimistic-concurrency guard: reject if the row changed since the caller
    // reviewed its diff, so a concurrent edit isn't overwritten unseen.
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
      // Re-stamp the name on the re-attach path so the row participates in
      // drift detection going forward. Idempotent on already-tracked rows.
      ...(reattached ? { templateName: canonicalName } : {}),
      templateHash,
    });
    if (!updated) return { ok: false, error: `Agent not found after sync: ${agentId}` };
    return { ok: true, value: updated };
  }

  /**
   * Compute a per-field diff between a preset-tracked agent row and its live
   * preset definition, WITHOUT writing. The diff covers exactly the fields
   * that {@link syncFromTemplate} overwrites (`description`, `tools`,
   * `customPrompt`), so this preview is an exact predictor of the apply step.
   *
   * Returns the same errors as {@link syncFromTemplate}: agent not found, not
   * preset-tracked, or the named preset no longer exists in code.
   *
   * `updateAvailable` / `customized` use the same two-hash comparisons as
   * {@link getAgentDriftReport}. An empty `diff` with `updateAvailable === true`
   * is a valid state: it means the row's fields already match the preset but
   * the stored hash is stale or missing (e.g. a backfill-unmatched legacy row).
   */
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
        // For an orphaned (re-attached) row `storedHash` is null, so the
        // row-vs-stored comparison would be unconditionally true. Mirror
        // getAgentDriftReport's orphaned semantics instead: customized means
        // "the row already diverges from the current preset".
        customized: reattached ? rowHash !== liveHash : rowHash !== storedHash,
        diff,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Resolve the live preset definition for an agent row.
   *
   * - Tracked row (`templateName` set): look the preset up by `templateName`.
   *     A tracked row whose preset was removed from code yields a distinct
   *     "preset not found" error so the user knows it isn't a plain user agent.
   * - Orphaned row (`templateName` null): fall back to a case-insensitive name
   *     match against the live presets, enabling re-attach. `reattached` is true
   *     on this path so callers know to re-stamp `templateName`.
   *
   * Returns `{ ok: false, error }` when neither lookup resolves — a tracked row
   * whose preset was removed, or a genuinely user-created agent (each with its
   * own message).
   */
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

/**
 * Order-independent equality for two tool lists. Tool profiles are a visible
 * override set, so `['Read', 'Bash']` and `['Bash', 'Read']` are the same
 * profile — the diff should not report a change for a reordering.
 */
function toolSetsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  for (const tool of b) {
    if (!setA.has(tool)) return false;
  }
  return true;
}
