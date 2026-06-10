/**
 * Space Export/Import Format
 *
 * Functions for serializing SpaceAgent and SpaceWorkflow instances to a
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
 * - Accept: version === 1
 * - Reject with "requires newer version": version > 1 (or version >= 2)
 * - Reject as invalid: version missing, null, < 1, or non-integer
 */

import { z } from 'zod';
import { validateGlobPattern } from '../external-events/topic-validator';
import type {
  SpaceAgent,
  SpaceWorkflow,
  ExportedSpaceAgent,
  ExportedSpaceWorkflow,
  ExportedWorkflowChannel,
  ExportedWorkflowNode,
  ExportedWorkflowNodeAgent,
  SpaceExportBundle,
} from '@neokai/shared';
import { validateSlug } from './slug';

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

const eventInterestSchema = z.object({
  topic: z
    .string()
    .min(1)
    .refine((topic) => validateGlobPattern(topic).valid, {
      message: 'topic must be a valid external-event glob pattern',
    }),
  label: z.string().optional(),
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
  gateId: z.string().optional(),
});

const workflowHookValidatorSchema = z.union([
  z.object({ kind: z.literal('built_in'), id: z.string().min(1) }),
  z.object({
    kind: z.literal('script'),
    interpreter: z.literal('bash'),
    source: z.string().min(1),
    timeoutMs: z.number().int().positive().optional(),
    externalLookups: z.array(z.literal('github')).optional(),
  }),
]);

const workflowHookSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean(),
  sourceNode: z.string().min(1),
  targetNode: z.string().min(1).optional(),
  method: z.enum([
    'send_message',
    'save_artifact',
    'create_standalone_task',
    'mark_complete',
    'submit_for_approval',
    'approve_task',
  ]),
  classification: z.enum(['validation', 'side_effect']).optional(),
  order: z.number().optional(),
  label: z.string().optional(),
  templateData: z.record(z.string(), z.unknown()).optional(),
  validator: workflowHookValidatorSchema,
  retry: z
    .object({
      maxAttempts: z.number().int().nonnegative(),
      delayMs: z.number().int().nonnegative(),
      backoffMultiplier: z.number().positive().optional(),
    })
    .optional(),
  poll: z
    .object({
      intervalMs: z.number().int().positive(),
      maxDurationMs: z.number().int().positive().optional(),
    })
    .optional(),
  localState: z
    .object({
      defaults: z.record(z.string(), z.unknown()).optional(),
      recentResultRef: z
        .object({
          hookId: z.string().min(1),
          key: z.string().min(1),
        })
        .optional(),
    })
    .optional(),
  authorizedCallers: z
    .array(
      z.object({
        sourceNode: z.string().min(1),
        agentSlots: z.array(z.string().min(1)).optional(),
      })
    )
    .optional(),
  humanOnly: z.boolean().optional(),
});

const exportedWorkflowNodeSchema = z.object({
  agents: z.array(exportedWorkflowNodeAgentSchema).min(1),
  name: z.string().min(1),
  postApproval: z
    .object({
      targetAgent: z.string().min(1),
      instructions: z.string(),
    })
    .optional(),
  requireCodexApproval: z.boolean().optional(),
  codexPollIntervalMs: z.number().int().positive().optional(),
});

/** Validates the version field; returns an error string or null. */
function checkVersion(version: unknown): string | null {
  if (version === null || version === undefined) return 'invalid: version is required';
  if (typeof version !== 'number') return 'invalid: version must be a number';
  if (!Number.isInteger(version) || version < 1)
    return 'invalid: version must be a positive integer';
  if (version > 1)
    return `requires newer version: this client supports version 1 but received version ${version}`;
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
  hooks: z.array(workflowHookSchema).optional(),
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
  value: import('@neokai/shared').WorkflowNodeAgentOverride | string | undefined
): import('@neokai/shared').WorkflowNodeAgentOverride | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return { value };
  return value;
}

// ============================================================================
// Export functions
// ============================================================================

/**
 * Convert a SpaceAgent to the portable export format.
 * Strips `id`, `spaceId`, `createdAt`, `updatedAt`.
 */
