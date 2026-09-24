import type { Session, SpaceLongHorizonAgent } from '@hyperneo/shared';
import { z } from 'zod';
import type {
  OperationCaller,
  OperationCallerRole,
  OperationPolicy,
} from '../operations/registry.ts';
import { resolveSessionSpaceId } from '../space/runtime/space-caller-scope.ts';
import type { SpaceMcpSessionPolicyContext } from '../space/runtime/space-mcp-session-policy.ts';

export const AgentStatusSchema = z.enum(['active', 'paused', 'disabled', 'archived']);

export const AgentThinkingLevelSchema = z.enum([
  'off',
  'think8k',
  'think16k',
  'think24k',
  'think32k',
]);

export const AgentSettingSourcesSchema = z.array(z.enum(['user', 'project', 'local']));

export const AgentAutonomyLevelSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);

export const AgentModelPoolEntrySchema = z.object({
  model: z.string(),
  provider: z.string().optional(),
  maxConcurrent: z.number(),
  weight: z.number(),
  thinkingLevel: AgentThinkingLevelSchema.nullish(),
});

export const AgentRecordSchema = z.object({
  id: z.string(),
  spaceId: z.string(),
  handle: z.string(),
  displayName: z.string(),
  templateKey: z.string().nullable(),
  status: AgentStatusSchema,
  sessionId: z.string().nullable(),
  instructions: z.string(),
  autonomyLevel: AgentAutonomyLevelSchema.nullable(),
  model: z.string().nullable(),
  thinkingLevel: AgentThinkingLevelSchema.nullable(),
  provider: z.string().nullable(),
  settingSources: AgentSettingSourcesSchema.nullable(),
  toolPermissions: z.record(z.string(), z.unknown()),
  description: z.string().optional(),
  modelPool: z.array(AgentModelPoolEntrySchema).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
}) satisfies z.ZodType<SpaceLongHorizonAgent>;

export const CompactAgentRecordSchema = z.object({
  id: z.string(),
  handle: z.string(),
  displayName: z.string(),
  status: AgentStatusSchema,
  model: z.string().nullable(),
  provider: z.string().nullable(),
  thinkingLevel: AgentThinkingLevelSchema.nullable(),
  templateKey: z.string().nullable(),
  updatedAt: z.number(),
});

export const AGENT_REJECTION_REASONS = [
  'space_required',
  'space_mismatch',
  'agent_denied',
  'agent_not_found',
  'invalid_name',
  'invalid_tools',
  'invalid_model',
  'runtime_refresh_failed',
  'session_unavailable',
  'goal_not_found',
  'scope_not_found',
  'template_rejected',
  'reminder_not_found',
  'reminder_not_cancellable',
] as const;

export const AgentRejectionSchema = z
  .object({
    rejected: z.literal(true),
    reason: z.enum(AGENT_REJECTION_REASONS),
    message: z.string(),
  })
  .strict();

export type AgentRejectionReason = (typeof AGENT_REJECTION_REASONS)[number];
export type AgentRejection = z.infer<typeof AgentRejectionSchema>;

export function rejectAgent(reason: AgentRejectionReason, message: string): AgentRejection {
  return { rejected: true, reason, message };
}

export const AgentSpaceScopeSchema = z.object({
  spaceId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Space to act in; required for human (RPC) callers, derived from the session for agents'
    ),
});

export interface AgentOperationDeps extends SpaceMcpSessionPolicyContext {
  readonly getSession: (sessionId: string) => Session | null;
}

export const AGENT_ROLES = ['long_term_agent'] as const satisfies readonly OperationCallerRole[];

export const AGENT_READ_POLICY: OperationPolicy = {
  safetyClass: 'read',
  roles: AGENT_ROLES,
};

export const AGENT_MUTATE_POLICY: OperationPolicy = {
  safetyClass: 'mutate',
  roles: AGENT_ROLES,
};

const DENIED_MESSAGE =
  'Agent operations require a human caller or an active Space member session in the owning Space.';

export function admitAgentCaller(
  input: { spaceId?: string },
  caller: OperationCaller,
  deps: AgentOperationDeps,
  access: 'read' | 'mutate'
): { value: string } | { reason: AgentRejection } {
  if (caller.source !== 'mcp') {
    return input.spaceId
      ? { value: input.spaceId }
      : { reason: rejectAgent('space_required', 'spaceId is required for this caller') };
  }
  if (!caller.spaceId) {
    return { reason: rejectAgent('agent_denied', DENIED_MESSAGE) };
  }
  if (input.spaceId !== undefined && input.spaceId !== caller.spaceId) {
    return {
      reason: rejectAgent(
        'space_mismatch',
        `spaceId "${input.spaceId}" does not match the caller Space "${caller.spaceId}"`
      ),
    };
  }
  if (access === 'read') return { value: caller.spaceId };
  const session = caller.sessionId ? deps.getSession(caller.sessionId) : null;
  return session?.status === 'active' && resolveSessionSpaceId(session, deps) === caller.spaceId
    ? { value: caller.spaceId }
    : { reason: rejectAgent('agent_denied', DENIED_MESSAGE) };
}
