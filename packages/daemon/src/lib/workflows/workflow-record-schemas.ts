import type {
  NodeExecution,
  SpaceWorkflow,
  SpaceWorkflowRun,
  SpaceWorkflowSummary,
} from '@hyperneo/shared';
import { z } from 'zod';

export const AutonomyLevelSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);

export const WorkflowSummarySchema = z.object({
  id: z.string(),
  spaceId: z.string(),
  name: z.string(),
  description: z.string().optional(),
  tags: z.array(z.string()),
  templateName: z.string().optional(),
  disabled: z.boolean().optional(),
  handle: z.string().optional(),
  nodeCount: z.number(),
  completionAutonomyLevel: AutonomyLevelSchema,
  templateHash: z.string().nullable().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
}) satisfies z.ZodType<SpaceWorkflowSummary>;

const ThinkingLevelSchema = z.enum(['off', 'think8k', 'think16k', 'think24k', 'think32k']);

const HeaderMapSchema = z.record(z.string(), z.string());

const McpServerConfigSchema = z.union([
  z.object({
    type: z.literal('stdio').optional(),
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: HeaderMapSchema.optional(),
  }),
  z.object({ type: z.literal('sse'), url: z.string(), headers: HeaderMapSchema.optional() }),
  z.object({ type: z.literal('http'), url: z.string(), headers: HeaderMapSchema.optional() }),
]);

const EventInterestSchema = z.object({
  topic: z.string().optional(),
  topicFrom: z.object({ source: z.literal('primaryLink'), pattern: z.string() }).optional(),
  label: z.string().optional(),
});

const ToolGuardSchema = z.object({
  matcher: z.string(),
  pattern: z.string(),
  decision: z.literal('deny'),
  reason: z.string(),
});

const ModelPoolEntrySchema = z.object({
  model: z.string(),
  provider: z.string().optional(),
  maxConcurrent: z.number(),
  weight: z.number(),
  thinkingLevel: ThinkingLevelSchema.nullable().optional(),
});

const NodeAgentSchema = z.object({
  agentId: z.string(),
  templateKey: z.string().nullable().optional(),
  name: z.string(),
  model: z.string().optional(),
  provider: z.string().optional(),
  modelPool: z.array(ModelPoolEntrySchema).optional(),
  thinkingLevel: ThinkingLevelSchema.optional(),
  customPrompt: z.object({ value: z.string() }).optional(),
  replaceAgentPrompt: z.boolean().optional(),
  disabledSkillIds: z.array(z.string()).optional(),
  extraMcpServers: z.record(z.string(), McpServerConfigSchema).optional(),
  eventInterests: z.array(EventInterestSchema).optional(),
  timeoutMs: z.number().optional(),
  toolGuards: z.array(ToolGuardSchema).optional(),
  resetContextPerTurn: z.boolean().optional(),
});

const PostApprovalRouteSchema = z.object({
  targetAgent: z.string(),
  instructions: z.string(),
  requirePrMerge: z.boolean().optional(),
});

const HandoffTransitionSchema = z.object({
  id: z.string(),
  label: z.string().optional(),
  target: z.string(),
  hookId: z.string().optional(),
  maxCycles: z.number().optional(),
});

const NodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  agents: z.array(NodeAgentSchema),
  postApproval: PostApprovalRouteSchema.optional(),
  transitions: z.array(HandoffTransitionSchema).optional(),
});

const ChannelSchema = z.object({
  id: z.string().optional(),
  from: z.string(),
  to: z.union([z.string(), z.array(z.string())]),
  maxCycles: z.number().optional(),
  label: z.string().optional(),
});

const HookValidatorSchema = z.union([
  z.object({
    kind: z.literal('built_in'),
    id: z.enum([
      'pr_open',
      'pr_mergeable',
      'pr_ready',
      'pr_merged',
      'review_posted',
      'github_review_approved',
      'codex_review_approved',
      'artifact_exists',
      'task_reported_status',
      'post_approval_only',
    ]),
  }),
  z.object({
    kind: z.literal('script'),
    interpreter: z.literal('bash'),
    source: z.string(),
    timeoutMs: z.number().optional(),
    externalLookups: z.array(z.string()).optional(),
  }),
]);