export function exportAgent(agent: SpaceAgent): ExportedSpaceAgent {
  const exported: ExportedSpaceAgent = {
    version: 1,
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
  agents: SpaceAgent[]
): ExportedSpaceWorkflow {
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
      if (a.disabledSkillIds !== undefined) entry.disabledSkillIds = a.disabledSkillIds;
      if (a.extraMcpServers !== undefined) entry.extraMcpServers = a.extraMcpServers;
      if (a.timeoutMs !== undefined) entry.timeoutMs = a.timeoutMs;
      if (a.toolGuards !== undefined) entry.toolGuards = a.toolGuards;
      if (a.eventInterests !== undefined) entry.eventInterests = a.eventInterests;
      return entry;
    });

    const exported: ExportedWorkflowNode = {
      name: node.name,
      agents: exportedAgents,
    };
    if (node.postApproval !== undefined) exported.postApproval = node.postApproval;
    if (node.requireCodexApproval !== undefined)
      exported.requireCodexApproval = node.requireCodexApproval;
    if (node.codexPollIntervalMs !== undefined)
      exported.codexPollIntervalMs = node.codexPollIntervalMs;

    return exported;
  });

  // Export startNodeId UUID → node name
  const startId = workflow.startNodeId;
  const startNode = nodeIdToName.get(startId) ?? startId;
  const endNode = workflow.endNodeId
    ? (nodeIdToName.get(workflow.endNodeId) ?? workflow.endNodeId)
    : undefined;

  const result: ExportedSpaceWorkflow = {
    version: 1,
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
      if (ch.gateId !== undefined) exported.gateId = ch.gateId;
      return exported;
    });
    result.channels = exportedChannels;
  }
  if (workflow.hooks && workflow.hooks.length > 0) {
    result.hooks = workflow.hooks;
  }
  return result;
}

/**
 * Create a SpaceExportBundle from a set of agents and workflows.
 */
export function exportBundle(
  agents: SpaceAgent[],
  workflows: SpaceWorkflow[],
  name: string,
  options?: { description?: string; exportedFrom?: string }
): SpaceExportBundle {
  const exportedAgents = agents.map(exportAgent);
  const exportedWorkflows = workflows.map((wf) => exportWorkflow(wf, agents));
  const bundle: SpaceExportBundle = {
    version: 1,
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
 * Validate an unknown value as an ExportedSpaceAgent.
 *
 * Version handling:
 * - version === 1 → accepted
 * - version > 1 → error: "requires newer version: ..."
 * - version < 1 or missing/non-integer → error: "invalid: ..."
 */
export function validateExportedAgent(data: unknown): ValidationResult<ExportedSpaceAgent> {
  if (typeof data !== 'object' || data === null) {
    return { ok: false, error: 'invalid: expected an object' };
  }
  const versionError = checkVersion((data as Record<string, unknown>).version);
  if (versionError) return { ok: false, error: versionError };

  const result = exportedAgentBaseSchema.safeParse(data);
  if (!result.success) {
    return { ok: false, error: `invalid: ${result.error.issues.map((i) => i.message).join('; ')}` };
  }
  return { ok: true, value: { version: 1, ...result.data } };
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

  // Zod's `z.number().min(1).max(5)` widens to `number`; at runtime the schema
  // guarantees 1-5, so we assert to the nominal SpaceAutonomyLevel union.
  return {
    ok: true,
    value: { version: 1, ...result.data } as ExportedSpaceWorkflow,
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
  }
  const rawWorkflows = Array.isArray(raw.workflows) ? raw.workflows : [];
  const bundleHandles = new Set<string>();
  for (let i = 0; i < rawWorkflows.length; i++) {
    const wfResult = validateExportedWorkflow(rawWorkflows[i]);
    if (!wfResult.ok) {
      return { ok: false, error: `workflows[${i}]: ${wfResult.error}` };
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
      version: 1,
      type: 'bundle',
      name: result.data.name,
      ...(result.data.description !== undefined ? { description: result.data.description } : {}),
      agents: result.data.agents.map((a) => ({ version: 1 as const, ...a })),
      // Zod widens `completionAutonomyLevel` to `number`; the schema enforces 1-5
      // at runtime, so casting to ExportedSpaceWorkflow is safe here.
      workflows: result.data.workflows.map(
        (w) => ({ version: 1 as const, ...w }) as ExportedSpaceWorkflow
      ),
      exportedAt: result.data.exportedAt,
      ...(result.data.exportedFrom !== undefined ? { exportedFrom: result.data.exportedFrom } : {}),
    },
  };
}
