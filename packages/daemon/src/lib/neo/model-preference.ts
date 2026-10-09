import type { ModelInfo } from '@hyperneo/shared';
import type { NeoModelPreference } from '@hyperneo/shared/types/settings';
import {
  getThinkingLevelsForModel,
  normalizeThinkingLevel,
  THINKING_LEVELS,
  type ThinkingLevel,
} from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { getAvailableModels } from '../model-service.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import type { NeoService } from './service.ts';

type Rejection = { ok: false; reason: string };
type Gate<T> = { value: T } | { reason: Rejection };
type RuntimeConfig = { model?: string; provider?: string; thinkingLevel?: string };

const PreferenceInput = z.object({
  model: z.string().trim().min(1).max(200),
  provider: z.string().trim().min(1).max(80),
  thinkingLevel: z.string().trim().min(1).max(40),
});
const PreferenceResult = z.union([
  z.object({ ok: z.literal(false), reason: z.string() }),
  z.object({
    ok: z.literal(true),
    preferences: z.object({ model: z.string(), provider: z.string(), thinkingLevel: z.string() }),
  }),
]);

export function clampNeoThinking(
  levels: readonly ThinkingLevel[],
  requested: ThinkingLevel
): ThinkingLevel {
  if (levels.includes(requested)) return requested;
  const rank = THINKING_LEVELS.indexOf(requested);
  return [...levels].reverse().find((level) => THINKING_LEVELS.indexOf(level) <= rank) ?? 'off';
}

export function requireNeoUser(caller: OperationCaller): Gate<OperationCaller> {
  return caller.source === 'rpc' && caller.principal === 'local'
    ? { value: caller }
    : { reason: { ok: false, reason: 'This action needs the user.' } };
}

export function requireNeoPreferenceModel(
  input: z.infer<typeof PreferenceInput>,
  catalog: { models: readonly ModelInfo[] }
): Gate<NeoModelPreference> {
  const model = catalog.models.find(
    (item) => item.id === input.model && item.provider === input.provider
  );
  if (!model)
    return {
      reason: {
        ok: false,
        reason: `invalid_model: ${input.provider}/${input.model} is not available.`,
      },
    };
  const levels = getThinkingLevelsForModel(model.provider, model.thinkingModes, model.effortLevels);
  return {
    value: {
      model: model.id,
      provider: model.provider,
      thinkingLevel: clampNeoThinking(levels, normalizeThinkingLevel(input.thinkingLevel)),
    },
  };
}

export function effectiveNeoPreference(
  saved: NeoModelPreference | undefined,
  root: RuntimeConfig | null
): (NeoModelPreference & { saved: boolean }) | null {
  if (saved) return { ...saved, saved: true };
  if (!root?.model || !root.provider) return null;
  return {
    model: root.model,
    provider: root.provider,
    thinkingLevel: normalizeThinkingLevel(root.thinkingLevel),
    saved: false,
  };
}

export function planNeoAlignment(
  config: RuntimeConfig,
  preference: NeoModelPreference
): { model: boolean; thinking: boolean } | null {
  const model = config.model !== preference.model || config.provider !== preference.provider;
  const thinking = normalizeThinkingLevel(config.thinkingLevel) !== preference.thinkingLevel;
  return model || thinking ? { model, thinking } : null;
}

export function createNeoPreferenceOperation(service: NeoService) {
  const set = (superpipe({})('neo.preferences.set') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(requireNeoUser, 'caller', 'result:admission')
    .pipe(() => ({ models: getAvailableModels('global') }), 'input', 'catalog')
    .pipe(requireNeoPreferenceModel, ['input', 'catalog'], 'result:admission')
    .pipe(
      async (preferences: NeoModelPreference) => {
        await service.saveModelPreference(preferences);
        return { ok: true as const, preferences };
      },
      'admission',
      'admission'
    )
    .endAsync('admission') as (
    input: z.infer<typeof PreferenceInput>,
    caller: OperationCaller
  ) => Promise<z.infer<typeof PreferenceResult>>;
  return defineOperation({
    name: 'neo.preferences.set',
    description:
      'Set the model, provider and thinking level every Neo session uses (root Neo and each topic), for the user only. Thinking is clamped to what the model supports. Each session switches at its next idle point, never mid-turn; a session whose provider is unavailable keeps its current model.',
    inputSchema: PreferenceInput,
    resultSchema: PreferenceResult,
    policy: { safetyClass: 'human_only' },
    execute: set,
  });
}
