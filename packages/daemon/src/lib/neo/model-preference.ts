import type { ModelInfo } from '@hyperneo/shared';
import type { NeoModelPreference } from '@hyperneo/shared/types/settings';
import { findSameModel, resolveAutoCompactPercent, normalizeThinkingLevel } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { getAvailableModels } from '../model-service.ts';
import { requireLocalUser } from '../operations/caller.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import type { NeoService } from './service.ts';

type Rejection = { ok: false; reason: string };
type Gate<T> = { value: T } | { reason: Rejection };
type RuntimeConfig = { model?: string; provider?: string; thinkingLevel?: string };

const ModelPreference = z.object({
  model: z.string().trim().min(1).max(200),
  provider: z.string().trim().min(1).max(80),
  thinkingLevel: z.string().trim().min(1).max(40),
});
const ModelEntry = ModelPreference.extend({
  autoCompactPercent: z.number().int().transform(resolveAutoCompactPercent).optional(),
});
const PreferenceInput = ModelEntry.extend({
  fallbacks: z.array(ModelEntry).max(10).optional(),
});
const PreferenceResult = z.union([
  z.object({ ok: z.literal(false), reason: z.string() }),
  z.object({
    ok: z.literal(true),
    preferences: PreferenceInput,
  }),
]);

export function requireNeoPreferenceModel(
  input: z.infer<typeof PreferenceInput>,
  catalog: { models: readonly ModelInfo[] }
): Gate<NeoModelPreference> {
  const entries = [];
  for (const entry of [input, ...(input.fallbacks ?? [])]) {
    const model = findSameModel(catalog.models, entry);
    if (!model)
      return {
        reason: {
          ok: false,
          reason: `invalid_model: ${entry.provider}/${entry.model} is not available.`,
        },
      };
    entries.push({
      model: entry.model,
      provider: model.provider,
      thinkingLevel: normalizeThinkingLevel(entry.thinkingLevel),
      ...(entry.autoCompactPercent === undefined
        ? {}
        : { autoCompactPercent: entry.autoCompactPercent }),
    });
  }
  return {
    value: {
      ...entries[0],
      ...(input.fallbacks === undefined ? {} : { fallbacks: entries.slice(1) }),
    },
  };
}

export function neoCompactPercentFor(
  preference: NeoModelPreference,
  config: RuntimeConfig
): number | undefined {
  const entry = [preference, ...(preference.fallbacks ?? [])].find(
    (item) => item.model === config.model && item.provider === config.provider
  );
  return (entry ?? preference).autoCompactPercent;
}

export function effectiveNeoPreference(
  saved: NeoModelPreference | undefined,
  root: RuntimeConfig | null,
  defaultThinking?: string
): (NeoModelPreference & { saved: boolean }) | null {
  if (saved)
    return { ...saved, thinkingLevel: normalizeThinkingLevel(saved.thinkingLevel), saved: true };
  if (!root?.model || !root.provider) return null;
  return {
    model: root.model,
    provider: root.provider,
    thinkingLevel: normalizeThinkingLevel(root.thinkingLevel ?? defaultThinking),
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
    .pipe(requireLocalUser, 'caller', 'result:admission')
    .pipe(() => ({ models: getAvailableModels('global') }), 'input', 'catalog')
    .pipe(requireNeoPreferenceModel, ['input', 'catalog'], 'result:admission')
    .pipe(
      async (input: NeoModelPreference) => {
        const fallbacks =
          input.fallbacks ?? service.db.getGlobalSettings().neo?.preferences?.fallbacks;
        const preferences = { ...input, ...(fallbacks === undefined ? {} : { fallbacks }) };
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
      'Set the primary model, provider and thinking level for Neo and its projects, for the user only. Optional fallbacks stores an ordered preference list; runtime recovery uses the ordinary session policy. An empty list clears saved fallbacks; omitting it preserves the saved chain. Optional autoCompactPercent, on the primary and on each fallback, is an integer clamped to 10–100; the entry for the model the Neo session runs writes the ordinary per-session context-budget setting, and omitting it restores model metadata/default. Percentage changes apply at idle.',
    inputSchema: PreferenceInput,
    resultSchema: PreferenceResult,
    policy: { safetyClass: 'human_only' },
    execute: set,
  });
}
