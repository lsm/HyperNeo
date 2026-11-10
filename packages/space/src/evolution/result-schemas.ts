import type {
  EvidenceRef,
  EvolutionPolicy,
  EvolutionScope,
  MetricDefinition,
  MetricSnapshot,
} from '@hyperneo/shared';
import { z } from 'zod';

export const EvolutionScopeKindSchema = z.enum([
  'mission',
  'project',
  'campaign',
  'workflow',
  'custom',
]);

export const EvolutionMetricValuesSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()])
);

export const EvolutionMetadataSchema = z.record(z.string(), z.unknown());

export const EvolutionMetricDefinitionSchema = z.object({
  key: z.string(),
  label: z.string(),
  description: z.string().optional(),
  direction: z.enum(['increase', 'decrease', 'target', 'maintain']),
  targetValue: z.union([z.number(), z.string(), z.boolean(), z.null()]).optional(),
  unit: z.string().optional(),
}) satisfies z.ZodType<MetricDefinition>;

export const EvolutionAutomationPolicySchema = z.object({
  completedTaskThreshold: z.number().optional(),
  completedTaskAutomationEnabled: z.boolean().optional(),
  selfNagCronExpression: z.string().optional(),
  selfNagTimezone: z.string().optional(),
  eventSubscriptions: z
    .array(
      z.object({
        topic: z.string(),
        source: z.string().optional(),
        filter: EvolutionMetricValuesSchema.optional(),
      })
    )
    .optional(),
  maxEvidencePerEpisode: z.number().optional(),
});

export const EvolutionPolicySchema = z
  .object({
    episodeJudgeModel: z.string().optional(),
    episodeJudgeProvider: z.string().optional(),
    automation: EvolutionAutomationPolicySchema.optional(),
  })
  .catchall(z.unknown()) satisfies z.ZodType<EvolutionPolicy>;

export const EvolutionScopeSchema = z.object({
  id: z.string(),
  spaceId: z.string(),
  spaceGoalId: z.string().nullable(),
  kind: EvolutionScopeKindSchema,
  name: z.string(),
  objective: z.string(),
  parentScopeId: z.string().nullable(),
  metricDefinitions: z.array(EvolutionMetricDefinitionSchema),
  policy: EvolutionPolicySchema,
  createdAt: z.number(),
  updatedAt: z.number(),
}) satisfies z.ZodType<EvolutionScope>;

export const EvolutionEvidenceKindSchema = z.enum([
  'task',
  'workflow_run',
  'session',
  'manual_note',
  'metric_snapshot',
  'task_result',
  'artifact',
  'error',
  'daemon_error',
  'runtime_crash',
  'runtime_warning',
  'uncaught_exception',
  'error_cluster',
  'retry_loop',
  'tool_failure',
  'test_failure',
  'permission_block',
  'slow_tool_call',
  'conversation_friction',
  'friction_digest',
  'verification_triage',
]);

export const EvolutionEvidenceRefSchema = z.object({
  id: z.string(),
  scopeId: z.string(),
  kind: EvolutionEvidenceKindSchema,
  summary: z.string(),
  sourceId: z.string().nullable(),
  metadata: EvolutionMetadataSchema,
  createdAt: z.number(),
}) satisfies z.ZodType<EvidenceRef>;

export const EvolutionMetricSnapshotSchema = z.object({
  id: z.string(),
  scopeId: z.string(),
  capturedAt: z.number(),
  values: EvolutionMetricValuesSchema,
  source: z.string(),
  note: z.string().nullable(),
  createdAt: z.number(),
}) satisfies z.ZodType<MetricSnapshot>;
