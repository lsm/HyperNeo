import type { Provider, Session, ThinkingLevel } from '@hyperneo/shared';
import { PROVIDER_THINKING_MODES } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type {
  SessionRuntimeSettingsSnapshot,
  RuntimeSettingsPatch,
} from '../../storage/repositories/session-runtime-settings-write.ts';
import type { AgentSession } from '../agent/agent-session.ts';
import type { SessionManager } from './session-manager.ts';
import { snapshotProcessingStatus } from '../agent/model-switch-handler.ts';
import {
  decideSwitch,
  oxapModelSwitchRefusal,
  thinkingRefusal,
  type SessionEngine,
} from '../agent/session-engine.ts';
import { resolveHyperneoThinking } from '../drivers/start-configuration.ts';
import { matchModelIdOrName, usableModels } from '../usable-models.ts';
import { getAvailableModels, isCuratedOutModel } from '../model-service.ts';
import { inferProviderForModel } from '../providers/registry.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import { admitSpaceCaller } from '../operations/space-caller-admission.ts';
import {
  createSessionRuntimeSettingsReadOperations,
  readRuntimeSettings,
  type RuntimeSettingsReadDependencies,
} from './runtime-settings-read-operation.ts';

export async function setSessionThinkingLevel(
  sessions: Pick<SessionManager, 'updateSession'>,
  agent: AgentSession,
  thinkingLevel: ThinkingLevel
) {
  const { id, config } = agent.getSessionData();
  const error = thinkingRefusal(config.harness, thinkingLevel);
  if (error) return { success: false as const, error };
  await sessions.updateSession(id, { config: { ...config, thinkingLevel } });
  await agent.applyThinkingLevel();
  return { success: true as const, thinkingLevel };
}

export interface RuntimeSettingsDependencies extends RuntimeSettingsReadDependencies {
  readonly capture: (id: string) => SessionRuntimeSettingsSnapshot | null;
  readonly commit: (
    snapshot: SessionRuntimeSettingsSnapshot,
    patch: RuntimeSettingsPatch
  ) => Promise<'won' | 'superseded'>;
  readonly isPreparing: (id: string) => boolean;
  readonly hasPendingWork: (id: string) => boolean;
  readonly notify: (id: string) => Promise<void>;
  readonly engineOf: (provider: string) => SessionEngine;
}

const InputSchema = z.object({
  sessionId: z.string().min(1),
  model: z.string().min(1).optional(),
  provider: z.enum(Object.keys(PROVIDER_THINKING_MODES) as [Provider, ...Provider[]]).optional(),
  thinkingLevel: z.string().min(1).optional(),
});
type Input = z.infer<typeof InputSchema>;
type ResolvedInput = Omit<Input, 'provider' | 'thinkingLevel'> & {
  provider?: string;
  thinkingLevel?: ThinkingLevel;
};
type Failure = { ok: false; reason: string; availableModels?: string[] };
type Target = {
  snapshot: SessionRuntimeSettingsSnapshot;
  live: ReturnType<RuntimeSettingsDependencies['getLiveSession']>;
};

type ResolvedTarget = Target & { input: ResolvedInput };

function callerOwnsTarget(
  id: string,
  caller: OperationCaller,
  deps: RuntimeSettingsDependencies
): boolean {
  if (caller.source !== 'mcp') return true;
  const owner = caller.sessionId ? deps.getSession(caller.sessionId) : null;
  if (!owner || owner.status !== 'active') return false;
  if (caller.role === 'neo') return true;
  const admitted = admitSpaceCaller(caller, undefined, { readOnly: false, ...deps });
  const target = deps.getSession(id);
  return 'value' in admitted && !!target && deps.sessionSpaceId(target) === admitted.value;
}

function captureTarget(input: Input, caller: OperationCaller, deps: RuntimeSettingsDependencies) {
  if (
    input.model === undefined &&
    input.provider === undefined &&
    input.thinkingLevel === undefined
  )
    return { reason: { ok: false, reason: 'nothing_to_update' } as Failure };
  if (!callerOwnsTarget(input.sessionId, caller, deps))
    return { reason: { ok: false, reason: 'denied' } as Failure };
  const snapshot = deps.capture(input.sessionId);
  return snapshot
    ? { value: { snapshot, live: deps.getLiveSession(input.sessionId) } }
    : { reason: { ok: false, reason: 'session_not_found' } as Failure };
}

