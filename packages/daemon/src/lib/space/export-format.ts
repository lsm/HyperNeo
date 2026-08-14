/**
 * Space Export/Import Format
 *
 * Functions for serializing SpaceWorkerAgent and SpaceWorkflow instances to a
 * portable JSON format and validating imported data with Zod schemas.
 *
 * Key remappings performed during export:
 * - Node `id` fields are stripped (regenerated on import)
 * - Node `agentId` UUID → agent name (`agentRef`) — portable across Spaces
 * - Channel `id` stripped; `from`/`to` node/agent UUIDs → names
 * - `startNodeId` UUID → node name (`startNode`)
 * - Rule `appliesTo` node UUIDs → node names (stable across re-import)
 *
 * Version policy:
 * - Accept: version 1, 2, or 3 (v2 adds optional `topicFrom` on eventInterests;
 *   v3 adds node handoff transitions and workflow gates). Older clients reject
 *   newer bundles via the version path rather than as schema-malformed.
 * - Reject with "requires newer version": version > CURRENT_EXPORT_VERSION
 * - Reject as invalid: version missing, null, < 1, or non-integer
 */

import { z } from 'zod';
import { validateGlobPattern } from '../external-events/topic-validator';
import { MAX_NODE_HANDOFF_TRANSITIONS } from '@hyperneo/shared';
import { BUILT_IN_HOOKS } from '@hyperneo/extensions-hooks';
import { CORRUPT_HOOK_BINDINGS_HOOK_ID, RESERVED_HOOK_IDS } from './hook-reserved-ids';

const BUILT_IN_HOOK_IDS = new Set(BUILT_IN_HOOKS.map((h) => h.id));
import type {
  SpaceWorkerAgent,
  SpaceWorkflow,
  ExportedSpaceWorkerAgent,
  ExportedSpaceWorkflow,
  ExportedWorkflowChannel,
  ExportedWorkflowNode,
  ExportedWorkflowNodeAgent,
  ExportedHandoffTransition,
  SpaceExportBundle,
} from '@hyperneo/shared';
import { validateSlug } from './slug';
import { MAX_CUSTOM_HOOK_TIMEOUT_MS, MAX_SCRIPT_BYTES } from './workflow-hook-validation';

// ============================================================================
// Zod schemas
// ============================================================================

const _workflowConditionSchema = z
  .object({
    type: z.enum(['always', 'human', 'condition', 'task_result']),
    expression: z.string().optional(),
    description: z.string().optional(),
    maxRetries: z.number().int().nonnegative().optional(),
    timeoutMs: z.number().int().nonnegative().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.type === 'condition' && (!val.expression || !val.expression.trim())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "'condition' type requires a non-empty expression",
        path: ['expression'],
      });
    }
    if (val.type === 'task_result' && (!val.expression || !val.expression.trim())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "'task_result' type requires a non-empty expression (match value)",
        path: ['expression'],
      });
    }
  });

const workflowNodeAgentOverrideSchema = z.object({
  value: z.string(),
});

/**
 * Union schema accepting both legacy plain-string overrides and new `{ value }` objects.
 * Legacy exports stored systemPrompt/instructions as plain strings; the new format uses
 * `WorkflowNodeAgentOverride { value }`. Both are accepted on import for backward
 * compatibility — plain strings are normalized to `{ value }` during import.
 */
const overrideOrStringSchema = z.union([workflowNodeAgentOverrideSchema, z.string().min(1)]);

const declarativeToolGuardSchema = z.object({
  matcher: z.string().min(1),
  pattern: z.string().min(1),
  decision: z.literal('deny'),
  reason: z.string().min(1),
});

export const MAX_AGENT_SLOT_EVENT_INTERESTS = 10;

const eventInterestTopicFromSchema = z.object({
  source: z.literal('primaryLink'),
  // `.trim().min(1)` mirrors the manager validator (whitespace-only is not a
  // usable pattern); a bare `.min(1)` would let whitespace slip through import
  // only to fail later at createWorkflow.
  pattern: z.string().trim().min(1),
});

const eventInterestSchema = z
  .object({
    topic: z
      .string()
      .min(1)
      .refine((topic) => validateGlobPattern(topic).valid, {
        message: 'topic must be a valid external-event glob pattern',
      })
      .optional(),
    /**
     * Dynamic topic template. Exactly one of `topic` / `topicFrom` is required —
     * enforced by the refine below. The `pattern` carries placeholders resolved
     * at subscription time (see `resolveTopicFromInterest`), so it is NOT
     * validated as a glob here.
     */
    topicFrom: eventInterestTopicFromSchema.optional(),
    label: z.string().optional(),
  })
  .refine((data) => (data.topic !== undefined) !== (data.topicFrom !== undefined), {
    message: 'exactly one of "topic" or "topicFrom" must be set',
  });

const thinkingLevelSchema = z.preprocess(
  (val) => (val === 'auto' ? 'off' : val),
  z.enum(['off', 'think8k', 'think16k', 'think24k', 'think32k'])
);

const exportedWorkflowNodeAgentSchema = z.object({
  agentRef: z.string().min(1),
  name: z.string().min(1),
  model: z.string().min(1).optional(),
  thinkingLevel: thinkingLevelSchema.optional(),
  systemPrompt: overrideOrStringSchema.optional(),
  replaceAgentPrompt: z.boolean().optional(),
  instructions: overrideOrStringSchema.optional(),
  /** IDs of globally-enabled skills disabled for this slot. */
  disabledSkillIds: z.array(z.string()).optional(),
  /**
   * Extra MCP servers for this slot.
   * Validated as a loose record to stay forward-compatible with SDK McpServerConfig shape changes.
   */
  extraMcpServers: z.record(z.string(), z.unknown()).optional(),
  /** Optional per-slot agent timeout in milliseconds. Positive integer. */
  timeoutMs: z.number().int().positive().optional(),
  /** Declarative tool guards (e.g. deny `gh pr merge` for coder agents). */
  toolGuards: z.array(declarativeToolGuardSchema).optional(),
  /** Static external-event subscription interests for this slot. */
  eventInterests: z.array(eventInterestSchema).max(MAX_AGENT_SLOT_EVENT_INTERESTS).optional(),
  /** Per-slot fresh-context flag (clear model context each handoff). */
  resetContextPerTurn: z.boolean().optional(),
});

