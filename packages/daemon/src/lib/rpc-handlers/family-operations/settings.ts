import type { GlobalSettings, ModelInfo } from '@hyperneo/shared';
import { z } from 'zod';
import { findInModels, getAvailableModels } from '../../model-service.ts';
import { defineOperation, type OperationDefinition } from '../../operations/registry.ts';
import { sanitizeGlobalSettings } from '../settings-handlers.ts';
import type { FamilyOperationContext } from './context.ts';

export interface DefaultModelDeps {
  readonly read: () => Pick<GlobalSettings, 'model' | 'modelProvider'>;
  readonly write: (model: string, provider: string) => void;
  readonly models: () => readonly ModelInfo[];
}

const ModelEntry = z.object({ id: z.string(), name: z.string(), provider: z.string() });
const DefaultModel = z.object({
  model: z.string().nullable(),
  provider: z.string().nullable(),
  availableModels: z.array(ModelEntry),
});
const SetInput = z.object({
  model: z.string().min(1),
  provider: z.string().min(1).optional(),
});

function usableModels(deps: DefaultModelDeps, provider?: string): ModelInfo[] {
  return deps
    .models()
    .filter((entry) => entry.available !== false && (!provider || entry.provider === provider));
}

export function readDefaultModel(deps: DefaultModelDeps): z.infer<typeof DefaultModel> {
  const settings = deps.read();
  return {
    model: settings.model ?? null,
    provider: settings.modelProvider ?? null,
    availableModels: usableModels(deps).map(({ id, name, provider }) => ({ id, name, provider })),
  };
}

export function setDefaultModel(input: z.infer<typeof SetInput>, deps: DefaultModelDeps) {
  const usable = usableModels(deps, input.provider);
  const found = findInModels(usable, input.model);
  if (!found)
    return {
      ok: false as const,
      reason: 'model_unavailable' as const,
      availableModels: readDefaultModel(deps).availableModels,
    };
  const before = deps.read();
  deps.write(found.id, found.provider);
  const after = deps.read();
  return {
    ok: true as const,
    previous: { model: before.model ?? null, provider: before.modelProvider ?? null },
    model: after.model ?? null,
    provider: after.modelProvider ?? null,
  };
}

export function createDefaultModelOperations(deps: DefaultModelDeps): OperationDefinition[] {
  return [
    defineOperation({
      name: 'settings.model.get',
      description:
        'Read the default model and provider new sessions start on, and the models available to choose from. Credentials and other settings are not included.',
      inputSchema: z.object({}),
      resultSchema: DefaultModel,
      policy: { safetyClass: 'read', roles: ['neo'] },
      execute: async () => readDefaultModel(deps),
    }),
    defineOperation({
      name: 'settings.model.set',
      description:
        'Change the default model new sessions start on, and its provider. Only models listed by settings.model.get are accepted; anything else rejects with model_unavailable and the available models, so the human can add the missing provider in Settings. Existing sessions keep their model. Changes nothing else.',
      inputSchema: SetInput,
      resultSchema: z.union([
        z.object({
          ok: z.literal(false),
          reason: z.literal('model_unavailable'),
          availableModels: z.array(ModelEntry),
        }),
        z.object({
          ok: z.literal(true),
          previous: z.object({ model: z.string().nullable(), provider: z.string().nullable() }),
          model: z.string().nullable(),
          provider: z.string().nullable(),
        }),
      ]),
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input) => setDefaultModel(input, deps),
    }),
  ];
}

export function registerSettingsOperations(context: FamilyOperationContext): OperationDefinition[] {
  const { settingsManager, internalEventBus, credentialManager } = context.deps;
  return createDefaultModelOperations({
    read: () => settingsManager.getGlobalSettings(),
    write: (model, provider) => {
      const updated = settingsManager.updateGlobalSettings({ model, modelProvider: provider });
      internalEventBus.publishAsync('settings.updated', {
        namespaceId: 'global',
        settings: sanitizeGlobalSettings(updated, credentialManager),
      });
    },
    models: () => getAvailableModels('global'),
  });
}
