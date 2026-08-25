import { z } from 'zod';
import { validateGlobPattern } from '../external-events/topic-validator.ts';
import { MAX_NODE_HANDOFF_TRANSITIONS } from '@hyperneo/shared';
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
import { validateSlug } from './slug.ts';

const _workflowConditionSchema = z
  .object({
    type: z.enum(['always', 'human', 'condition', 'task_result']),
    expression: z.string().optional(),
    description: z.string().optional(),
    maxRetries: z.number().int().nonnegative().optional(),
    timeoutMs: z.number().int().nonnegative().optional(),
    allowedEnv: z.array(z.string().min(1)).optional(),
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
  disabledSkillIds: z.array(z.string()).optional(),
  extraMcpServers: z.record(z.string(), z.unknown()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  toolGuards: z.array(declarativeToolGuardSchema).optional(),
  eventInterests: z.array(eventInterestSchema).max(MAX_AGENT_SLOT_EVENT_INTERESTS).optional(),
  resetContextPerTurn: z.boolean().optional(),
});

const exportedWorkflowChannelSchema = z.object({
  from: z.string().min(1),
  to: z.union([z.string().min(1), z.array(z.string().min(1))]),
  maxCycles: z.number().int().positive().optional(),
  label: z.string().optional(),
});

const workflowHookValidatorSchema = z.union([
  z.object({ kind: z.literal('built_in'), id: z.string().min(1) }),
  z.object({
    kind: z.literal('script'),
    interpreter: z.literal('bash'),
    source: z.string().min(1),
    timeoutMs: z.number().int().positive().optional(),
    externalLookups: z.array(z.string().min(1)).optional(),
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
  transitions: z
    .array(exportedHandoffTransitionSchema)
    .max(MAX_NODE_HANDOFF_TRANSITIONS)
    .optional(),
});

export const CURRENT_EXPORT_VERSION = 4 as const;
const SUPPORTED_EXPORT_VERSIONS: ReadonlySet<number> = new Set<number>([1, 2, 3, 4]);
export type ExportVersion = 1 | 2 | 3 | 4;

function asSupportedVersion(version: unknown): ExportVersion {
  return version as ExportVersion;
}

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
  modelPool: z
    .array(
      z.object({
        model: z.string().min(1),
        provider: z.string().optional(),
        maxConcurrent: z.number().int().min(1),
        weight: z.number().min(0),
      })
    )
    .refine((pool) => new Set(pool.map((entry) => entry.model)).size === pool.length, {
      message: 'modelPool contains duplicate entries for the same model',
    })
    .optional(),
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
  completionAutonomyLevel: z.number().int().min(1).max(5).optional(),
  disabled: z.boolean().optional(),
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

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function normalizeOverride(
  value: import('@hyperneo/shared').WorkflowNodeAgentOverride | string | undefined
): import('@hyperneo/shared').WorkflowNodeAgentOverride | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return { value };
  return value;
}

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
  if (agent.modelPool !== undefined && agent.modelPool.length > 0)
    exported.modelPool = agent.modelPool;
  return exported;
}

export function exportWorkflow(
  workflow: SpaceWorkflow,
  agents: SpaceWorkerAgent[]
): ExportedSpaceWorkflow {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nodes = workflow.nodes ?? (workflow as any).steps ?? [];
  const nodeIdToName = new Map<string, string>();
  for (const node of nodes) {
    nodeIdToName.set(node.id, node.name);
  }

  const agentIdToName = new Map<string, string>();
  for (const agent of agents) {
    agentIdToName.set(agent.id, agent.name);
  }

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
  if (workflow.hooks && workflow.hooks.length > 0) {
    result.hooks = workflow.hooks;
  }
  return result;
}

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
  if (version < 4 && result.data.modelPool !== undefined) {
    return { ok: false, error: 'invalid: modelPool requires export version 4 or newer' };
  }
  return { ok: true, value: { version, ...result.data } };
}

export function validateExportedWorkflow(data: unknown): ValidationResult<ExportedSpaceWorkflow> {
  if (typeof data !== 'object' || data === null) {
    return { ok: false, error: 'invalid: expected an object' };
  }
  const versionError = checkVersion((data as Record<string, unknown>).version);
  if (versionError) return { ok: false, error: versionError };
  const version = asSupportedVersion((data as Record<string, unknown>).version);

  const result = exportedWorkflowBaseSchema.safeParse(data);
  if (!result.success) {
    return { ok: false, error: `invalid: ${result.error.issues.map((i) => i.message).join('; ')}` };
  }

  const nodeNameSet = new Set<string>();
  for (const node of result.data.nodes) {
    if (nodeNameSet.has(node.name)) {
      return { ok: false, error: `invalid: duplicate node name: "${node.name}"` };
    }
    nodeNameSet.add(node.name);
  }
  if (result.data.nodes.length > 0 && !nodeNameSet.has(result.data.startNode)) {
    return {
      ok: false,
      error: `invalid: startNode "${result.data.startNode}" does not reference a known node name`,
    };
  }
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

  const transitionHookIds = new Set<string>();
  for (const hook of result.data.hooks ?? []) {
    if (hook?.id) transitionHookIds.add(hook.id);
  }
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

  return {
    ok: true,
    value: { version, ...result.data } as ExportedSpaceWorkflow,
  };
}

export function validateExportBundle(data: unknown): ValidationResult<SpaceExportBundle> {
  if (typeof data !== 'object' || data === null) {
    return { ok: false, error: 'invalid: expected an object' };
  }
  const versionError = checkVersion((data as Record<string, unknown>).version);
  if (versionError) return { ok: false, error: versionError };
  const version = asSupportedVersion((data as Record<string, unknown>).version);

  const result = exportBundleBaseSchema.safeParse(data);
  if (!result.success) {
    return { ok: false, error: `invalid: ${result.error.issues.map((i) => i.message).join('; ')}` };
  }

  const raw = data as Record<string, unknown>;
  const rawAgents = Array.isArray(raw.agents) ? raw.agents : [];
  for (let i = 0; i < rawAgents.length; i++) {
    const agentResult = validateExportedAgent(rawAgents[i]);
    if (!agentResult.ok) {
      return { ok: false, error: `agents[${i}]: ${agentResult.error}` };
    }
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
      workflows: result.data.workflows.map((w) => ({ version, ...w }) as ExportedSpaceWorkflow),
      exportedAt: result.data.exportedAt,
      ...(result.data.exportedFrom !== undefined ? { exportedFrom: result.data.exportedFrom } : {}),
    },
  };
}