/**
 * Zod schema for an exported workflow channel.
 * Differs from the runtime WorkflowChannel schema: `id` is intentionally absent
 * since channel IDs are space-specific and stripped during export.
 */
const exportedWorkflowChannelSchema = z.object({
  from: z.string().min(1),
  to: z.union([z.string().min(1), z.array(z.string().min(1))]),
  maxCycles: z.number().int().positive().optional(),
  label: z.string().optional(),
});

const hookDataFieldSchema = z.object({
  // Non-whitespace (runtime rule) — rejected, not silently trimmed.
  key: z.string().refine((value) => value.trim().length > 0, {
    message: 'must not be whitespace-only',
  }),
  type: z.enum(['string', 'number', 'boolean', 'link']),
  required: z.boolean(),
  description: z.string().optional(),
});

const hookAuthorizedCallerSchema = z.object({
  sourceNode: z.string().min(1),
  // Non-empty when present (runtime validateCaller rejects an empty list as
  // malformed rather than treating it as whole-node authorization).
  agentSlots: z.array(z.string().min(1)).min(1).optional(),
});

const hookMethodSchema = z.enum([
  'send_message',
  'save_artifact',
  'create_standalone_task',
  'mark_complete',
  'submit_for_approval',
  'approve_task',
]);

/** Zod schema for an exported v2 hook binding (Layer-2 placement). */
const hookBindingSchema = z.object({
  hookId: z.string().min(1),
  sourceNode: z.string().min(1),
  // Optional for non-routed methods (mark_complete, save_artifact, …).
  targetNode: z.string().min(1).optional(),
  method: hookMethodSchema,
  order: z.number().optional(),
  enabled: z.boolean(),
  authorizedCallers: z.array(hookAuthorizedCallerSchema).optional(),
});

/** Zod schema for an exported v2 custom (script) hook (Layer-1 definition). */
const customHookSchema = z.object({
  // Non-whitespace (runtime rule) — rejected here, not silently trimmed, so
  // references stay byte-exact.
  id: z.string().refine((value) => value.trim().length > 0, {
    message: 'must not be whitespace-only',
  }),
  requiredData: z.array(hookDataFieldSchema),
  run: z.object({
    kind: z.literal('script'),
    interpreter: z.literal('bash'),
    source: z.string().min(1),
    // Mirror runtime validation (not `.int()`): a fractional positive timeout
    // passes workflow create/update, and an export must round-trip through
    // this schema without rejection.
    timeoutMs: z.number().positive().max(MAX_CUSTOM_HOOK_TIMEOUT_MS).optional(),
  }),
});

/**
 * Zod schema for an exported workflow handoff transition.
 * Mirrors the runtime `HandoffTransition` shape.
 *
 * `target`/`hookId` are REFERENCES to other entities (node/slot names, hook
 * ids). They are validated non-mutating (reject whitespace-only via refine, but
 * preserve the exact value) so they match the referenced entity's id verbatim —
 * a `.trim()` here would desynchronize a reference from a whitespace-carrying
 * hook id that the manager persisted and accepted. String length caps bound
 * unbounded import input.
 */
const nonEmptyRef = (maxLen: number) =>
  z
    .string()
    .max(maxLen)
    .refine((v) => v.trim().length > 0, { message: 'must be a non-empty string' });

const exportedHandoffTransitionSchema = z.object({
  id: nonEmptyRef(100),
  label: z.string().max(200).optional(),
  target: nonEmptyRef(100),
  hookId: nonEmptyRef(100).optional(),
  maxCycles: z.number().int().positive().optional(),
});

const exportedWorkflowNodeSchema = z.object({
  agents: z.array(exportedWorkflowNodeAgentSchema).min(1),
  name: z.string().min(1),
  postApproval: z
    .object({
      targetAgent: z.string().min(1),
      instructions: z.string(),
      requirePrMerge: z.boolean().optional(),
    })
    .optional(),
  /** Declared outbound handoff transitions (first-class handoff contract). */
  transitions: z
    .array(exportedHandoffTransitionSchema)
    .max(MAX_NODE_HANDOFF_TRANSITIONS)
    .optional(),
});

/**
 * Export format versions this client can read and write.
 *
 * - v1: original format.
 * - v2: adds optional `topicFrom` on `eventInterests` (a dynamic alternative to
 *   a static `topic`). v2 is the first version that may emit topicFrom-only
 *   interests; v1-only clients reject v2 bundles with "requires newer version"
 *   instead of a confusing schema-malformed error.
 * - v3: adds node handoff `transitions` and workflow `gates` to the portable
 *   schema. v3 is the first version that may emit them; a v2-only client's Zod
 *   node schema would silently strip the unknown `transitions` field (and the
 *   `gates` workflow field), so a v1/v2 bundle carrying either is rejected via
 *   the version path rather than imported lossily.
 */
export const CURRENT_EXPORT_VERSION = 4 as const;
const SUPPORTED_EXPORT_VERSIONS: ReadonlySet<number> = new Set<number>([1, 2, 3, 4]);
export type ExportVersion = 1 | 2 | 3 | 4;

/**
 * Coerce an already-`checkVersion`-validated value to the supported version
 * union. Precondition: `checkVersion(version)` returned null.
 */
