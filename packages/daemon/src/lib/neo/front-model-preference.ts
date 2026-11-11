import { resolveAutoCompactPercent, type NeoModelPreference } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { gatewayFor } from '../../storage/db-gateway/db-gateway.ts';
import { globalSettingsWrites } from '../../storage/repositories/global-settings-writes.ts';
import { getAvailableModels } from '../model-service.ts';
import { requireLocalUser } from '../operations/caller.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import { ModelPreference, requireNeoPreferenceModel } from './model-preference.ts';
import type { NeoService } from './service.ts';

const Input = ModelPreference.extend({
  autoCompactPercent: z.number().int().transform(resolveAutoCompactPercent).optional(),
}).strict();
const Saved = ModelPreference.extend({ autoCompactPercent: z.number().int().optional() }).strict();
const Result = z.union([
  z.object({ ok: z.literal(false), reason: z.string() }),
  z.object({ ok: z.literal(true), preferences: Saved }),
]);

export function createNeoFrontModelOperation(service: NeoService) {
  const set = (superpipe({})('neo.front.model.set') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(requireLocalUser, 'caller', 'result:admission')
    .pipe(
      () => ({ models: getAvailableModels('global').filter((model) => model.available !== false) }),
      'admission',
      'catalog'
    )
    .pipe(requireNeoPreferenceModel, ['input', 'catalog'], 'result:admission')
    .pipe(
      async (preferences: NeoModelPreference) => {
        const settings = await gatewayFor(service.db.getDatabase()).call(
          globalSettingsWrites,
          'neoFrontModel',
          preferences
        );
        service.publishSettings?.(settings);
        service.notifyChanged();
        return { ok: true as const, preferences: settings.neo!.front!.model! };
      },
      'admission',
      'admission'
    )
    .endAsync('admission') as (
    input: z.infer<typeof Input>,
    caller: OperationCaller
  ) => Promise<z.infer<typeof Result>>;
  return defineOperation({
    name: 'neo.front.model.set',
    description: 'Choose the separate provider and model for fast replies.',
    inputSchema: Input,
    resultSchema: Result,
    policy: { safetyClass: 'human_only' },
    execute: set,
  });
}
