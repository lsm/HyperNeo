import type { Session, ThinkingLevel } from '@hyperneo/shared';
import { getThinkingOptionsForProvider } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { AgentSession } from '../agent/agent-session.ts';
import {
  defineOperation,
  type OperationCallerRole,
  type OperationDefinition,
  type OperationPolicy,
} from '../operations/registry.ts';

const READ_ROLES: readonly OperationCallerRole[] = ['long_term_agent', 'workflow_worker', 'neo'];
const READ_POLICY: OperationPolicy = { safetyClass: 'read', roles: READ_ROLES };

export type SessionOwnership = 'ordinary' | 'project' | 'space-task' | 'space-agent' | 'neo';

export type RuntimeSettingsReadReason = 'session_not_found';

export interface RuntimeSettings {
  readonly sessionId: string;
  readonly ownership: SessionOwnership;
  readonly live: boolean;
  readonly queryActive: boolean;
  readonly model: string | null;
  readonly provider: string | null;
  readonly thinkingLevel: ThinkingLevel | null;
  readonly thinkingOptions: Array<{ value: ThinkingLevel; label: string }>;
}

export interface RuntimeSettingsReadDependencies {
  readonly getLiveSession: (sessionId: string) => AgentSession | null;
  readonly getSession: (sessionId: string) => Session | null;
  readonly sessionSpaceId: (session: Session) => string | undefined;
}

export function classifySessionOwnership(
  session: Session,
  sessionSpaceId: (session: Session) => string | undefined
): SessionOwnership {
  if (session.id.startsWith('neo:')) return 'neo';
  if (session.type === 'space_task_agent' || session.id.includes(':task:')) return 'space-task';
  if (session.worktree) return 'project';
  if (sessionSpaceId(session)) return 'space-agent';
  return 'ordinary';
}

function resolveTarget(
  sessionId: string,
  deps: RuntimeSettingsReadDependencies
):
  | { value: { session: Session; live: AgentSession | null } }
  | { reason: RuntimeSettingsReadReason } {
  const live = deps.getLiveSession(sessionId);
  const session = live ? live.getSessionData() : deps.getSession(sessionId);
  return session ? { value: { session, live } } : { reason: 'session_not_found' };
}

function projectRuntimeSettings(
  target: { session: Session; live: AgentSession | null },
  sessionId: string,
  deps: RuntimeSettingsReadDependencies
): RuntimeSettings {
  const { session, live } = target;
  const provider = session.config?.provider ?? null;
  return {
    sessionId,
    ownership: classifySessionOwnership(session, deps.sessionSpaceId),
    live: live !== null,
    queryActive: live ? live.isQueryActiveOrStarting() : false,
    model: session.config?.model ?? null,
    provider,
    thinkingLevel: session.config?.thinkingLevel ?? null,
    thinkingOptions: provider ? getThinkingOptionsForProvider(provider) : [],
  };
}

const readSessionRuntimeSettings = (superpipe({})('read-session-runtime-settings') as PipelineAPI)
  .input(['sessionId', 'deps'])
  .pipe(resolveTarget, ['sessionId', 'deps'], 'result:read')
  .pipe(projectRuntimeSettings, ['read', 'sessionId', 'deps'], 'read')
  .end('read') as (
  sessionId: string,
  deps: RuntimeSettingsReadDependencies
) => RuntimeSettings | RuntimeSettingsReadReason;

export function readRuntimeSettings(
  sessionId: string,
  deps: RuntimeSettingsReadDependencies
): { ok: true; settings: RuntimeSettings } | { ok: false; reason: RuntimeSettingsReadReason } {
  const outcome = readSessionRuntimeSettings(sessionId, deps);
  return typeof outcome === 'string'
    ? { ok: false, reason: outcome }
    : { ok: true, settings: outcome };
}

const RuntimeSettingsReadInputSchema = z.object({ sessionId: z.string().min(1) });

const RuntimeSettingsSchema = z.object({
  sessionId: z.string(),
  ownership: z.enum(['ordinary', 'project', 'space-task', 'space-agent', 'neo']),
  live: z.boolean(),
  queryActive: z.boolean(),
  model: z.string().nullable(),
  provider: z.string().nullable(),
  thinkingLevel: z.string().nullable(),
  thinkingOptions: z.array(z.object({ value: z.string(), label: z.string() })),
});

const RuntimeSettingsReadFailureSchema = z.object({
  ok: z.literal(false),
  reason: z.literal('session_not_found'),
});

export function createSessionRuntimeSettingsReadOperations(
  deps: RuntimeSettingsReadDependencies
): OperationDefinition[] {
  return [
    defineOperation({
      name: 'session.runtimeSettings.read',
      policy: READ_POLICY,
      description:
        'Read the effective runtime settings of any session: model, provider, thinking level, ' +
        'whether the session is live, whether its query is active (a turn in flight or starting), ' +
        'its ownership type (ordinary, project, space-task, space-agent, neo), and the thinking ' +
        'levels its provider supports. Read-only: it never mutates a session, its config, or its query.',
      inputSchema: RuntimeSettingsReadInputSchema,
      resultSchema: z.union([
        z.object({ ok: z.literal(true), settings: RuntimeSettingsSchema }),
        RuntimeSettingsReadFailureSchema,
      ]),
      execute: async (input: z.infer<typeof RuntimeSettingsReadInputSchema>) =>
        readRuntimeSettings(input.sessionId, deps),
    }),
  ];
}