function asSupportedVersion(version: unknown): ExportVersion {
  return version as ExportVersion;
}

function asSupportedVersionOrUndefined(version: unknown): ExportVersion | undefined {
  if (typeof version === 'number' && SUPPORTED_EXPORT_VERSIONS.has(version)) {
    return version as ExportVersion;
  }
  return undefined;
}

/**
 * Reject a workflow export that carries a legacy `hooks` array — at ANY
 * declared version. The v4 schema does not declare the field, so accepting it
 * (a v3 export, or a version-bumped/mixed-exporter file) would silently strip
 * it and import the workflow with no hook enforcement (the hard-cut: old hook
 * definitions are not migrated). Surface an actionable error instead of a
 * lossy import.
 */
function rejectLegacyV3Hooks(
  data: unknown,
  version: ExportVersion | undefined,
  label: string
): string | null {
  if (version === undefined) return null;
  const raw = data as Record<string, unknown> | null;
  // Field PRESENCE (even an empty array) marks a hooks-era export; reject it
  // rather than silently stripping the field.
  const hooks = raw?.hooks;
  if (Array.isArray(hooks)) {
    return (
      `${label}: legacy v${version} \`hooks\` are not importable (the v2 hook model uses ` +
      `\`hookBindings\`/\`customHooks\`, and old hook definitions are not migrated). ` +
      `Re-export from a v4 daemon, or re-create the hooks as v2 bindings.`
    );
  }
  return null;
}

/** Validates the version field; returns an error string or null. */
function checkVersion(version: unknown): string | null {
  if (version === null || version === undefined) return 'invalid: version is required';
  if (typeof version !== 'number') return 'invalid: version must be a number';
  if (!Number.isInteger(version) || version < 1)
    return 'invalid: version must be a positive integer';
  if (!SUPPORTED_EXPORT_VERSIONS.has(version))
    return `requires newer version: this client supports up to version ${CURRENT_EXPORT_VERSION} but received version ${version}`;
  return null;
}

const exportedAgentBaseSchema = z.object({
  type: z.literal('agent'),
  name: z.string().min(1),
  handle: z
    .string()
    .optional()
    .refine((v) => v === undefined || validateSlug(v) === null, {
      message:
        'handle must contain only lowercase letters, numbers, and hyphens, and must start and end with a letter or number',
    }),
  description: z.string().optional(),
  model: z.string().optional(),
  thinkingLevel: thinkingLevelSchema.optional(),
  provider: z.string().optional(),
  systemPrompt: z.string().optional(),
  instructions: z.string().optional(),
  tools: z.array(z.string()).optional(),
  settingSources: z.array(z.enum(['user', 'project', 'local'])).optional(),
});

const exportedWorkflowBaseSchema = z.object({
  type: z.literal('workflow'),
  name: z.string().min(1),
  description: z.string().optional(),
  nodes: z.array(exportedWorkflowNodeSchema),
  startNode: z.string().min(1),
  endNode: z.string().optional(),
  tags: z.array(z.string()),
  channels: z.array(exportedWorkflowChannelSchema).optional(),
  hookBindings: z.array(hookBindingSchema).optional(),
  customHooks: z.array(customHookSchema).optional(),
  // Optional in schema for backward compatibility with v1 exports that predate
  // the completionAutonomyLevel field. Import code falls back to a sensible
  // default when the field is absent.
  completionAutonomyLevel: z.number().int().min(1).max(5).optional(),
  // Optional for backward compatibility with v1 exports that predate the
  // disabled field. When absent the workflow is treated as enabled.
  disabled: z.boolean().optional(),
  // Optional for backward compatibility with v1 exports that predate the
  // handle field. When absent, import regenerates the handle from the name.
  handle: z
    .string()
    .optional()
    .refine((v) => v === undefined || validateSlug(v) === null, {
      message:
        'handle must contain only lowercase letters, numbers, and hyphens, and must start and end with a letter or number',
    }),
});

const exportBundleBaseSchema = z.object({
  type: z.literal('bundle'),
  name: z.string().min(1),
  description: z.string().optional(),
  agents: z.array(exportedAgentBaseSchema),
  workflows: z.array(exportedWorkflowBaseSchema),
  exportedAt: z.number().int().positive(),
  exportedFrom: z.string().optional(),
});

// ============================================================================
// Validation result type
// ============================================================================

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

// ============================================================================
// Normalization helpers
// ============================================================================

/**
 * Normalize a legacy override value from the exported format.
 *
 * The Zod schema accepts both plain strings (legacy) and `{ value }` objects (new).
 * This helper converts the union to the canonical `WorkflowNodeAgentOverride` format:
 * - Plain string → `{ value: <string> }`
 * - `{ value }` object → passed through as-is
 * - `undefined` → `undefined`
 */
export function normalizeOverride(
  value: import('@hyperneo/shared').WorkflowNodeAgentOverride | string | undefined
): import('@hyperneo/shared').WorkflowNodeAgentOverride | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return { value };
  return value;
}

// ============================================================================
// Export functions
// ============================================================================

/**
 * Convert a SpaceWorkerAgent to the portable export format.
 * Strips `id`, `spaceId`, `createdAt`, `updatedAt`.
 */
export function exportAgent(agent: SpaceWorkerAgent): ExportedSpaceWorkerAgent {
  const exported: ExportedSpaceWorkerAgent = {
    version: CURRENT_EXPORT_VERSION,
    type: 'agent',
    name: agent.name,
  };
  if (agent.handle !== undefined) exported.handle = agent.handle;
  if (agent.description !== undefined) exported.description = agent.description;
  if (agent.model !== undefined) exported.model = agent.model;
  if (agent.thinkingLevel !== undefined) exported.thinkingLevel = agent.thinkingLevel;
  if (agent.provider !== undefined) exported.provider = agent.provider;
  if (agent.customPrompt !== null && agent.customPrompt !== undefined)
    exported.systemPrompt = agent.customPrompt;
  if (agent.tools !== undefined) exported.tools = agent.tools;
  if (agent.settingSources !== undefined) exported.settingSources = agent.settingSources;
  return exported;
}

