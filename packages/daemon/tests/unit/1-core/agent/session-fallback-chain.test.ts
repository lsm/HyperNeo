import { describe, expect, it, mock } from 'bun:test';
import type { FallbackModelEntry, GlobalSettings } from '@hyperneo/shared';
import { sessionFallbackChain } from '../../../../src/lib/agent/fallback-recovery';
import type { ProcessingStateManager } from '../../../../src/lib/agent/processing-state-manager';
import { RateLimitWatchdog } from '../../../../src/lib/agent/rate-limit-watchdog';

const neoFallback = { provider: 'glm', model: 'glm-5.1', thinkingLevel: 'off' as const };
const frontFallback = { provider: 'minimax', model: 'm2', thinkingLevel: 'off' as const };
const globalFallback: FallbackModelEntry = { provider: 'deepseek', model: 'v4' };
const settings = {
  fallbackModels: [globalFallback],
  neo: {
    preferences: {
      provider: 'anthropic',
      model: 'opus',
      thinkingLevel: 'high' as const,
      fallbacks: [{ ...neoFallback, autoCompactPercent: 80 }],
    },
    front: {
      model: {
        provider: 'anthropic',
        model: 'haiku',
        thinkingLevel: 'off' as const,
        fallbacks: [frontFallback],
      },
    },
  },
} as unknown as GlobalSettings;
const ids = { frontSessionId: 'front-1' };

function stateManager(): ProcessingStateManager {
  return {
    getState: mock(() => ({ status: 'idle' })),
    setRateLimitCooldown: mock(async () => {}),
    setIdle: mock(async () => {}),
  } as unknown as ProcessingStateManager;
}

async function firstSwitch(sessionId: string, current: { provider: string; model: string }) {
  const switchAndRetry = mock(async (_msg: unknown, _entry: FallbackModelEntry) => true);
  const watchdog = new RateLimitWatchdog(
    sessionId,
    stateManager(),
    {
      getCurrentModel: () => current,
      resolveChain: async () => sessionFallbackChain({ ...ids, sessionId }, settings, current),
      isEntryAvailable: async () => true,
      switchAndRetry,
      notifyPause: () => {},
      notifyResume: () => {},
    },
    { maxAutoRetries: 3 }
  );
  expect(await watchdog.scheduleRetry('429 usage limit', { uuid: 'm1', content: 'hi' })).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return switchAndRetry.mock.calls[0]?.[1];
}

describe('sessionFallbackChain', () => {
  it("switches the root Neo to Neo's first saved fallback on a usage limit", async () => {
    expect(await firstSwitch('neo:root', { provider: 'anthropic', model: 'opus' })).toEqual(
      neoFallback
    );
  });

  it("switches the front to the front's first saved fallback on a usage limit", async () => {
    expect(await firstSwitch('front-1', { provider: 'anthropic', model: 'haiku' })).toEqual(
      frontFallback
    );
  });

  it('keeps the global chain for any other session', async () => {
    expect(await firstSwitch('worker-1', { provider: 'anthropic', model: 'opus' })).toEqual(
      globalFallback
    );
  });
});
