import type { Session, SessionConfig, ThinkingLevel } from '@hyperneo/shared';
import { getThinkingOptionsForProvider, normalizeThinkingLevel } from '@hyperneo/shared';
import { z } from 'zod';
import { getAvailableModels, isCuratedOutModel } from '../model-service.ts';
import type { AgentSession } from '../agent/agent-session.ts';
import {
  defineOperation,
  type OperationCallerRole,
  type OperationPolicy,
} from '../operations/registry.ts';
import type { SessionOperationDependencies } from './operations.ts';

const READ_ROLES: readonly OperationCallerRole[] = ['long_term_agent', 'workflow_worker'];
const WRITE_ROLES: readonly OperationCallerRole[] = ['long_term_agent'];
const READ_POLICY: OperationPolicy = { safetyClass: 'read', roles: READ_ROLES };
const MUTATE_POLICY: OperationPolicy = { safetyClass: 'mutate', roles: WRITE_ROLES };

export type SessionOwnership =
  | 'ordinary'
  | 'project'
  | 'space-task'
  | 'space-agent'
  | 'neo'
  | 'unknown';

export interface RuntimeSettings {
  readonly sessionId: string;
  readonly ownership: SessionOwnership;
  readonly live: boolean;
  readonly runningNow: boolean;
  readonly model: string | null;
  readonly provider: string | null;
  readonly thinkingLevel: ThinkingLevel | null;
  readonly thinkingOptions: Array<{ value: ThinkingLevel; label: string }>;
}

export type RuntimeSettingsResult =
  | { ok: true; settings: RuntimeSettings }
  | { ok: false; reason: string; availableModels?: string[] };

export type RuntimeSettingsUpdateResult =
  | {
      ok: true;
      settings: RuntimeSettings;
      appliesFrom: 'next-turn';
      changes: { model?: boolean; provider?: boolean; thinkingLevel?: boolean };
      notes: string[];
    }
  | { ok: false; reason: string; availableModels?: string[] };

export interface RuntimeSettingsDependencies extends SessionOperationDependencies {
  readonly persistColdSessionConfig?: (sessionId: string, config: SessionConfig) => void;
}

export function classifySessionOwnership(
  session: Session,
  sessionSpaceId: (session: Session) => string | undefined
): SessionOwnership {
  if (session.id.startsWith('neo:')) return 'neo';
  if (session.type === 'space_task_agent' || session.id.includes(':task:')) return 'space-task';
  if (session.worktree) return 'project';
  if (sessionSpaceId(session)) return 'space-agent';
  return 'unknown';
}

function thinkingOptionsFor(
  provider: string | null
): Array<{ value: ThinkingLevel; label: string }> {
  if (!provider) return [];
  return getThinkingOptionsForProvider(provider);
}

function catalogModelIds(provider: string | null): string[] {
  return getAvailableModels('global')
    .filter((model) => !provider || model.provider === provider || !model.provider)
    .map((model) => model.id);
}

function validateModel(
  model: string,
  provider: string | null
): { ok: true } | { ok: false; reason: string; availableModels: string[] } {
  const available = catalogModelIds(provider);
  if (available.length === 0) {
    return {
      ok: false,
      reason: `catalog_unavailable: no models listed for provider ${provider ?? '(any)'}`,
      availableModels: [],
    };
  }
  if (!available.includes(model)) {
    return {
      ok: false,
      reason: `invalid_model: ${model} is not in the catalog for provider ${provider ?? '(any)'}`,
      availableModels: available,
    };
  }
  if (provider && isCuratedOutModel(model, provider)) {
    return {
      ok: false,
      reason: `curated_out: model '${model}' is curated out for provider '${provider}'`,
      availableModels: available.filter((id) => !isCuratedOutModel(id, provider)),
    };
  }
  return { ok: true };
}

export function readRuntimeSettings(
  sessionId: string,
  deps: RuntimeSettingsDependencies
): RuntimeSettingsResult {
  const live = deps.getLiveSession(sessionId);
  const session = live ? live.getSessionData() : deps.getSession(sessionId);
  if (!session) return { ok: false, reason: `session_not_found: ${sessionId}` };
  const provider = session.config?.provider ?? null;
  return {
    ok: true,
    settings: {
      sessionId,
      ownership: classifySessionOwnership(session, deps.sessionSpaceId),
      live: !!live,
      runningNow: live ? live.getProcessingState().status === 'processing' : false,
      model: session.config?.model ?? null,
      provider,
      thinkingLevel: session.config?.thinkingLevel ?? null,
      thinkingOptions: thinkingOptionsFor(provider),
    },
  };
}

async function applyLive(
  live: AgentSession,
  input: { model?: string; provider?: string; thinkingLevel?: string },
  notes: string[]
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (input.model !== undefined) {
    const provider = input.provider ?? live.getSessionData().config.provider ?? 'anthropic';
    const result = await live.handleModelSwitch(input.model, provider);
    if (!result.success) {
      return { ok: false, reason: `model_switch_failed: ${result.error ?? 'unknown error'}` };
    }
    notes.push('model applied to the live session');
  } else if (input.provider !== undefined) {
    await live.updateConfig({ provider: input.provider as SessionConfig['provider'] });
    notes.push('provider applied to the live session');
  }
  if (input.thinkingLevel !== undefined) {
    const level = normalizeThinkingLevel(input.thinkingLevel);
    const provider = live.getSessionData().config.provider ?? null;
    if (thinkingOptionsFor(provider).length === 0) {
      notes.push(
        `thinking level '${level}' recorded but is a no-op: provider ${provider ?? '(default)'} has no thinking controls`
      );
    }
    await live.updateConfig({ thinkingLevel: level });
    notes.push('thinking level applied to the live session');
  }
  return { ok: true };
}