/**
 * Convert a SpaceWorkflow to the portable export format.
 *
 * Remappings:
 * 1. Node `id` fields are stripped; node `agentId` UUID → agent name (`agentRef`).
 *    Falls back to the UUID string when no matching agent is found in `agents`.
 * 2. Channel `id` stripped; `from`/`to` node/agent UUIDs → names.
 *    Falls back to the UUID string when no matching node is found.
 * 3. `startNodeId` UUID → node name (`startNode`).
 * 4. Rule `appliesTo` node UUIDs → node names (stable cross-references on re-import).
 *    If a UUID has no matching node (stale data), it is silently dropped from
 *    `appliesTo`. If all UUIDs are stale the field is omitted, treating the rule
 *    as global (applies to all nodes) rather than discarding it entirely.
 */
export function exportWorkflow(
  workflow: SpaceWorkflow,
  agents: SpaceWorkerAgent[]
): ExportedSpaceWorkflow {
  // Deferred-upgrade guard: while migration 197 and the built-in restamp
  // defer (active runs / approved post-approval work), the repository can
  // still surface a head carrying legacy `hooks` with no v2 `hookBindings`.
  // Exporting it would silently emit a valid v4 workflow with NEITHER — the
  // import-side legacy guard cannot detect the loss (v4 carries no `hooks`
  // field), and importing the bundle would recreate an ungated workflow.
  // Refuse, mirroring the incoming-legacy-bundle guidance.
  const legacyHooks = (workflow as { hooks?: unknown[] }).hooks;
  if (
    Array.isArray(legacyHooks) &&
    legacyHooks.length > 0 &&
    !(workflow.hookBindings && workflow.hookBindings.length > 0)
  ) {
    throw new Error(
      `Workflow "${workflow.name}" still carries legacy v1 hooks that have not been ` +
        'converted to v2 hook bindings (a deferred post-upgrade state — its runs may still ' +
        'be active). Exporting now would silently drop its gates. Let its runs finish and ' +
        'restart the daemon so the conversion completes, or re-create the hooks as v2 ' +
        'bindings, then re-export.'
    );
  }
  // Support both `nodes` (new) and `steps` (legacy, during migration) for backward compat
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nodes = workflow.nodes ?? (workflow as any).steps ?? [];
  // Build a map from node UUID → node name
  const nodeIdToName = new Map<string, string>();
  for (const node of nodes) {
    nodeIdToName.set(node.id, node.name);
  }

  // Build a map from agent UUID → agent name
  const agentIdToName = new Map<string, string>();
  for (const agent of agents) {
    agentIdToName.set(agent.id, agent.name);
  }

  // Export nodes — strip `id`, remap agentId UUIDs → agent names.
  // Channels are exported at the workflow level (not per-node).
  const exportedNodes: ExportedWorkflowNode[] = nodes.map((node) => {
    const exportedAgents: ExportedWorkflowNodeAgent[] = node.agents.map((a) => {
      const entry: ExportedWorkflowNodeAgent = {
        agentRef: agentIdToName.get(a.agentId) ?? a.agentId,
        name: a.name,
      };
      if (a.model !== undefined) entry.model = a.model;
      if (a.thinkingLevel !== undefined) entry.thinkingLevel = a.thinkingLevel;
      if (a.customPrompt !== undefined) entry.systemPrompt = a.customPrompt;
      if (a.replaceAgentPrompt !== undefined) entry.replaceAgentPrompt = a.replaceAgentPrompt;
      if (a.disabledSkillIds !== undefined) entry.disabledSkillIds = a.disabledSkillIds;
      if (a.extraMcpServers !== undefined) entry.extraMcpServers = a.extraMcpServers;
      if (a.timeoutMs !== undefined) entry.timeoutMs = a.timeoutMs;
      if (a.toolGuards !== undefined) entry.toolGuards = a.toolGuards;
      if (a.eventInterests !== undefined) entry.eventInterests = a.eventInterests;
      if (a.resetContextPerTurn !== undefined) entry.resetContextPerTurn = a.resetContextPerTurn;
      return entry;
    });

    const exported: ExportedWorkflowNode = {
      name: node.name,
      agents: exportedAgents,
    };
    if (node.postApproval !== undefined) exported.postApproval = node.postApproval;
    if (node.transitions && node.transitions.length > 0) {
      exported.transitions = node.transitions.map((t) => {
        const out: ExportedHandoffTransition = { id: t.id, target: t.target };
        if (t.label !== undefined) out.label = t.label;
        if (t.hookId !== undefined) out.hookId = t.hookId;
        if (t.maxCycles !== undefined) out.maxCycles = t.maxCycles;
        return out;
      });
    }

    return exported;
  });

  // Export startNodeId UUID → node name
  const startId = workflow.startNodeId;
  const startNode = nodeIdToName.get(startId) ?? startId;
  const endNode = workflow.endNodeId
    ? (nodeIdToName.get(workflow.endNodeId) ?? workflow.endNodeId)
    : undefined;

  const result: ExportedSpaceWorkflow = {
    version: CURRENT_EXPORT_VERSION,
    type: 'workflow',
    name: workflow.name,
    nodes: exportedNodes,
    startNode,
    tags: workflow.tags,
    completionAutonomyLevel: workflow.completionAutonomyLevel,
  };
  if (endNode !== undefined) result.endNode = endNode;
  if (workflow.description !== undefined) result.description = workflow.description;
  if (workflow.disabled) result.disabled = true;
  if (workflow.handle) result.handle = workflow.handle;
  // Export channels — strip `id` (space-specific) and convert to portable ExportedWorkflowChannel format
  if (workflow.channels && workflow.channels.length > 0) {
    const exportedChannels: ExportedWorkflowChannel[] = workflow.channels.map((ch) => {
      const exported: ExportedWorkflowChannel = {
        from: ch.from,
        to: ch.to,
      };
      if (ch.maxCycles !== undefined) exported.maxCycles = ch.maxCycles;
      if (ch.label !== undefined) exported.label = ch.label;
      return exported;
    });
    result.channels = exportedChannels;
  }
  // REFUSE the export when the synthetic corrupt-column marker is present
  // (mirroring the legacy-hook refusal above): the marker means the
  // workflow's persisted hook configuration could not be decoded — every
  // hookable action fails closed. Filtering it out and exporting would turn
  // that protected-but-corrupt workflow into a VALID hook-less bundle whose
  // import permanently loses both the original gates and the fail-closed
  // marker, running ungated.
  if (workflow.hookBindings?.some((b) => b.hookId === CORRUPT_HOOK_BINDINGS_HOOK_ID)) {
    throw new Error(
      `Workflow "${workflow.name}" has a corrupt persisted hook configuration ` +
        '(its hook_bindings/custom_hooks column could not be decoded — every hookable ' +
        'action currently fails closed). Exporting would silently drop its gates. ' +
        'Repair the workflow first: re-author its hook bindings in the editor (or clear ' +
        'them deliberately), then re-export.'
    );
  }
  if (workflow.hookBindings && workflow.hookBindings.length > 0) {
    result.hookBindings = workflow.hookBindings.map((binding) => ({ ...binding }));
  }
  if (workflow.customHooks && workflow.customHooks.length > 0) {
    result.customHooks = workflow.customHooks.map((hook) => ({ ...hook }));
  }
  return result;
}

