import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import type { ModelInfo } from '@hyperneo/shared';
import {
  clearModelsCache,
  getAvailableModels,
  hasRefreshBeenAttemptedFor,
  markProviderRefreshSucceeded,
} from '../../../../src/lib/model-service';
import { resetProviderFactory } from '../../../../src/lib/providers/factory';
import {
  getProviderFailure,
  resetProviderFailureStore,
} from '../../../../src/lib/providers/provider-failure-store';
import { getProviderRegistry, resetProviderRegistry } from '../../../../src/lib/providers/registry';

describe('model-service settlement + fold pins', () => {
  type ProviderLike = Parameters<ReturnType<typeof getProviderRegistry>['register']>[0];

  function stubModel(providerId: string, id: string): ModelInfo {
    return {
      id,
      name: id,
      alias: id,
      family: providerId,
      provider: providerId,
      contextWindow: 128000,
      description: `${id} via ${providerId}`,
      releaseDate: '2026-01-01',
      available: true,
    };
  }

  function registerStubProvider(
    id: string,
    getModels: () => Promise<ModelInfo[]>,
    options?: {
      isAvailable?: () => Promise<boolean>;
      listRemoteModels?: () => Promise<ModelInfo[]>;
    }
  ): { getModels: ReturnType<typeof mock> } {
    const getModelsMock = mock(getModels);
    getProviderRegistry().register({
      id,
      displayName: id,
      isAvailable: options?.isAvailable ?? (async () => true),
      getModels: getModelsMock,
      ...(options?.listRemoteModels ? { listRemoteModels: options.listRemoteModels } : {}),
      ownsModel: () => true,
      getModelForTier: () => undefined,
      buildSdkConfig: () => ({ envVars: {}, isAnthropicCompatible: false }),
    } as unknown as ProviderLike);
    return { getModels: getModelsMock };
  }

  async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
  }

  beforeEach(() => {
    clearModelsCache();
    resetProviderRegistry();
    resetProviderFactory();
    resetProviderFailureStore();
  });

  afterEach(() => {
    clearModelsCache();
    resetProviderRegistry();
    resetProviderFactory();
    resetProviderFailureStore();
  });

  describe('applyProviderLoadOutcome settlement', () => {
    it('drops failure and retry state for providers no longer in the registry', async () => {
      const { refreshModels } = await import('../../../../src/lib/model-service');
      registerStubProvider('glm', async () => {
        throw new Error('Endpoint returned HTTP 503');
      });
      await refreshModels();
      expect(getProviderFailure('glm')?.errorKind).toBe('transient');
      expect(hasRefreshBeenAttemptedFor('glm')).toBe(true);

      getProviderRegistry().unregister('glm');
      registerStubProvider('stub-ok', async () => [stubModel('stub-ok', 'stub-model')]);
      await refreshModels();

      expect(getProviderFailure('glm')).toBeUndefined();
      expect(hasRefreshBeenAttemptedFor('glm')).toBe(false);
      expect(getProviderFailure('stub-ok')).toBeUndefined();
    });

    it('clears a recorded failure and armed retry once the provider loads', async () => {
      const { refreshModels } = await import('../../../../src/lib/model-service');
      let failing = true;
      registerStubProvider('glm', async () => {
        if (failing) throw new Error('Endpoint returned HTTP 503');
        return [stubModel('glm', 'glm-5-live')];
      });
      await refreshModels();
      expect(getProviderFailure('glm')?.errorKind).toBe('transient');
      expect(hasRefreshBeenAttemptedFor('glm')).toBe(true);

      failing = false;
      await refreshModels();

      expect(getProviderFailure('glm')).toBeUndefined();
      expect(hasRefreshBeenAttemptedFor('glm')).toBe(false);
      expect(getAvailableModels('global').some((m) => m.id === 'glm-5-live')).toBe(true);
    });

    it('arms a scheduled retry timer for a transient failure', async () => {
      const { refreshModels } = await import('../../../../src/lib/model-service');
      jest.useFakeTimers();
      try {
        const { getModels } = registerStubProvider('glm', async () => {
          throw new Error('Endpoint returned HTTP 503');
        });
        await refreshModels();
        expect(getModels).toHaveBeenCalledTimes(1);
        expect(hasRefreshBeenAttemptedFor('glm')).toBe(true);

        jest.advanceTimersByTime(60_001);
        await flushMicrotasks();
        expect(getModels).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
    });

    it('cancels a pending transient retry once the failure is classified as permanent', async () => {
      const { refreshModels } = await import('../../../../src/lib/model-service');
      jest.useFakeTimers();
      try {
        let message = 'Endpoint returned HTTP 503';
        const { getModels } = registerStubProvider('glm', async () => {
          throw new Error(message);
        });
        await refreshModels();
        expect(getProviderFailure('glm')?.errorKind).toBe('transient');

        message = 'Request failed (http 401)';
        await refreshModels();
        expect(getProviderFailure('glm')?.errorKind).toBe('credential');

        jest.advanceTimersByTime(180_001);
        await flushMicrotasks();
        expect(getModels).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
    });

    it('marks succeeded providers so an in-flight older probe is discarded', async () => {
      const { refreshModels } = await import('../../../../src/lib/model-service');
      jest.useFakeTimers();
      try {
        let calls = 0;
        let releaseProbe: ((models: ModelInfo[]) => void) | null = null;
        registerStubProvider('glm', async () => {
          calls += 1;
          if (calls === 1) throw new Error('Endpoint returned HTTP 503');
          if (calls === 2) {
            return new Promise<ModelInfo[]>((resolve) => {
              releaseProbe = resolve;
            });
          }
          return [stubModel('glm', 'glm-5-foreground')];
        });

        await refreshModels();
        expect(getProviderFailure('glm')?.errorKind).toBe('transient');

        jest.advanceTimersByTime(60_001);
        await flushMicrotasks();
        expect(calls).toBe(2);

        await refreshModels();
        expect(getProviderFailure('glm')).toBeUndefined();
        expect(getAvailableModels('global').some((m) => m.id === 'glm-5-foreground')).toBe(true);

        releaseProbe?.([stubModel('glm', 'glm-5-stale')]);
        await flushMicrotasks();

        expect(
          getAvailableModels('global')
            .filter((m) => m.provider === 'glm')
            .map((m) => m.id)
        ).toEqual(['glm-5-foreground']);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('loadModelsFromProviders fold', () => {
    it('classifies provider results as failed, unavailable, or loaded in one pass', async () => {
      const { refreshModels } = await import('../../../../src/lib/model-service');
      registerStubProvider('glm', async () => {
        throw new Error('Endpoint returned HTTP 503');
      });
      registerStubProvider(
        'stub-unavailable',
        async () => [stubModel('stub-unavailable', 'unavailable-model')],
        { isAvailable: async () => false }
      );
      registerStubProvider('stub-loaded', async () => [stubModel('stub-loaded', 'loaded-model')]);

      await refreshModels();

      const models = getAvailableModels('global');
      expect(models.some((m) => m.id === 'loaded-model')).toBe(true);
      expect(getProviderFailure('stub-loaded')).toBeUndefined();
      expect(models.some((m) => m.provider === 'stub-unavailable')).toBe(false);
      expect(getProviderFailure('stub-unavailable')).toBeUndefined();
      expect(hasRefreshBeenAttemptedFor('stub-unavailable')).toBe(false);
      expect(getProviderFailure('glm')).toEqual(
        expect.objectContaining({ errorKind: 'transient' })
      );
      expect(hasRefreshBeenAttemptedFor('glm')).toBe(true);
      expect(models.some((m) => m.provider === 'glm')).toBe(true);
    });

    it('skips a superseded provider result in favor of the cached slice', async () => {
      const { refreshModels } = await import('../../../../src/lib/model-service');
      let stall = false;
      let releaseGlm: ((models: ModelInfo[]) => void) | null = null;
      registerStubProvider('glm', async () => {
        if (!stall) return [stubModel('glm', 'glm-5-first')];
        return new Promise<ModelInfo[]>((resolve) => {
          releaseGlm = resolve;
        });
      });
      registerStubProvider('stub-ok', async () => [stubModel('stub-ok', 'stub-model')]);

      await refreshModels();
      expect(getAvailableModels('global').some((m) => m.id === 'glm-5-first')).toBe(true);

      stall = true;
      const foreground = refreshModels();
      while (!releaseGlm) {
        await Promise.resolve();
      }
      markProviderRefreshSucceeded('glm');
      releaseGlm?.([stubModel('glm', 'glm-5-stale')]);
      await foreground;

      expect(
        getAvailableModels('global')
          .filter((m) => m.provider === 'glm')
          .map((m) => m.id)
      ).toEqual(['glm-5-first']);
      expect(getAvailableModels('global').some((m) => m.id === 'stub-model')).toBe(true);
    });

    it('propagates the first strict discovery failure when several strict providers fail', async () => {
      const { refreshModels } = await import('../../../../src/lib/model-service');
      registerStubProvider('strict-a', async () => [], {
        listRemoteModels: async () => {
          throw new Error('strict-a discovery failed');
        },
      });
      registerStubProvider('strict-b', async () => [], {
        listRemoteModels: async () => {
          throw new Error('strict-b discovery failed');
        },
      });

      await expect(refreshModels(undefined, { forceRemote: true })).rejects.toThrow(
        'strict-a discovery failed'
      );
      expect(getProviderFailure('strict-a')).toEqual(
        expect.objectContaining({ message: 'strict-a discovery failed' })
      );
      expect(getProviderFailure('strict-b')).toEqual(
        expect.objectContaining({ message: 'strict-b discovery failed' })
      );
    });
  });
});
