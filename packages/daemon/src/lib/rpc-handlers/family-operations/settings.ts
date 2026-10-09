import type { GlobalSettings, ModelInfo } from '@hyperneo/shared';
import { z } from 'zod';
import { findInModels, getAvailableModels } from '../../model-service.ts';
import {
  defineOperation,
  type OperationCaller,
  type OperationDefinition,
} from '../../operations/registry.ts';
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
const NeoOnly = z.object({ ok: z.literal(false), reason: z.literal('neo_only') });
const NEO_ONLY = { ok: false as const, reason: 'neo_only' as const };
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

export function admitDefaultModelCaller(caller: OperationCaller): boolean {
  return caller.source !== 'mcp' || caller.role === 'neo';
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
  const offers = usable.filter((entry) => entry.id === found.id);
  if (!input.provider && new Set(offers.map((entry) => entry.provider)).size > 1)
    return {
      ok: false as const,
      reason: 'provider_required' as const,
      availableModels: offers.map(({ id, name, provider }) => ({ id, name, provider })),
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
        'Read the default model and provider new sessions start on, and the models available to choose from. Credentials and other settings are not included. Only Neo and the local app may call it.',
      inputSchema: z.object({}).default({}),
      resultSchema: z.union([NeoOnly, DefaultModel]),
      policy: { safetyClass: 'read', roles: ['neo'] },
      execute: async (_input, caller) =>
        admitDefaultModelCaller(caller) ? readDefaultModel(deps) : NEO_ONLY,
    }),
    defineOperation({
      name: 'settings.model.set',
      description:
        'Change the default model new sessions start on, and its provider. Only models listed by settings.model.get are accepted; anything else rejects with model_unavailable and the available models, so the human can add the missing provider in Settings. When more than one provider offers the model, pass provider; without it the call rejects with provider_required and the offers. Existing sessions keep their model. Only Neo and the local app may call it; other sessions reject with neo_only. Changes nothing else.',
      inputSchema: SetInput,
      resultSchema: z.union([
        NeoOnly,
        z.object({
          ok: z.literal(false),
          reason: z.enum(['model_unavailable', 'provider_required']),
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
      execute: async (input, caller) =>
        admitDefaultModelCaller(caller) ? setDefaultModel(input, deps) : NEO_ONLY,
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