/**
 * Create a SpaceExportBundle from a set of agents and workflows.
 */
export function exportBundle(
  agents: SpaceWorkerAgent[],
  workflows: SpaceWorkflow[],
  name: string,
  options?: { description?: string; exportedFrom?: string }
): SpaceExportBundle {
  const exportedAgents = agents.map(exportAgent);
  const exportedWorkflows = workflows.map((wf) => exportWorkflow(wf, agents));
  const bundle: SpaceExportBundle = {
    version: CURRENT_EXPORT_VERSION,
    type: 'bundle',
    name,
    agents: exportedAgents,
    workflows: exportedWorkflows,
    exportedAt: Date.now(),
  };
  if (options?.description !== undefined) bundle.description = options.description;
  if (options?.exportedFrom !== undefined) bundle.exportedFrom = options.exportedFrom;
  return bundle;
}

// ============================================================================
// Validation functions
// ============================================================================

/**
 * Validate an unknown value as an ExportedSpaceWorkerAgent.
 *
 * Version handling:
 * - version 1, 2, or 3 → accepted
 * - version > CURRENT_EXPORT_VERSION → error: "requires newer version: ..."
 * - version < 1 or missing/non-integer → error: "invalid: ..."
 */
export function validateExportedAgent(data: unknown): ValidationResult<ExportedSpaceWorkerAgent> {
  if (typeof data !== 'object' || data === null) {
    return { ok: false, error: 'invalid: expected an object' };
  }
  const versionError = checkVersion((data as Record<string, unknown>).version);
  if (versionError) return { ok: false, error: versionError };
  const version = asSupportedVersion((data as Record<string, unknown>).version);

  const result = exportedAgentBaseSchema.safeParse(data);
  if (!result.success) {
    return { ok: false, error: `invalid: ${result.error.issues.map((i) => i.message).join('; ')}` };
  }
  return { ok: true, value: { version, ...result.data } };
}

/**
 * Validate an unknown value as an ExportedSpaceWorkflow.
 *
 * Version handling: same as validateExportedAgent.
 */