function gateReady(
  target: Target,
  input: Pick<ResolvedInput, 'model' | 'provider'>,
  deps: RuntimeSettingsDependencies
) {
  const { snapshot, live } = target;
  const liveThinkingOnly =
    input.model === undefined && input.provider === undefined && !!live?.queryObject;
  if (snapshot.status !== 'active' || snapshot.archivedAt !== null)
    return { reason: { ok: false, reason: 'session_settings_changed' } as Failure };
  const status = snapshotProcessingStatus(snapshot);
  const original = JSON.parse(snapshot.config) as Record<string, unknown>;
  if (
    live &&
    (['model', 'provider', 'thinkingLevel'] as const).some(
      (key) => live.getSessionData().config[key] !== original[key]
    )
  )
    return { reason: { ok: false, reason: 'session_settings_changed' } as Failure };
  return (status !== null && status !== 'idle') ||
    deps.isPreparing(snapshot.id) ||
    deps.hasPendingWork(snapshot.id) ||
    (live &&
      ((live.isQueryActiveOrStarting() && !liveThinkingOnly) ||
        live.getProcessingState().status !== 'idle'))
    ? { reason: { ok: false, reason: 'session_busy' } as Failure }
    : { value: target };
}

function resolveSettings(target: Target, input: Input) {
  const thinkingLevel = resolveHyperneoThinking(input.thinkingLevel)?.value;
  if (input.thinkingLevel !== undefined && thinkingLevel === undefined)
    return { reason: { ok: false, reason: 'invalid_thinking_level' } as Failure };
  const available =
    input.model === undefined ? [] : usableModels(getAvailableModels('global'), input.provider);
  const current = JSON.parse(target.snapshot.config) as Session['config'];
  const currentProviderMatch = available.find(
    (entry) => entry.id === input.model && entry.provider === current.provider
  );
  const models = currentProviderMatch
    ? [currentProviderMatch]
    : input.model === undefined
      ? []
      : matchModelIdOrName(available, input.model);
  if (models.length > 1)
    return {
      reason: {
        ok: false,
        reason: 'ambiguous_model',
        availableModels: models.map((model) => model.id),
      } as Failure,
    };
  const match = models[0];
  const resolved: ResolvedInput = {
    ...input,
    model: match?.id ?? input.model,
    provider: input.provider ?? match?.provider,
    thinkingLevel,
  };
  return { value: { ...target, input: resolved } };
}

function validatePair(target: ResolvedTarget) {
  const { input } = target;
  const current = JSON.parse(target.snapshot.config) as { model?: string; provider?: Provider };
  const model = input.model ?? current.model;
  const provider =
    input.provider ?? current.provider ?? (model ? inferProviderForModel(model) : undefined);
  if (
    model &&
    provider &&
    (input.model !== undefined || model !== current.model || provider !== current.provider) &&
    isCuratedOutModel(model, provider)
  )
    return {
      reason: {
        ok: false,
        reason: 'curated_out',
        availableModels: getAvailableModels('global')
          .filter((item) => !isCuratedOutModel(item.id, provider))
          .map((item) => item.id),
      } as Failure,
    };
  if (input.model !== undefined || input.provider !== undefined) {
    const available = getAvailableModels('global')
      .filter((item) => item.provider === provider)
      .map((item) => item.id);
    const reason =
      available.length === 0
        ? 'catalog_unavailable'
        : !model || !available.includes(model)
          ? 'invalid_model'
          : null;
    if (reason) return { reason: { ok: false, reason, availableModels: available } as Failure };
  }
  return { value: target };
}

function gateHarness(target: ResolvedTarget, deps: RuntimeSettingsDependencies) {
  const { input } = target;
  const current = JSON.parse(target.snapshot.config) as Session['config'];
  const provider =
    input.model !== undefined || input.provider !== undefined
      ? (input.provider ?? current.provider ?? inferProviderForModel(input.model ?? current.model))
      : undefined;
  const switched = provider ? decideSwitch(current, provider, deps.engineOf(provider)) : true;
  const reason =
    switched === true
      ? (oxapModelSwitchRefusal(
          current,
          target.snapshot.sdkSessionId,
          input.model,
          input.thinkingLevel
        ) ?? thinkingRefusal(current.harness, input.thinkingLevel, input.model ?? current.model))
      : switched;
  return reason ? { reason: { ok: false, reason } as Failure } : { value: target };
}