const HookSchema = z.object({
  id: z.string(),
  enabled: z.boolean(),
  sourceNode: z.string(),
  targetNode: z.string().optional(),
  method: z.enum([
    'send_message',
    'save_artifact',
    'create_standalone_task',
    'mark_complete',
    'submit_for_approval',
    'approve_task',
  ]),
  templateData: z.record(z.string(), z.unknown()).optional(),
  validator: HookValidatorSchema,
  retry: z
    .object({
      maxAttempts: z.number(),
      delayMs: z.number(),
      backoffMultiplier: z.number().optional(),
    })
    .optional(),
  poll: z.object({ intervalMs: z.number(), maxDurationMs: z.number().optional() }).optional(),
  localState: z
    .object({
      defaults: z.record(z.string(), z.unknown()).optional(),
      recentResultRef: z.object({ hookId: z.string(), key: z.string() }).optional(),
    })
    .optional(),
  authorizedCallers: z
    .array(z.object({ sourceNode: z.string(), agentSlots: z.array(z.string()).optional() }))
    .optional(),
  humanOnly: z.boolean().optional(),
  classification: z.enum(['validation', 'side_effect']).optional(),
  order: z.number().optional(),
  label: z.string().optional(),
});

const TemplateSnapshotSchema = z.looseObject({
  key: z.string(),
  handle: z.string(),
  displayName: z.string(),
  description: z.string(),
  instructions: z.string(),
  suggestedAutonomyLevel: AutonomyLevelSchema,
  model: z.string().nullable(),
  provider: z.string().nullable(),
  modelPool: z.array(ModelPoolEntrySchema).nullable(),
  thinkingLevel: ThinkingLevelSchema.nullable(),
  settingSources: z.array(z.enum(['user', 'project', 'local'])).nullable(),
  tools: z.array(z.string()).nullable(),
  labels: z.array(z.string()),
  version: z.number().optional(),
});

export const WorkflowDetailSchema = z.object({
  id: z.string(),
  spaceId: z.string(),
  name: z.string(),
  description: z.string().optional(),
  instructions: z.string().optional(),
  nodes: z.array(NodeSchema),
  startNodeId: z.string(),
  endNodeId: z.string().optional(),
  channels: z.array(ChannelSchema).optional(),
  hooks: z.array(HookSchema).optional(),
  tags: z.array(z.string()),
  layout: z.record(z.string(), z.object({ x: z.number(), y: z.number() })).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  completionAutonomyLevel: AutonomyLevelSchema,
  templateName: z.string().optional(),
  templateHash: z.string().optional(),
  postApproval: PostApprovalRouteSchema.optional(),
  disabled: z.boolean().optional(),
  handle: z.string().optional(),
  templateSnapshots: z.record(z.string(), TemplateSnapshotSchema).optional(),
}) satisfies z.ZodType<SpaceWorkflow>;

export const WorkflowRunSchema = z.object({
  id: z.string(),
  spaceId: z.string(),
  workflowId: z.string(),
  definitionVersion: z.string().nullable(),
  title: z.string(),
  description: z.string().optional(),
  status: z.enum(['pending', 'in_progress', 'done', 'blocked', 'cancelled']),
  failureReason: z
    .enum(['humanRejected', 'maxIterationsReached', 'nodeTimeout', 'agentCrash'])
    .optional(),
  blockedRetryCount: z.number().int().nonnegative(),
  createdAt: z.number(),
  startedAt: z.number().nullable(),
  updatedAt: z.number(),
  completedAt: z.number().nullable(),
}) satisfies z.ZodType<SpaceWorkflowRun>;

export const NodeExecutionSchema = z.object({
  id: z.string(),
  workflowRunId: z.string(),
  workflowNodeId: z.string(),
  agentName: z.string(),
  agentId: z.string().nullable(),
  agentSessionId: z.string().nullable(),
  status: z.enum(['pending', 'in_progress', 'idle', 'waiting_rebind', 'blocked', 'cancelled']),
  result: z.string().nullable(),
  data: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.number(),
  startedAt: z.number().nullable(),
  completedAt: z.number().nullable(),
  updatedAt: z.number(),
  lastActivityAt: z.number().nullable(),
}) satisfies z.ZodType<NodeExecution>;