export function validateExportedWorkflow(data: unknown): ValidationResult<ExportedSpaceWorkflow> {
  if (typeof data !== 'object' || data === null) {
    return { ok: false, error: 'invalid: expected an object' };
  }
  const versionError = checkVersion((data as Record<string, unknown>).version);
  if (versionError) return { ok: false, error: versionError };
  const version = asSupportedVersion((data as Record<string, unknown>).version);
  const legacyError = rejectLegacyV3Hooks(data, version, 'workflow');
  if (legacyError) return { ok: false, error: legacyError };
  // The opposite direction of the legacy-hooks rejection: hookBindings and
  // customHooks are version-4 fields. A pre-v4 export carrying either would
  // be silently stripped by an older client that accepts the file's version —
  // reject here so the mismatch surfaces at validation, not after a lossy
  // import (same policy as the transitions/topicFrom feature-version checks).
  if (version < 4) {
    const raw = data as Record<string, unknown>;
    if (Array.isArray(raw.hookBindings) || Array.isArray(raw.customHooks)) {
      return {
        ok: false,
        error:
          'workflow: hookBindings/customHooks require export version 4; this file declares an ' +
          'older version and its hook enforcement would be stripped on import. Re-export from ' +
          'a v4 daemon.',
      };
    }
  }

  const result = exportedWorkflowBaseSchema.safeParse(data);
  if (!result.success) {
    return { ok: false, error: `invalid: ${result.error.issues.map((i) => i.message).join('; ')}` };
  }

  // Referential integrity checks — enforce the cross-reference invariants that
  // the rest of the format depends on (node names as stable cross-reference keys).
  const nodeNameSet = new Set<string>();
  for (const node of result.data.nodes) {
    if (nodeNameSet.has(node.name)) {
      return { ok: false, error: `invalid: duplicate node name: "${node.name}"` };
    }
    nodeNameSet.add(node.name);
  }

  // startNode must reference a known node name (skip check when nodes is empty)
  if (result.data.nodes.length > 0 && !nodeNameSet.has(result.data.startNode)) {
    return {
      ok: false,
      error: `invalid: startNode "${result.data.startNode}" does not reference a known node name`,
    };
  }
  // endNode must reference a known node name when present (skip check when nodes is empty)
  if (
    result.data.endNode !== undefined &&
    result.data.nodes.length > 0 &&
    !nodeNameSet.has(result.data.endNode)
  ) {
    return {
      ok: false,
      error: `invalid: endNode "${result.data.endNode}" does not reference a known node name`,
    };
  }

  // Mirror the runtime binding validation (validateWorkflowHookBindings) so a
  // binding that createWorkflow would reject fails HERE — import preview and
  // bundle validation must not present an import as valid that then rolls
  // back: hookId resolves (built-in or declared custom), sourceNode and an
  // optional targetNode reference known node names (targetNode required for
  // send_message), and authorizedCallers is a non-empty list of known
  // node/slot callers.
  // Custom-hook collection rules (mirroring validateCustomHooks): duplicate
  // ids and built-in shadowing are rejected at createWorkflow time — catch
  // them here so preview does not advertise an import that rolls back.
  if (result.data.customHooks && result.data.customHooks.length > 0) {
    const seenCustomIds = new Set<string>();
    for (let ci = 0; ci < result.data.customHooks.length; ci++) {
      const custom = result.data.customHooks[ci];
      // Runtime source limits (mirroring validateCustomHooks): whitespace-only
      // sources and sources over the UTF-8 byte cap are rejected at
      // createWorkflow time — catch them at preview.
      if (!custom.run.source.trim()) {
        return {
          ok: false,
          error: `invalid: customHooks[${ci}].run.source must not be whitespace-only`,
        };
      }
      if (new TextEncoder().encode(custom.run.source).length > MAX_SCRIPT_BYTES) {
        return {
          ok: false,
          error: `invalid: customHooks[${ci}].run.source exceeds ${MAX_SCRIPT_BYTES} bytes`,
        };
      }
      if (BUILT_IN_HOOK_IDS.has(custom.id)) {
        return {
          ok: false,
          error: `invalid: customHooks[${ci}].id "${custom.id}" shadows a registered built-in hook`,
        };
      }
      if (RESERVED_HOOK_IDS.includes(custom.id as (typeof RESERVED_HOOK_IDS)[number])) {
        return {
          ok: false,
          error: `invalid: customHooks[${ci}].id "${custom.id}" is reserved`,
        };
      }
      if (seenCustomIds.has(custom.id)) {
        return {
          ok: false,
          error: `invalid: customHooks[${ci}].id "${custom.id}" is declared more than once`,
        };
      }
      seenCustomIds.add(custom.id);
    }
  }
  if (result.data.hookBindings && result.data.hookBindings.length > 0) {
    // Mirror the runtime rule: a hook id appears on at most ONE binding
    // (runtime state is keyed (runId, hookId) — duplicates share one row).
    const placedHookIds = new Set<string>();
    for (let bi = 0; bi < result.data.hookBindings.length; bi++) {
      const binding = result.data.hookBindings[bi];
      if (placedHookIds.has(binding.hookId)) {
        return {
          ok: false,
          error: `invalid: hookBindings[${bi}].hookId "${binding.hookId}" is already placed on another binding (hook state is shared per hook id)`,
        };
      }
      placedHookIds.add(binding.hookId);
    }
    const resolvableHookIds = new Set<string>(BUILT_IN_HOOK_IDS);
    for (const custom of result.data.customHooks ?? []) resolvableHookIds.add(custom.id);
    const slotsByNode = new Map<string, Set<string>>();
    for (const node of result.data.nodes) {
      slotsByNode.set(node.name, new Set((node.agents ?? []).map((a) => a.name)));
    }
    for (let bi = 0; bi < result.data.hookBindings.length; bi++) {
      const binding = result.data.hookBindings[bi];
      const loc = `hookBindings[${bi}]`;
      if (!resolvableHookIds.has(binding.hookId)) {
        return {
          ok: false,
          error: `invalid: ${loc}.hookId "${binding.hookId}" is neither a registered built-in hook nor declared in customHooks`,
        };
      }
      if (!nodeNameSet.has(binding.sourceNode)) {
        return {
          ok: false,
          error: `invalid: ${loc}.sourceNode "${binding.sourceNode}" does not reference a known node name`,
        };
      }
      if (binding.targetNode !== undefined) {
        // Mirror the runtime rule: targetNode is only meaningful on routed
        // (send_message) methods — elsewhere the binding would never match.
        if (binding.method !== 'send_message') {
          return {
            ok: false,
            error: `invalid: ${loc}.targetNode is not allowed for non-routed method ${binding.method}`,
          };
        }
        if (!nodeNameSet.has(binding.targetNode)) {
          return {
            ok: false,
            error: `invalid: ${loc}.targetNode "${binding.targetNode}" does not reference a known node name`,
          };
        }
      } else if (binding.method === 'send_message') {
        return {
          ok: false,
          error: `invalid: ${loc}.targetNode is required for send_message bindings`,
        };
      }
      if (!binding.authorizedCallers || binding.authorizedCallers.length === 0) {
        return {
          ok: false,
          error: `invalid: ${loc}.authorizedCallers is required and must be non-empty`,
        };
      }
      // Mirror the runtime rule: at least one caller must reference the
      // binding's own sourceNode, or the gate can never match.
      if (!binding.authorizedCallers.some((caller) => caller.sourceNode === binding.sourceNode)) {
        return {
          ok: false,
          error: `invalid: ${loc}.authorizedCallers must include a caller for the binding's own sourceNode "${binding.sourceNode}"`,
        };
      }
      for (let ci = 0; ci < binding.authorizedCallers.length; ci++) {
        const caller = binding.authorizedCallers[ci];
        if (!nodeNameSet.has(caller.sourceNode)) {
          return {
            ok: false,
            error: `invalid: ${loc}.authorizedCallers[${ci}].sourceNode "${caller.sourceNode}" does not reference a known node name`,
          };
        }
        const validSlots = slotsByNode.get(caller.sourceNode) ?? new Set<string>();
        const slots = caller.agentSlots ?? [];
        for (let si = 0; si < slots.length; si++) {
          const slot = slots[si];
          if (!validSlots.has(slot)) {
            return {
              ok: false,
              error: `invalid: ${loc}.authorizedCallers[${ci}].agentSlots[${si}] "${slot}" is not a slot of node "${caller.sourceNode}"`,
            };
          }
        }
      }
    }
  }

  // Channel from/to must reference known node names, agent slot names, or '*' wildcard.
  // Build valid name set: '*' + all node names + all agent slot names (agents[].name).
  // Single-agent nodes (agentRef shorthand) use the node name for fan-out targeting.
  if (result.data.channels && result.data.channels.length > 0) {
    const validChannelNames = new Set<string>(['*']);
    for (const node of result.data.nodes) {
      validChannelNames.add(node.name);
      if (node.agents) {
        for (const a of node.agents) {
          validChannelNames.add(a.name);
        }
      }
    }
    for (let ci = 0; ci < result.data.channels.length; ci++) {
      const ch = result.data.channels[ci];
      const loc = `channels[${ci}]`;
      if (!validChannelNames.has(ch.from)) {
        return {
          ok: false,
          error: `invalid: ${loc}.from "${ch.from}" does not reference a known agent slot name or node name`,
        };
      }
      const toList = Array.isArray(ch.to) ? ch.to : [ch.to];
      for (let ti = 0; ti < toList.length; ti++) {
        if (!validChannelNames.has(toList[ti])) {
          return {
            ok: false,
            error: `invalid: ${loc}.to[${ti}] "${toList[ti]}" does not reference a known agent slot name or node name`,
          };
        }
      }
    }
  }

  // Handoff transitions: each declared transition's `target` must reference a
  // known node/agent name or the '*' wildcard; transition ids and targets must
  // be unique within a node (so handoff({ target }) resolves unambiguously);
  // and `hookId` must reference a known hook — a bound hook id, a declared custom
  // hook id, OR a registered built-in id (a transition may reference a built-in
  // like `pr_merged` even when no route binding uses it; matches availableHookIds).
  const transitionHookIds = new Set<string>(BUILT_IN_HOOK_IDS);
  for (const binding of result.data.hookBindings ?? []) {
    if (binding?.hookId) transitionHookIds.add(binding.hookId);
  }
  for (const hook of result.data.customHooks ?? []) {
    if (hook?.id) transitionHookIds.add(hook.id);
  }
  // Build the destination map ONCE (not per source node) so validation stays
  // linear in the node count instead of quadratic — a crafted bundle with many
  // nodes must not make import validation O(N²).
  const targetDestinations = new Map<string, Set<string>>();
  const countDest = (name: string | undefined, key: string) => {
    if (!name) return;
    const set = targetDestinations.get(name) ?? new Set<string>();
    set.add(key);
    targetDestinations.set(name, set);
  };
  result.data.nodes.forEach((other, idx) => {
    countDest(other.name, `node:${idx}`);
    for (const a of other.agents ?? []) countDest(a.name, `slot:${idx}`);
  });

  for (let n = 0; n < result.data.nodes.length; n++) {
    const node = result.data.nodes[n];
    const transitions = node.transitions;
    if (!transitions || transitions.length === 0) continue;

    const seenIds = new Set<string>();
    const seenTargets = new Set<string>();
    for (let ti = 0; ti < transitions.length; ti++) {
      const t = transitions[ti];
      const loc = `nodes[${n}].transitions[${ti}]`;
      if (seenIds.has(t.id)) {
        return { ok: false, error: `invalid: ${loc}: duplicate transition id "${t.id}"` };
      }
      seenIds.add(t.id);
      if (t.target !== '*') {
        const dests = targetDestinations.get(t.target);
        if (!dests || dests.size === 0) {
          return {
            ok: false,
            error: `invalid: ${loc}.target "${t.target}" does not reference a known node name or agent slot name`,
          };
        }
        if (dests.size > 1) {
          return {
            ok: false,
            error: `invalid: ${loc}.target "${t.target}" is ambiguous — matches ${dests.size} destinations`,
          };
        }
      }
      if (seenTargets.has(t.target)) {
        return {
          ok: false,
          error: `invalid: ${loc}: duplicate transition target "${t.target}" within node "${node.name}"`,
        };
      }
      seenTargets.add(t.target);
      if (t.hookId !== undefined && !transitionHookIds.has(t.hookId)) {
        return {
          ok: false,
          error: `invalid: ${loc}.hookId "${t.hookId}" does not reference a known hook`,
        };
      }
    }
  }

  // Handoff transitions are a version-3 feature. A v1/v2 workflow must
  // not carry them, or the version compatibility gate is meaningless: a v2-only
  // client's Zod node schema would silently strip the unknown `transitions`
  // field, importing lossily. Reject via the version path instead.
  if (version < 3) {
    for (let n = 0; n < result.data.nodes.length; n++) {
      const transitions = result.data.nodes[n].transitions;
      if (transitions && transitions.length > 0) {
        return {
          ok: false,
          error:
            `invalid: nodes[${n}].transitions require version 3 ` +
            `(this workflow declares version ${version})`,
        };
      }
    }
  }

  // topicFrom is a version-2 feature. A version-1 workflow must not carry it,
  // or the version compatibility gate is meaningless: a v1-only client would
  // reject the bundle as malformed rather than via the version path.
  if (version === 1) {
    for (let n = 0; n < result.data.nodes.length; n++) {
      const agents = result.data.nodes[n].agents;
      for (let a = 0; a < agents.length; a++) {
        const interests = agents[a].eventInterests ?? [];
        for (let k = 0; k < interests.length; k++) {
          if ((interests[k] as { topicFrom?: unknown }).topicFrom !== undefined) {
            return {
              ok: false,
              error:
                `invalid: nodes[${n}].agents[${a}].eventInterests[${k}] uses topicFrom, ` +
                'which requires version 2 (this workflow declares version 1)',
            };
          }
        }
      }
    }
  }

  // Zod's `z.number().min(1).max(5)` widens to `number`; at runtime the schema
  // guarantees 1-5, so we assert to the nominal SpaceAutonomyLevel union.
  return {
    ok: true,
    value: { version, ...result.data } as ExportedSpaceWorkflow,
  };
}