async function applySettings(
  target: ResolvedTarget,
  caller: OperationCaller,
  deps: RuntimeSettingsDependencies
) {
  const { snapshot, live, input } = target;
  const current = JSON.parse(snapshot.config) as Session['config'];
  const model = input.model ?? current.model;
  const provider = input.provider ?? current.provider ?? inferProviderForModel(model);
  const { thinkingLevel } = input;
  const currentOwner = () =>
    deps.getLiveSession(snapshot.id) === live &&
    !deps.isPreparing(snapshot.id) &&
    !deps.hasPendingWork(snapshot.id) &&
    callerOwnsTarget(snapshot.id, caller, deps);
  const ready = gateReady(target, input, deps);
  if ('reason' in ready) return { reason: ready.reason };
  if (!currentOwner())
    return { reason: { ok: false, reason: 'session_settings_changed' } as Failure };
  if (live && (input.model !== undefined || input.provider !== undefined)) {
    const switched = await live.handleModelSwitch(model, provider, true, {
      snapshot,
      thinkingLevel,
      isCurrentOwner: currentOwner,
    });
    if (!switched.success)
      return { reason: { ok: false, reason: switched.error ?? 'model_switch_failed' } as Failure };
    if (thinkingLevel !== undefined && current.harness === 'oxap-codex')
      await live.applyThinkingLevel();
  } else {
    if (
      (await deps.commit(snapshot, {
        model: input.model !== undefined || input.provider !== undefined ? model : undefined,
        provider: input.model !== undefined || input.provider !== undefined ? provider : undefined,
        thinkingLevel,
      })) !== 'won'
    )
      return { reason: { ok: false, reason: 'session_settings_changed' } as Failure };
    if (live && thinkingLevel !== undefined) {
      live.getSessionData().config.thinkingLevel = thinkingLevel;
      await live.applyThinkingLevel();
    }
    await deps.notify(snapshot.id).catch(() => {});
  }
  return { value: target };
}

function projectUpdate(target: Target, input: Input, deps: RuntimeSettingsDependencies) {
  const after = readRuntimeSettings(target.snapshot.id, { source: 'rpc' }, deps);
  if (!after.ok) return { ok: false, reason: after.reason } as Failure;
  const notes = [
    target.live
      ? 'settings applied while idle; the next turn uses them'
      : 'settings persisted; the session starts under it next time',
  ];
  if (
    input.thinkingLevel !== undefined &&
    PROVIDER_THINKING_MODES[after.settings.provider as Provider] === 'off'
  )
    notes.push('thinking level recorded as a no-op: provider has no thinking controls');
  return {
    ok: true as const,
    settings: after.settings,
    appliesFrom: 'next-turn' as const,
    changes: {
      model: input.model !== undefined,
      provider:
        input.provider !== undefined ||
        (input.model !== undefined &&
          after.settings.provider !==
            (JSON.parse(target.snapshot.config) as Session['config']).provider),
      thinkingLevel: input.thinkingLevel !== undefined,
    },
    notes,
  };
}

const updateSettings = (superpipe({})('session.runtimeSettings.update') as PipelineAPI)
  .input(['input', 'caller', 'deps'])
  .pipe(captureTarget, ['input', 'caller', 'deps'], 'result:update')
  .pipe(gateReady, ['update', 'input', 'deps'], 'result:update')
  .pipe(resolveSettings, ['update', 'input'], 'result:update')
  .pipe(gateHarness, ['update', 'deps'], 'result:update')
  .pipe(validatePair, 'update', 'result:update')
  .pipe(applySettings, ['update', 'caller', 'deps'], 'result:update')
  .pipe(projectUpdate, ['update', 'input', 'deps'], 'update')
  .endAsync('update') as (
  input: Input,
  caller: OperationCaller,
  deps: RuntimeSettingsDependencies
) => Promise<Failure | ReturnType<typeof projectUpdate>>;

export function createSessionRuntimeSettingsOperations(deps: RuntimeSettingsDependencies) {
  const reads = createSessionRuntimeSettingsReadOperations(deps);
  return [
    ...reads,
    defineOperation({
      name: 'session.runtimeSettings.update',
      policy: { safetyClass: 'mutate', roles: ['long_term_agent', 'neo'] },
      description:
        'Change model, provider or thinking level only while the target is idle; a thinking-only change also reaches an idle session whose query is still running. Active, starting, queued and waiting work is refused without interruption. An original-snapshot atomic write protects concurrent changes. The next turn uses the accepted settings; cold sessions start under them next time.',
      inputSchema: InputSchema,
      resultSchema: z.union([
        z.object({
          ok: z.literal(false),
          reason: z.string(),
          availableModels: z.array(z.string()).optional(),
        }),
        reads[0].resultSchema.and(
          z.object({
            ok: z.literal(true),
            appliesFrom: z.literal('next-turn'),
            changes: z.object({
              model: z.boolean(),
              provider: z.boolean(),
              thinkingLevel: z.boolean(),
            }),
            notes: z.array(z.string()),
          })
        ),
      ]),
      execute: (input: Input, caller: OperationCaller) => updateSettings(input, caller, deps),
    }),
  ];
}
