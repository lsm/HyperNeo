import { afterEach, describe, expect, it, mock } from 'bun:test';
import type { MessageContent, MessageHub, Session } from '@hyperneo/shared';
import type { SDKMessage, SDKUserMessage } from '@hyperneo/shared/sdk';
import type { ContextTracker } from '../../../../src/lib/agent/context-tracker';
import { reserveBasedThreshold } from '../../../../src/lib/agent/context-tracker';
import { MessageQueue } from '../../../../src/lib/agent/message-queue';
import type { ProcessingStateManager } from '../../../../src/lib/agent/processing-state-manager';
import type { QueryLifecycleManager } from '../../../../src/lib/agent/query-lifecycle-manager';
import {
  buildProviderSettings,
  NATIVE_CONTEXT_WINDOW_PROVIDER_IDS,
  PROVIDER_NO_SDK_AUTO_COMPACT,
} from '../../../../src/lib/agent/query-options-builder';
import { QueryRunner, type QueryRunnerContext } from '../../../../src/lib/agent/query-runner';
import {
  SDKMessageHandler,
  type SDKMessageHandlerContext,
} from '../../../../src/lib/agent/sdk-message-handler';
import type { ErrorManager } from '../../../../src/lib/error-manager';
import type {
  DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus';
import { setModelsCache } from '../../../../src/lib/model-service';
import {
  codexBackendContextWindow,
  getModelContextWindow,
  MODEL_CONTEXT_WINDOWS,
} from '../../../../src/lib/providers/codex-models';
import { KimiProvider } from '../../../../src/lib/providers/kimi-provider';
import type { Database } from '../../../../src/storage/database';

describe('N1: native SDK auto-compaction is used (never disabled for kimi/codex)', () => {
  const CASES: Array<{
    label: string;
    provider: string;
    contextWindow: number;
    model: string;
    expected: 'native' | { autoCompactEnabled: true; autoCompactWindow: number };
  }> = [
    {
      label: 'kimi K2.7 (262144) — non-K3 id, full window armed',
      provider: 'kimi',
      contextWindow: 262_144,
      model: 'kimi-k2.7-code',
      expected: { autoCompactEnabled: true, autoCompactWindow: 262_144 },
    },
    {
      label: 'kimi K3 (1M) — armed with 1M window',
      provider: 'kimi',
      contextWindow: 1_048_576,
      model: 'kimi-k3',
      expected: { autoCompactEnabled: true, autoCompactWindow: 1_048_576 },
    },
    {
      label: 'kimi K3 256K variant — armed with its 256K window (not 1M)',
      provider: 'kimi',
      contextWindow: 262_144,
      model: 'k3-256k',
      expected: { autoCompactEnabled: true, autoCompactWindow: 262_144 },
    },
    {
      label: 'codex gpt-5.5 (272000) — native, no override',
      provider: 'anthropic-codex',
      contextWindow: 272_000,
      model: 'gpt-5.5',
      expected: 'native',
    },
    {
      label: 'codex-mini (128000) — native, no override',
      provider: 'anthropic-codex',
      contextWindow: 128_000,
      model: 'gpt-5.4-mini',
      expected: 'native',
    },
  ];

  it.each(CASES.map((c) => [c.label, c] as const))('%s', (_label, c) => {
    const settings = buildProviderSettings(c.provider, c.contextWindow, c.model);
    if (c.expected === 'native') {
      expect(settings).toBeUndefined();
    } else {
      expect(settings).toEqual(c.expected);
    }
  });

  it('never returns autoCompactEnabled:false for any Kimi or Codex model (C1 invariant)', () => {
    const kimiModels = KimiProvider.MODELS.map((m) => ({
      provider: 'kimi',
      model: m.id,
      window: m.contextWindow,
    }));
    const codexModels = (
      Object.keys(MODEL_CONTEXT_WINDOWS) as Array<keyof typeof MODEL_CONTEXT_WINDOWS>
    ).map((id) => ({ provider: 'anthropic-codex', model: id, window: MODEL_CONTEXT_WINDOWS[id] }));
    for (const { provider, model, window } of [...kimiModels, ...codexModels]) {
      const settings = buildProviderSettings(provider, window, model);
      expect(settings?.autoCompactEnabled, `${provider}/${model}`).not.toBe(false);
    }
  });

  it('keeps Kimi K3 native even when no context window is reported', () => {
    expect(buildProviderSettings('kimi', undefined, 'kimi-k3')).toEqual({
      autoCompactEnabled: true,
      autoCompactWindow: 1_048_576,
    });
  });
});

describe('N2: thresholds — active SDK window (kimi/codex) + dormant fallback reserve', () => {
  it('uses a 45k reserve for Kimi (K2.7 + K3) and a 33k reserve for Codex', () => {
    expect(reserveBasedThreshold(262_144, 'kimi')).toBe(262_144 - 45_000);
    expect(reserveBasedThreshold(1_048_576, 'kimi')).toBe(1_048_576 - 45_000);
    expect(reserveBasedThreshold(272_000, 'anthropic-codex')).toBe(272_000 - 33_000);
    expect(reserveBasedThreshold(128_000, 'anthropic-codex')).toBe(128_000 - 33_000);
  });

  it('uses the SDK-standard 33k reserve when no provider is given', () => {
    expect(reserveBasedThreshold(200_000)).toBe(200_000 - 33_000);
  });

  it('floors the threshold at 0 for non-positive / non-finite windows', () => {
    expect(reserveBasedThreshold(0, 'kimi')).toBe(0);
    expect(reserveBasedThreshold(-5, 'anthropic-codex')).toBe(0);
    expect(reserveBasedThreshold(Number.POSITIVE_INFINITY, 'kimi')).toBe(0);
    expect(reserveBasedThreshold(Number.NaN)).toBe(0);
  });

  it('Kimi reserve stays strictly larger than the Codex/default reserve at every window', () => {
    for (const window of [128_000, 200_000, 262_144, 272_000, 1_048_576]) {
      const kimi = reserveBasedThreshold(window, 'kimi');
      const codex = reserveBasedThreshold(window, 'anthropic-codex');
      expect(kimi, `window=${window}`).toBeLessThan(codex);
      expect(codex - kimi, `window=${window}`).toBe(45_000 - 33_000);
    }
  });

  it('the per-model Codex windows that feed CLAUDE_CODE_AUTO_COMPACT_WINDOW are the expected values', () => {
    const EXPECTED_WINDOWS: Record<string, number> = {
      'gpt-5.6-sol': 1_050_000,
      'gpt-5.6-terra': 1_050_000,
      'gpt-5.6-luna': 1_050_000,
      'gpt-5.5': 272_000,
      'gpt-5.3-codex': 272_000,
      'gpt-5.4': 272_000,
      'gpt-5.4-mini': 128_000,
    };
    expect(Object.keys(MODEL_CONTEXT_WINDOWS).sort()).toEqual(Object.keys(EXPECTED_WINDOWS).sort());
    for (const [id, window] of Object.entries(EXPECTED_WINDOWS)) {
      expect(getModelContextWindow(id), id).toBe(window);
    }
    expect(getModelContextWindow('codex-mini')).toBe(1_050_000);
    expect(getModelContextWindow('codex-latest')).toBe(1_050_000);
    expect(getModelContextWindow('codex-5.4-mini')).toBe(128_000);
  });

  it('codexBackendContextWindow caps GPT-5.6 at 272K for the ChatGPT Codex backend', () => {
    expect(codexBackendContextWindow('gpt-5.6-sol')).toBe(272_000);
    expect(codexBackendContextWindow('gpt-5.6-terra')).toBe(272_000);
    expect(codexBackendContextWindow('gpt-5.6-luna')).toBe(272_000);
    expect(codexBackendContextWindow('codex-mini')).toBe(272_000);
    expect(codexBackendContextWindow('codex-latest')).toBe(272_000);
    expect(codexBackendContextWindow('gpt-5.5')).toBe(272_000);
    expect(codexBackendContextWindow('gpt-5.4-mini')).toBe(128_000);
  });

  it('Kimi buildSdkConfig arms CLAUDE_CODE_AUTO_COMPACT_WINDOW per model (K2.7=262144, K3=1M)', () => {
    const provider = new KimiProvider({ KIMI_API_KEY: 'key' });
    expect(provider.buildSdkConfig('kimi-k2.7-code').envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe(
      '262144'
    );
    expect(provider.buildSdkConfig('kimi-k3').envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe(
      '1048576'
    );
    expect(provider.buildSdkConfig('k3-256k').envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe(
      '262144'
    );
  });

  it('the daemon arms Kimi models with their full windows (K3 1M, K2.7 262144)', () => {
    const k2Window = buildProviderSettings('kimi', 262_144, 'kimi-k2.7-code')?.autoCompactWindow;
    const k3Window = buildProviderSettings('kimi', 1_048_576, 'kimi-k3')?.autoCompactWindow;
    expect(k2Window).toBe(262_144);
    expect(k3Window).toBe(1_048_576);

    const SDK_FALLBACK_WINDOW = 200_000;
    const SDK_RESERVE = 33_000;
    const sdkEffectiveK27Threshold = SDK_FALLBACK_WINDOW - SDK_RESERVE;
    expect(sdkEffectiveK27Threshold).toBeLessThan(k2Window!);
    expect(k2Window!).toBeGreaterThan(SDK_FALLBACK_WINDOW);

    expect(buildProviderSettings('anthropic-codex', 272_000, 'gpt-5.5')).toBeUndefined();
    expect(reserveBasedThreshold(262_144, 'kimi')).toBe(262_144 - 45_000);
    expect(reserveBasedThreshold(1_048_576, 'kimi')).toBe(1_048_576 - 45_000);
  });
});

describe('N3: enforcement boundary — native providers untouched, fallback set stays empty', () => {
  it('PROVIDER_NO_SDK_AUTO_COMPACT is empty (no provider uses the async /compact fallback)', () => {
    expect(PROVIDER_NO_SDK_AUTO_COMPACT.size).toBe(0);
  });

  it('the four native context-window providers are exactly the documented set', () => {
    expect([...NATIVE_CONTEXT_WINDOW_PROVIDER_IDS].sort()).toEqual(
      ['anthropic', 'anthropic-codex', 'anthropic-copilot', 'glm'].sort()
    );
  });

  it.each([
    ['anthropic', 200_000],
    ['anthropic-copilot', 200_000],
    ['anthropic-codex', 272_000],
    ['glm', 1_000_000],
  ] as const)('%s ignores the configured window entirely (SDK keeps its own compaction)', (providerId, window) => {
    expect(buildProviderSettings(providerId, window)).toBeUndefined();
    expect(buildProviderSettings(providerId, window, 'any-model')).toBeUndefined();
  });
});

interface CompactionRefreshHarness {
  handler: SDKMessageHandler;
  enqueueSpy: ReturnType<typeof mock>;
  shouldCompactAtSpy: ReturnType<typeof mock>;
  markCompactionTriggeredSpy: ReturnType<typeof mock>;
  getContextUsageSpy: ReturnType<typeof mock>;
}

function driveCompactionRefresh(opts: {
  provider: string;
  model: string;
  contextWindow: number;
  totalUsed: number;
  sdkMaxTokens?: number;
  compactingActive?: boolean;
  cooldownActive?: boolean;
}): CompactionRefreshHarness {
  const session: Session = {
    id: 'compact-session',
    title: 'Compact Session',
    workspacePath: '/test/path',
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    status: 'active',
    config: { model: opts.model, maxTokens: 8192, temperature: 1.0, provider: opts.provider },
    metadata: {
      messageCount: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0,
      toolCallCount: 0,
    },
  };

  const enqueueSpy = mock(async () => 'context-id');
  const shouldCompactAtSpy = mock(() => true);
  const markCompactionTriggeredSpy = mock(() => {});

  const db = {
    saveSDKMessage: mock(() => true),
    updateSession: mock(() => {}),
    getUserMessagesByStatus: mock(() => ({ messages: [], total: 0 })),
    getMessageByStatusAndUuid: mock(() => null),
    updateMessageStatus: mock(() => {}),
    updateMessageTimestamp: mock(() => {}),
    beginTransaction: mock(() => {}),
    commitTransaction: mock(() => {}),
    abortTransaction: mock(() => {}),
  } as unknown as Database;

  const publish = mock(async () => {});
  const messageHub = {
    event: mock(() => {}),
    onRequest: mock(() => () => {}),
    query: mock(async () => ({})),
    command: mock(async () => {}),
  } as unknown as MessageHub;
  const internalEventBus = {
    publish,
    publishAsync: publish,
    subscribe: mock(() => () => {}),
  } as unknown as InternalEventBus<DaemonInternalEventMap>;

  const stateManager = {
    detectPhaseFromMessage: mock(async () => {}),
    beginTerminalIdle: mock(() => {}),
    setIdle: mock(async () => {}),
    setCompacting: mock(async () => {}),
    getIsCompacting: mock(() => opts.compactingActive ?? false),
    getState: mock(() => ({ phase: 'idle' })),
  } as unknown as ProcessingStateManager;

  const contextTracker = {
    getContextInfo: mock(() => ({ totalTokens: 1000, maxTokens: 128000 })),
    updateWithDetailedBreakdown: mock(() => {}),
    shouldCompact: mock(() => false),
    isCoolingDown: mock(() => opts.cooldownActive ?? false),
    shouldCompactAt: shouldCompactAtSpy,
    markCompactionTriggered: markCompactionTriggeredSpy,
  } as unknown as ContextTracker;

  const messageQueue = {
    enqueue: enqueueSpy,
    enqueueWithId: mock(async () => {}),
    clear: mock(() => {}),
    setDeliveryGate: mock(() => {}),
  } as unknown as MessageQueue;

  const errorManager = { handleError: mock(async () => {}) } as unknown as ErrorManager;
  const lifecycleManager = { stop: mock(async () => {}) } as unknown as QueryLifecycleManager;

  const getContextUsageSpy = mock(async () => ({
    categories: [{ name: 'Messages', tokens: opts.totalUsed }],
    totalTokens: opts.totalUsed,
    maxTokens: opts.sdkMaxTokens ?? opts.contextWindow,
    rawMaxTokens: opts.sdkMaxTokens ?? opts.contextWindow,
    percentage: Math.round((opts.totalUsed / (opts.contextWindow || 1)) * 100),
    gridRows: [],
    model: opts.model,
    memoryFiles: [],
    mcpTools: [],
    agents: [],
    isAutoCompactEnabled: true,
    apiUsage: null,
  }));

  const ctx: SDKMessageHandlerContext = {
    session,
    db,
    messageHub,
    internalEventBus,
    stateManager,
    contextTracker,
    messageQueue,
    errorManager,
    lifecycleManager,
    queryObject: { getContextUsage: getContextUsageSpy } as never,
    queryPromise: null,
    onInitSlashCommands: mock(async () => {}),
    onCommandsChanged: mock(async () => {}),
  };

  return {
    handler: new SDKMessageHandler(ctx),
    enqueueSpy,
    shouldCompactAtSpy,
    markCompactionTriggeredSpy,
    getContextUsageSpy,
  };
}

describe('N4: literal /compact never enters the transcript or provider request', () => {
  afterEach(() => {
    setModelsCache(new Map());
  });

  function resultMessage(): SDKMessage {
    return {
      type: 'result',
      subtype: 'success',
      uuid: 'result-uuid',
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      total_cost_usd: 0.001,
      modelUsage: {},
    } as unknown as SDKMessage;
  }

  it('Codex session near capacity does NOT enqueue /compact (SDK native handles it)', async () => {
    setModelsCache(
      new Map([
        [
          'global',
          [
            {
              id: 'gpt-5.5',
              name: 'GPT-5.5',
              provider: 'anthropic-codex',
              contextWindow: 272_000,
              available: true,
            },
          ],
        ],
      ])
    );

    const harness = driveCompactionRefresh({
      provider: 'anthropic-codex',
      model: 'gpt-5.5',
      contextWindow: 272_000,
      totalUsed: 260_000,
      sdkMaxTokens: 272_000,
    });

    await harness.handler.handleMessage(resultMessage());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.getContextUsageSpy).toHaveBeenCalledTimes(1);
    expect(harness.shouldCompactAtSpy).not.toHaveBeenCalled();
    expect(harness.markCompactionTriggeredSpy).not.toHaveBeenCalled();
    expect(harness.enqueueSpy).not.toHaveBeenCalledWith('/compact', true, {
      durable: true,
      prepend: true,
    });
  });

  it('Codex-mini (128k) session near capacity does NOT enqueue /compact', async () => {
    setModelsCache(
      new Map([
        [
          'global',
          [
            {
              id: 'gpt-5.4-mini',
              name: 'GPT-5.4 Mini',
              provider: 'anthropic-codex',
              contextWindow: 128_000,
              available: true,
            },
          ],
        ],
      ])
    );

    const harness = driveCompactionRefresh({
      provider: 'anthropic-codex',
      model: 'gpt-5.4-mini',
      contextWindow: 128_000,
      totalUsed: 120_000,
      sdkMaxTokens: 128_000,
    });

    await harness.handler.handleMessage(resultMessage());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.shouldCompactAtSpy).not.toHaveBeenCalled();
    expect(harness.enqueueSpy).not.toHaveBeenCalledWith('/compact', true, {
      durable: true,
      prepend: true,
    });
  });

  it('Kimi K3 (1M) session near capacity now enqueues /compact exactly once (daemon backstop)', async () => {
    setModelsCache(
      new Map([
        [
          'global',
          [
            {
              id: 'kimi-k3',
              name: 'Kimi K3',
              provider: 'kimi',
              contextWindow: 1_048_576,
              preferContextWindowMetadata: true,
              available: true,
            },
          ],
        ],
      ])
    );

    const harness = driveCompactionRefresh({
      provider: 'kimi',
      model: 'kimi-k3',
      contextWindow: 1_048_576,
      totalUsed: 1_040_000,
      sdkMaxTokens: 1_048_576,
    });

    await harness.handler.handleMessage(resultMessage());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.getContextUsageSpy).toHaveBeenCalledTimes(1);
    expect(harness.shouldCompactAtSpy).not.toHaveBeenCalled();
    expect(harness.markCompactionTriggeredSpy).toHaveBeenCalledTimes(1);
    expect(harness.enqueueSpy).toHaveBeenCalledWith('/compact', true, {
      durable: true,
      prepend: true,
    });
    expect(harness.enqueueSpy).toHaveBeenCalledTimes(1);
  });

  it('Kimi K3 below the default 90% threshold does not compact', async () => {
    setModelsCache(
      new Map([
        [
          'global',
          [
            {
              id: 'kimi-k3',
              name: 'Kimi K3',
              provider: 'kimi',
              contextWindow: 1_048_576,
              preferContextWindowMetadata: true,
              available: true,
            },
          ],
        ],
      ])
    );

    const harness = driveCompactionRefresh({
      provider: 'kimi',
      model: 'kimi-k3',
      contextWindow: 1_048_576,
      totalUsed: 900_000,
      sdkMaxTokens: 1_048_576,
    });

    await harness.handler.handleMessage(resultMessage());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.markCompactionTriggeredSpy).not.toHaveBeenCalled();
    expect(harness.enqueueSpy).not.toHaveBeenCalledWith('/compact', true, {
      durable: true,
      prepend: true,
    });
  });

  it('splits across the Kimi/Codex model matrix near capacity (kimi backstops, codex native)', async () => {
    const kimiCases = KimiProvider.MODELS.map((m) => ({
      provider: 'kimi',
      model: m.id,
      contextWindow: m.contextWindow,
      sdkMaxTokens: /\[1m\]$/i.test(m.id) ? m.contextWindow : 200_000,
    }));
    const codexCases = (
      Object.keys(MODEL_CONTEXT_WINDOWS) as Array<keyof typeof MODEL_CONTEXT_WINDOWS>
    ).map((id) => ({
      provider: 'anthropic-codex',
      model: id,
      contextWindow: MODEL_CONTEXT_WINDOWS[id],
      sdkMaxTokens: MODEL_CONTEXT_WINDOWS[id],
    }));

    expect(kimiCases.map((c) => c.model).sort()).toEqual(
      ['k3-256k', 'kimi-for-coding', 'kimi-k2.7-code-highspeed', 'kimi-k3[1m]'].sort()
    );

    for (const c of [...kimiCases, ...codexCases]) {
      setModelsCache(
        new Map([
          [
            'global',
            [
              {
                id: c.model,
                name: c.model,
                provider: c.provider,
                contextWindow: c.contextWindow,
                available: true,
              },
            ],
          ],
        ])
      );
      const harness = driveCompactionRefresh({
        provider: c.provider,
        model: c.model,
        contextWindow: c.contextWindow,
        totalUsed: c.contextWindow - 1_000,
        sdkMaxTokens: c.sdkMaxTokens,
      });
      await harness.handler.handleMessage(resultMessage());
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (c.provider === 'kimi') {
        expect(harness.enqueueSpy, `${c.provider}/${c.model}`).toHaveBeenCalledWith(
          '/compact',
          true,
          { durable: true, prepend: true }
        );
        expect(
          harness.markCompactionTriggeredSpy,
          `${c.provider}/${c.model}`
        ).toHaveBeenCalledTimes(1);
      } else {
        expect(harness.enqueueSpy, `${c.provider}/${c.model}`).not.toHaveBeenCalledWith(
          '/compact',
          true
        );
        expect(
          harness.markCompactionTriggeredSpy,
          `${c.provider}/${c.model}`
        ).not.toHaveBeenCalled();
      }
    }
  });

  it('MessageQueue preserves the internal flag so an internal /compact stays out of the transcript', async () => {
    const queue = new MessageQueue();
    const yieldedSpy = mock(() => {});
    queue.onMessageYielded = yieldedSpy;
    queue.start();

    let yielded: (SDKUserMessage & { internal?: boolean }) | undefined;
    const consumer = (async () => {
      for await (const entry of queue.messageGenerator('sess')) {
        yielded = entry.message as SDKUserMessage & { internal?: boolean };
        entry.onSent();
        break;
      }
    })();

    await queue.enqueue('/compact', true);
    await consumer;
    queue.stop();

    expect(yielded).toBeDefined();
    expect(yielded?.internal).toBe(true);
    expect(yielded?.message.content).toEqual([
      { type: 'text', text: '/compact' },
    ] as MessageContent[]);
    expect(yieldedSpy).not.toHaveBeenCalled();
  });

  it('delivery gate holds queued prompts until pending enforcement completes', async () => {
    const queue = new MessageQueue();
    queue.start();
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    queue.setDeliveryGate(gate);

    let yielded = false;
    const consumer = (async () => {
      for await (const entry of queue.messageGenerator('sess')) {
        yielded = true;
        entry.onSent();
        break;
      }
    })();
    const enqueued = queue.enqueue('first prompt', false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(yielded).toBe(false);
    releaseGate();
    await consumer;
    await enqueued;
    queue.stop();
    expect(yielded).toBe(true);
  });

  it('internal /compact is excluded from the query-runner retry-replay buffer (daemon query boundary)', async () => {
    const queue = new MessageQueue();
    queue.start();

    const setProcessingSpy = mock(async () => {});
    const session: Session = {
      id: 'query-boundary-session',
      title: 'Query Boundary Session',
      workspacePath: '/test/path',
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      status: 'active',
      config: { model: 'default', maxTokens: 8192, temperature: 1.0 },
      metadata: {
        messageCount: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalCost: 0,
        toolCallCount: 0,
      },
    };

    const runner = new QueryRunner({
      session,
      messageQueue: queue,
      stateManager: { setProcessing: setProcessingSpy } as unknown as ProcessingStateManager,
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        log: () => {},
        trace: () => {},
      },
    } as unknown as QueryRunnerContext);

    const yielded: Array<SDKUserMessage & { internal?: boolean }> = [];
    const consumer = (async () => {
      for await (const message of runner.createMessageGeneratorWrapper()) {
        yielded.push(message as SDKUserMessage & { internal?: boolean });
        if (yielded.length === 2) {
          queue.stop();
        }
      }
    })();

    await queue.enqueue('/compact', true);
    await queue.enqueue('fix the bug', false);
    await consumer;

    expect(yielded).toHaveLength(2);
    expect(yielded[0].internal).toBe(true);
    expect(yielded[1].internal).toBe(false);
    expect(setProcessingSpy).toHaveBeenCalledTimes(1);
    const replay = (runner as unknown as { _lastConsumedUserMessage: { content: unknown } | null })
      ._lastConsumedUserMessage;
    expect(replay?.content).toEqual([{ type: 'text', text: 'fix the bug' }]);
  });

  it('when the context budget is exceeded on a custom provider, the handler enqueues /compact as internal (production call site)', async () => {
    const TEST_PROVIDER = 'test-budget-provider';
    setModelsCache(
      new Map([
        [
          'global',
          [
            {
              id: 'budget-model',
              name: 'Budget Model',
              provider: TEST_PROVIDER,
              contextWindow: 200_000,
              available: true,
            },
          ],
        ],
      ])
    );
    const harness = driveCompactionRefresh({
      provider: TEST_PROVIDER,
      model: 'budget-model',
      contextWindow: 200_000,
      totalUsed: 185_000,
      sdkMaxTokens: 200_000,
    });
    await harness.handler.handleMessage(resultMessage());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.getContextUsageSpy).toHaveBeenCalledTimes(1);
    expect(harness.shouldCompactAtSpy).not.toHaveBeenCalled();
    expect(harness.markCompactionTriggeredSpy).toHaveBeenCalledTimes(1);
    expect(harness.enqueueSpy).toHaveBeenCalledWith('/compact', true, {
      durable: true,
      prepend: true,
    });
  });

  it('autoCompactPercent 100 opts a custom provider out of the daemon backstop', async () => {
    const TEST_PROVIDER = 'test-optout-provider';
    setModelsCache(
      new Map([
        [
          'global',
          [
            {
              id: 'optout-model',
              name: 'Opt-out Model',
              provider: TEST_PROVIDER,
              contextWindow: 200_000,
              autoCompactPercent: 100,
              available: true,
            },
          ],
        ],
      ])
    );
    const harness = driveCompactionRefresh({
      provider: TEST_PROVIDER,
      model: 'optout-model',
      contextWindow: 200_000,
      totalUsed: 199_000,
      sdkMaxTokens: 200_000,
    });
    await harness.handler.handleMessage(resultMessage());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.markCompactionTriggeredSpy).not.toHaveBeenCalled();
    expect(harness.enqueueSpy).not.toHaveBeenCalledWith('/compact', true, {
      durable: true,
      prepend: true,
    });
  });

  it('an active SDK compaction suppresses the backstop', async () => {
    const TEST_PROVIDER = 'test-compacting-provider';
    setModelsCache(
      new Map([
        [
          'global',
          [
            {
              id: 'compacting-model',
              name: 'Compacting Model',
              provider: TEST_PROVIDER,
              contextWindow: 200_000,
              available: true,
            },
          ],
        ],
      ])
    );
    const harness = driveCompactionRefresh({
      provider: TEST_PROVIDER,
      model: 'compacting-model',
      contextWindow: 200_000,
      totalUsed: 185_000,
      sdkMaxTokens: 200_000,
      compactingActive: true,
    });
    await harness.handler.handleMessage(resultMessage());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.markCompactionTriggeredSpy).not.toHaveBeenCalled();
    expect(harness.enqueueSpy).not.toHaveBeenCalledWith('/compact', true, {
      durable: true,
      prepend: true,
    });
  });
});