function applyCold(
  session: Session,
  input: { model?: string; provider?: string; thinkingLevel?: string },
  notes: string[]
): SessionConfig {
  const config: SessionConfig = { ...session.config };
  if (input.model !== undefined) {
    config.model = input.model;
    notes.push('model persisted; the session starts under it next time');
  }
  if (input.provider !== undefined) config.provider = input.provider as SessionConfig['provider'];
  if (input.thinkingLevel !== undefined) {
    const level = normalizeThinkingLevel(input.thinkingLevel);
    if (thinkingOptionsFor(config.provider ?? null).length === 0) {
      notes.push(
        `thinking level '${level}' recorded but is a no-op: provider ${config.provider ?? '(default)'} has no thinking controls`
      );
    }
    config.thinkingLevel = level;
    notes.push('thinking level persisted');
  }
  return config;
}

const RuntimeSettingsRefSchema = z.object({ sessionId: z.string().min(1) });
const RuntimeSettingsUpdateSchema = z.object({
  sessionId: z.string().min(1),
  model: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
  thinkingLevel: z.string().min(1).optional(),
});
const RuntimeSettingsSchema = z.object({
  sessionId: z.string(),
  ownership: z.enum(['ordinary', 'project', 'space-task', 'space-agent', 'neo', 'unknown']),
  live: z.boolean(),
  runningNow: z.boolean(),
  model: z.string().nullable(),
  provider: z.string().nullable(),
  thinkingLevel: z.string().nullable(),
  thinkingOptions: z.array(z.object({ value: z.string(), label: z.string() })),
});
const FailureSchema = z.object({
  ok: z.literal(false),
  reason: z.string(),
  availableModels: z.array(z.string()).optional(),
});

export function createSessionRuntimeSettingsOperations(deps: RuntimeSettingsDependencies) {
  return [
    defineOperation({
      name: 'session.runtimeSettings.read',
      policy: READ_POLICY,
      description:
        'Read the effective runtime settings of any session — model, provider, thinking level — plus whether the session is live, whether a turn is streaming right now, its ownership type (ordinary, project, space-task, space-agent, neo, unknown), and the thinking levels its provider supports.',
      inputSchema: RuntimeSettingsRefSchema,
      resultSchema: z.union([
        z.object({ ok: z.literal(true), settings: RuntimeSettingsSchema }),
        FailureSchema,
      ]),
      execute: async (input: z.infer<typeof RuntimeSettingsRefSchema>) =>
        readRuntimeSettings(input.sessionId, deps),
    }),
    defineOperation({
      name: 'session.runtimeSettings.update',
      policy: MUTATE_POLICY,
      description:
        'Change the model, provider, or thinking level for any session type. Model changes are validated against the live model catalog; invalid requests fail with the list of valid model ids. Live sessions apply the change on their next turn — a turn already streaming completes under its original settings, nothing in-flight is mutated. Cold sessions persist the change and start under it next time. Thinking levels normalize to off/think8k/think16k/think24k/think32k; providers without thinking controls record the request as a stated no-op. Returns the effective settings after the change.',
      inputSchema: RuntimeSettingsUpdateSchema,
      resultSchema: z.union([
        z.object({
          ok: z.literal(true),
          settings: RuntimeSettingsSchema,
          appliesFrom: z.literal('next-turn'),
          changes: z.object({
            model: z.boolean().optional(),
            provider: z.boolean().optional(),
            thinkingLevel: z.boolean().optional(),
          }),
          notes: z.array(z.string()),
        }),
        FailureSchema,
      ]),
      execute: async (
        input: z.infer<typeof RuntimeSettingsUpdateSchema>
      ): Promise<RuntimeSettingsUpdateResult> => {
        if (
          input.model === undefined &&
          input.provider === undefined &&
          input.thinkingLevel === undefined
        ) {
          return {
            ok: false,
            reason: 'nothing_to_update: provide model, provider, or thinkingLevel',
          };
        }
        const live = deps.getLiveSession(input.sessionId);
        const session = live ? live.getSessionData() : deps.getSession(input.sessionId);
        if (!session) return { ok: false, reason: `session_not_found: ${input.sessionId}` };
        if (input.model !== undefined) {
          const provider = input.provider ?? session.config?.provider ?? null;
          const valid = validateModel(input.model, provider);
          if (!valid.ok) {
            return { ok: false, reason: valid.reason, availableModels: valid.availableModels };
          }
        }
        const notes: string[] = [];
        if (live) {
          const applied = await applyLive(live, input, notes);
          if (!applied.ok) return { ok: false, reason: applied.reason };
        } else {
          const config = applyCold(session, input, notes);
          deps.persistColdSessionConfig?.(input.sessionId, config);
        }
        const after = readRuntimeSettings(input.sessionId, deps);
        if (!after.ok) return { ok: false, reason: after.reason };
        return {
          ok: true,
          settings: after.settings,
          appliesFrom: 'next-turn',
          changes: {
            model: input.model !== undefined,
            provider: input.provider !== undefined,
            thinkingLevel: input.thinkingLevel !== undefined,
          },
          notes,
        };
      },
    }),
  ];
}
