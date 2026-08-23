import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import type * as CopilotModule from '../../../../src/lib/providers/anthropic-copilot/index';
import {
  ensureBuiltInProviderRegistered,
  markBuiltInProviderDisabled,
  registerBuiltInProvider,
  resetProviderFactory,
  setCopilotProviderModuleImporter,
  waitForOptionalProviderRegistration,
} from '../../../../src/lib/providers/factory';
import { getProviderRegistry, resetProviderRegistry } from '../../../../src/lib/providers/registry';

class StubCopilotProvider {
  readonly id = 'anthropic-copilot' as const;
}

function stubCopilotModule(): typeof CopilotModule {
  return {
    AnthropicToCopilotBridgeProvider: StubCopilotProvider,
  } as unknown as typeof CopilotModule;
}

function installImporter(failing: () => boolean) {
  let attempts = 0;
  setCopilotProviderModuleImporter(async () => {
    attempts += 1;
    if (failing()) throw new Error('transient import failure');
    return stubCopilotModule();
  });
  return () => attempts;
}

describe('copilot provider import retry', () => {
  beforeEach(() => {
    resetProviderFactory();
    resetProviderRegistry();
  });
  afterEach(() => {
    jest.useRealTimers();
    resetProviderFactory();
    resetProviderRegistry();
  });

  it('registers the provider when an automatic retry after the backoff window succeeds', async () => {
    let failing = true;
    const attempts = installImporter(() => failing);
    const registry = getProviderRegistry();

    await waitForOptionalProviderRegistration(registry);
    expect(attempts()).toBe(1);
    expect(registry.has('anthropic-copilot')).toBe(false);

    await waitForOptionalProviderRegistration(registry);
    expect(attempts()).toBe(1);
    expect(registry.has('anthropic-copilot')).toBe(false);

    failing = false;
    jest.useFakeTimers();
    try {
      jest.setSystemTime(Date.now() + 120_000);
      await waitForOptionalProviderRegistration(registry);
    } finally {
      jest.useRealTimers();
    }
    expect(attempts()).toBe(2);
    expect(registry.has('anthropic-copilot')).toBe(true);
    expect(registry.get('anthropic-copilot')).toBeInstanceOf(StubCopilotProvider);
  });

  it('does not re-import the module once an attempt has succeeded', async () => {
    const attempts = installImporter(() => false);
    const registry = getProviderRegistry();

    await waitForOptionalProviderRegistration(registry);
    await waitForOptionalProviderRegistration(registry);
    expect(attempts()).toBe(1);
    expect(registry.has('anthropic-copilot')).toBe(true);
  });

  it('forces an immediate retry when re-enabling the provider after a failure', async () => {
    let failing = true;
    const attempts = installImporter(() => failing);

    await ensureBuiltInProviderRegistered('anthropic-copilot');
    expect(attempts()).toBe(1);
    expect(getProviderRegistry().has('anthropic-copilot')).toBe(false);

    failing = false;
    await ensureBuiltInProviderRegistered('anthropic-copilot');
    expect(attempts()).toBe(2);
    expect(getProviderRegistry().has('anthropic-copilot')).toBe(true);
    expect(getProviderRegistry().get('anthropic-copilot')).toBeInstanceOf(StubCopilotProvider);
  });

  it('forces an immediate retry for explicit registration requests during the backoff window', async () => {
    let failing = true;
    const attempts = installImporter(() => failing);
    const registry = getProviderRegistry();

    await waitForOptionalProviderRegistration(registry);
    expect(attempts()).toBe(1);

    failing = false;
    await registerBuiltInProvider(registry, 'anthropic-copilot');
    expect(attempts()).toBe(2);
    expect(registry.has('anthropic-copilot')).toBe(true);
  });

  it('does not register the provider when it is disabled while an import is in flight', async () => {
    let releaseImport: ((mod: typeof CopilotModule) => void) | undefined;
    setCopilotProviderModuleImporter(
      () =>
        new Promise((resolve) => {
          releaseImport = (mod) => resolve(mod);
        })
    );
    const registry = getProviderRegistry();

    const pending = waitForOptionalProviderRegistration(registry);
    await new Promise((resolve) => setTimeout(resolve, 0));
    markBuiltInProviderDisabled('anthropic-copilot');
    releaseImport?.(stubCopilotModule());
    await pending;

    expect(registry.has('anthropic-copilot')).toBe(false);
  });
});
