import type {
  EvidenceQualityPreflight,
  EvolutionEpisode,
  EvolutionFinding,
  EvolutionLesson,
  SpaceGoal,
  TaskProposal,
} from '@hyperneo/shared';
import { z } from 'zod';
import { EvolutionMetricValuesSchema } from './result-schemas.ts';

export const EvolutionPrioritySchema = z.enum(['low', 'normal', 'high', 'urgent']);
export const EvolutionEpisodeStatusSchema = z.enum(['draft', 'accepted', 'dismissed']);
export const EvolutionLessonStatusSchema = z.enum(['candidate', 'active', 'dismissed']);
export const EvolutionProposalStatusSchema = z.enum([
  'proposed',
  'accepted',
  'dismissed',
  'created',
]);

export const EvolutionFindingSchema = z.object({
  domain: z.enum(['workflow', 'target_artifact', 'hyperneo_product']),
  kind: z.enum(['friction', 'bug', 'optimization', 'missing_capability', 'new_opportunity']),
  impact: z.enum(['low', 'medium', 'high']),
  confidence: z.number(),
  evidence: z.array(z.string()),
  proposedAction: z.string(),
}) satisfies z.ZodType<EvolutionFinding>;

export const EvolutionEpisodeSchema = z.object({
  id: z.string(),
  scopeId: z.string(),
  status: EvolutionEpisodeStatusSchema,
  rollupAppliedAt: z.number().nullable(),
  title: z.string(),
  timeWindow: z.object({ start: z.number(), end: z.number() }).nullable(),
  evidenceIds: z.array(z.string()),
  outcomeSummary: z.string(),
  findings: z.array(EvolutionFindingSchema),
  createdAt: z.number(),
  updatedAt: z.number(),
}) satisfies z.ZodType<EvolutionEpisode>;

export const EvolutionLessonSchema = z.object({
  id: z.string(),
  scopeId: z.string(),
  status: EvolutionLessonStatusSchema,
  appliesTo: z.array(z.string()),
  rule: z.string(),
  why: z.string(),
  evidenceEpisodeIds: z.array(z.string()),
  confidence: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
}) satisfies z.ZodType<EvolutionLesson>;

export const EvolutionProposalSchema = z.object({
  id: z.string(),
  scopeId: z.string(),
  title: z.string(),
  description: z.string(),
  reason: z.string(),
  priority: EvolutionPrioritySchema,
  status: EvolutionProposalStatusSchema,
  evidenceEpisodeIds: z.array(z.string()),
  createdTaskId: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
}) satisfies z.ZodType<TaskProposal>;

export const EvolutionPreflightSchema = z.object({
  level: z.enum(['low', 'medium', 'high']),
  score: z.number(),
  maxScore: z.number(),
  canGenerate: z.boolean(),
  requiresConfirmation: z.boolean(),
  reasons: z.array(z.string()),
  warnings: z.array(z.string()),
  counts: z.object({
    total: z.number(),
    manualNotes: z.number(),
    taskResults: z.number(),
    workflowArtifacts: z.number(),
    metricSnapshots: z.number(),
    outcomes: z.number(),
  }),
  artifactDiagnostics: z.object({
    status: z.enum(['selected', 'available_omitted', 'none_available']),
    availableKinds: z.array(z.string()),
    omittedCount: z.number(),
    recommendations: z.array(z.string()),
  }),
}) satisfies z.ZodType<EvidenceQualityPreflight>;

export const EvolutionGoalSchema = z.object({
  id: z.string(),
  spaceId: z.string(),
  title: z.string(),
  description: z.string(),
  status: z.enum(['active', 'paused', 'completed', 'archived']),
  type: z.enum(['one_shot', 'measurable', 'recurring']),
  priority: EvolutionPrioritySchema,
  labels: z.array(z.string()),
  metrics: EvolutionMetricValuesSchema,
  summary: z.string(),
  progress: z.number(),
  nextSteps: z.array(z.string()),
  preferredWorkflowId: z.string().nullable(),
  taskScheduleId: z.string().nullable(),
  autoTriggerNext: z.boolean(),
  pendingNextRun: z.boolean(),
  activeTaskId: z.string().nullable(),
  lastTaskId: z.string().nullable(),
  lastCheckInAt: z.number().nullable(),
  nextCheckInAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  completedAt: z.number().nullable(),
  workspacePath: z.string().nullable().optional(),
  revision: z.number(),
}) satisfies z.ZodType<SpaceGoal>;
