import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { ProviderRecord } from '@hyperneo/shared';
import {
  disableBuiltInProvidersWithoutEnabledRecord,
  ensureBuiltInProviderRegistered,
  initializeProviders,
  registerBuiltInProvider,
  resetProviderFactory,
  setCopilotProviderModuleImporter,
  waitForOptionalProviderRegistration,
} from '../../../../src/lib/providers/factory';
import { getProviderRegistry, resetProviderRegistry } from '../../../../src/lib/providers/registry';
import type * as CopilotModule from '../../../../src/lib/providers/anthropic-copilot/index';

class StubCopilotProvider {
  readonly id = 'anthropic-copilot' as const;
}

function installStubCopilotModule(): void {
  setCopilotProviderModuleImporter(
    async () =>
      ({ AnthropicToCopilotBridgeProvider: StubCopilotProvider }) as unknown as typeof CopilotModule
  );
}

function record(providerId: string, overrides: Partial<ProviderRecord> = {}): ProviderRecord {
  return {
    id: `row-${providerId}`,
    providerId,
    displayName: providerId,
    kind: 'built_in',
    authType: 'api_key',
    isEnabled: true,
    isDefault: false,
    sortOrder: 0,
    healthStatus: 'unknown',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('disableBuiltInProvidersWithoutEnabledRecord', () => {
  beforeEach(() => {
    resetProviderFactory();
    resetProviderRegistry();
  });
  afterEach(() => {
    resetProviderFactory();
    resetProviderRegistry();
  });

  it('registers only built-in providers that have an enabled row', () => {
    disableBuiltInProvidersWithoutEnabledRecord([
      record('glm'),
      record('kimi', { isEnabled: false }),
      record('custom:anthropic', { kind: 'custom_endpoint' }),
    ]);

    initializeProviders();

    const registered = getProviderRegistry()
      .getAll()
      .map((provider) => provider.id);
    expect(registered).toEqual(['glm']);
  });

  it('lets a provider added later register again', async () => {
    disableBuiltInProvidersWithoutEnabledRecord([]);
    initializeProviders();
    expect(getProviderRegistry().has('anthropic')).toBe(false);

    await ensureBuiltInProviderRegistered('anthropic');

    expect(getProviderRegistry().has('anthropic')).toBe(true);
  });

  it('registers no built-in provider when there are no rows', async () => {
    installStubCopilotModule();
    disableBuiltInProvidersWithoutEnabledRecord([]);

    const registry = initializeProviders();
    await waitForOptionalProviderRegistration(registry, true);

    expect(registry.getAll().map((provider) => provider.id)).toEqual([]);
  });

  it('lets a login register a rowless Copilot provider', async () => {
    installStubCopilotModule();
    disableBuiltInProvidersWithoutEnabledRecord([]);
    const registry = initializeProviders();

    await registerBuiltInProvider(registry, 'anthropic-copilot');

    expect(registry.has('anthropic-copilot')).toBe(true);
  });
});