/**
 * Validate an unknown value as a SpaceExportBundle.
 *
 * Version handling: same as validateExportedAgent.
 * Each embedded agent and workflow is validated individually via
 * `validateExportedAgent` / `validateExportedWorkflow` so that nested version
 * checks (e.g. a v2 agent inside a v1 bundle) are caught and reported.
 */
export function validateExportBundle(data: unknown): ValidationResult<SpaceExportBundle> {
  if (typeof data !== 'object' || data === null) {
    return { ok: false, error: 'invalid: expected an object' };
  }
  const versionError = checkVersion((data as Record<string, unknown>).version);
  if (versionError) return { ok: false, error: versionError };
  const version = asSupportedVersion((data as Record<string, unknown>).version);
  // Nested workflows may carry legacy v3 hooks even when the bundle root is v4
  // (a hand-assembled bundle) — reject those too instead of stripping them.
  const rawPeek = data as Record<string, unknown>;
  const nestedRawWorkflows = Array.isArray(rawPeek.workflows) ? rawPeek.workflows : [];
  for (let i = 0; i < nestedRawWorkflows.length; i++) {
    const wf = nestedRawWorkflows[i];
    const wfVersion =
      typeof wf === 'object' && wf !== null ? (wf as Record<string, unknown>).version : undefined;
    const legacyError = rejectLegacyV3Hooks(
      wf,
      asSupportedVersionOrUndefined(wfVersion),
      `workflows[${i}]`
    );
    if (legacyError) return { ok: false, error: legacyError };
  }

  const result = exportBundleBaseSchema.safeParse(data);
  if (!result.success) {
    return { ok: false, error: `invalid: ${result.error.issues.map((i) => i.message).join('; ')}` };
  }

  // Validate each nested agent and workflow using the full per-item validators
  // so that their individual version fields are also checked.
  const raw = data as Record<string, unknown>;
  const rawAgents = Array.isArray(raw.agents) ? raw.agents : [];
  for (let i = 0; i < rawAgents.length; i++) {
    const agentResult = validateExportedAgent(rawAgents[i]);
    if (!agentResult.ok) {
      return { ok: false, error: `agents[${i}]: ${agentResult.error}` };
    }
    // Nested items are re-stamped to the bundle's root version on output, so a
    // nested item claiming a newer (but still supported) version than the root
    // would silently downgrade — and smuggle a newer-only feature like topicFrom
    // into a v1 bundle. (Unsupported versions are already rejected above.)
    const nestedAgentVersion = (rawAgents[i] as Record<string, unknown>).version;
    if (typeof nestedAgentVersion === 'number' && nestedAgentVersion > version) {
      return {
        ok: false,
        error: `agents[${i}]: version ${nestedAgentVersion} exceeds bundle version ${version}`,
      };
    }
  }
  const rawWorkflows = Array.isArray(raw.workflows) ? raw.workflows : [];
  const bundleHandles = new Set<string>();
  for (let i = 0; i < rawWorkflows.length; i++) {
    const wfResult = validateExportedWorkflow(rawWorkflows[i]);
    if (!wfResult.ok) {
      return { ok: false, error: `workflows[${i}]: ${wfResult.error}` };
    }
    const nestedWfVersion = (rawWorkflows[i] as Record<string, unknown>).version;
    if (typeof nestedWfVersion === 'number' && nestedWfVersion > version) {
      return {
        ok: false,
        error: `workflows[${i}]: version ${nestedWfVersion} exceeds bundle version ${version}`,
      };
    }
    // Reject duplicate handles within the same bundle — silently rewriting the second
    // handle would make round-trip identity order-dependent.
    const wf = rawWorkflows[i] as Record<string, unknown>;
    if (typeof wf.handle === 'string' && wf.handle.trim()) {
      const h = wf.handle.trim();
      if (bundleHandles.has(h)) {
        return {
          ok: false,
          error: `workflows[${i}]: duplicate handle "${h}" in bundle`,
        };
      }
      bundleHandles.add(h);
    }
  }

  return {
    ok: true,
    value: {
      version,
      type: 'bundle',
      name: result.data.name,
      ...(result.data.description !== undefined ? { description: result.data.description } : {}),
      agents: result.data.agents.map((a) => ({ version, ...a })),
      // Zod widens `completionAutonomyLevel` to `number`; the schema enforces 1-5
      // at runtime, so casting to ExportedSpaceWorkflow is safe here.
      workflows: result.data.workflows.map((w) => ({ version, ...w }) as ExportedSpaceWorkflow),
      exportedAt: result.data.exportedAt,
      ...(result.data.exportedFrom !== undefined ? { exportedFrom: result.data.exportedFrom } : {}),
    },
  };
}
