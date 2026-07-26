/**
 * Native Compaction Behavior — regression suite (Task #754).
 *
 * Pins the Kimi + Codex auto-compaction contract that recurred as four defect
 * classes (Forge evidence episode 851158bf-aeb3-4f63-b313-8838d3341bac):
 *
 *   C1  premature disablement   — SDK auto-compact turned off, causing overflow
 *   C2  wrong threshold         — compaction firing at the wrong window
 *   C3  SDK/runtime mismatch    — HyperNeo fallback racing/preempting native
 *   C4  text injection          — literal `/compact` inserted into the
 *                                 conversation transcript or provider request
 *
 * Four contract groups, one per defect class. The deep per-value unit coverage
 * lives in `query-options-builder.test.ts`, `kimi-provider.test.ts`,
 * `anthropic-to-codex-bridge-provider.test.ts`, and `sdk-message-handler.test.ts`;
 * this suite CONSOLIDATES the Kimi/Codex contract into one place and fills the
 * gaps those files leave (Codex + Kimi-K3 handler-level gating, the empty
 * fallback-set invariant, the per-provider reserve threshold, and the
 * transcript-exclusion mechanism for `/compact`).
 *
 *   N1  native SDK auto-compaction is used — never disabled for kimi/codex (C1)
 *   N2  provider-specific thresholds are respected — kimi 45k vs codex 33k
 *       reserve; per-model context windows (C2)
 *   N3  NeoKai (HyperNeo) fallback applied only where intended — the proactive
 *       `/compact` fallback is a dormant extension point; kimi/codex never opt
 *       in (C3)
 *   N4  literal `/compact` never enters the transcript or provider request —
 *       the handler-level gate for kimi/codex, plus the internal-flag
 *       transcript-exclusion mechanism (C4)
 */

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
  PROVIDER_NO_SDK_AUTO_COMPACT,
  shouldUseHyperNeoCompactFallback,
} from '../../../../src/lib/agent/query-options-builder';
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
  getModelContextWindow,
  MODEL_CONTEXT_WINDOWS,
} from '../../../../src/lib/providers/codex-models';
import { KimiProvider } from '../../../../src/lib/providers/kimi-provider';
import type { Database } from '../../../../src/storage/database';

// --------------------------------------------------------------- N1: native ---

describe('N1: native SDK auto-compaction is used (never disabled for kimi/codex)', () => {
  // The C1 regression: a provider's SDK auto-compact being turned off
  // (`{ autoCompactEnabled: false }`) created a dead zone — no SDK compact, and
  // HyperNeo's async fallback fires after turns so it cannot prevent
  // within-turn/resume overflow. Kimi overflowed ~7.7% of sessions that way.
  // The contract: buildProviderSettings must NEVER disable auto-compact for a
  // Kimi or Codex model — it either trusts the SDK natively (codex → undefined)
  // or arms it with the real window (kimi).

  const CASES: Array<{
    label: string;
    provider: string;
    contextWindow: number;
    model: string;
    expected: 'native' | { autoCompactEnabled: true; autoCompactWindow: number };
  }> = [
    {
      label: 'kimi K2.7 (262144) — armed with real window',
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
      // Native: SDK auto-compact is trusted as-is (no settings override).
      expect(settings).toBeUndefined();
    } else {
      expect(settings).toEqual(c.expected);
    }
  });

  it('never returns autoCompactEnabled:false for any Kimi or Codex model (C1 invariant)', () => {
    // Iterate the real model catalogue rather than hand-picked values so a new
    // Kimi/Codex model cannot silently land in the disabled-fallback branch.
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
    // K3 is special-cased to surface its real 1M window regardless of the
    // metadata-supplied value, so a missing window must NOT collapse into the
    // generic "unknown window → undefined" branch and lose the K3 intent.
    expect(buildProviderSettings('kimi', undefined, 'kimi-k3')).toEqual({
      autoCompactEnabled: true,
      autoCompactWindow: 1_048_576,
    });
  });
});

// ---------------------------------------------------------- N2: thresholds ---

describe('N2: thresholds — active SDK window (kimi/codex) + dormant fallback reserve', () => {
  // The C2 regression class: compaction firing at the wrong window. There are
  // TWO threshold surfaces and this group pins both so a regression in either
  // is caught:
  //
  //   • ACTIVE path (kimi/codex): the SDK's NATIVE auto-compact, armed by the
  //     window in buildProviderSettings (N1) + CLAUDE_CODE_AUTO_COMPACT_WINDOW.
  //     This is what actually governs kimi/codex compaction today.
  //   • DORMANT fallback reserve: reserveBasedThreshold() is used ONLY by
  //     HyperNeo's async /compact fallback, which is dormant today
  //     (PROVIDER_NO_SDK_AUTO_COMPACT is empty — see N3) because the SDK native
  //     path is strictly safer. It would be re-armed only if a provider were
  //     opted back into the set; the 45k kimi / 33k codex reserve is the
  //     contract for that case. reserveBasedThreshold is NOT the effective
  //     kimi/codex threshold while the set stays empty.

  it('uses a 45k reserve for Kimi (K2.7 + K3) and a 33k reserve for Codex', () => {
    // Dormant-fallback reserve (see header). Not the active kimi/codex threshold.
    expect(reserveBasedThreshold(262_144, 'kimi')).toBe(262_144 - 45_000); // 217144
    expect(reserveBasedThreshold(1_048_576, 'kimi')).toBe(1_048_576 - 45_000); // 1003576
    expect(reserveBasedThreshold(272_000, 'anthropic-codex')).toBe(272_000 - 33_000); // 239000
    expect(reserveBasedThreshold(128_000, 'anthropic-codex')).toBe(128_000 - 33_000); // 95000
  });

  it('uses the SDK-standard 33k reserve when no provider is given', () => {
    expect(reserveBasedThreshold(200_000)).toBe(200_000 - 33_000); // 167000
  });

  it('floors the threshold at 0 for non-positive / non-finite windows', () => {
    expect(reserveBasedThreshold(0, 'kimi')).toBe(0);
    expect(reserveBasedThreshold(-5, 'anthropic-codex')).toBe(0);
    expect(reserveBasedThreshold(Number.POSITIVE_INFINITY, 'kimi')).toBe(0);
    expect(reserveBasedThreshold(Number.NaN)).toBe(0);
  });

  it('Kimi reserve stays strictly larger than the Codex/default reserve at every window', () => {
    // The provider-specific delta is the whole point: Kimi must compact earlier.
    for (const window of [128_000, 200_000, 262_144, 272_000, 1_048_576]) {
      const kimi = reserveBasedThreshold(window, 'kimi');
      const codex = reserveBasedThreshold(window, 'anthropic-codex');
      expect(kimi, `window=${window}`).toBeLessThan(codex);
      expect(codex - kimi, `window=${window}`).toBe(45_000 - 33_000); // 12000
    }
  });

  it('the per-model Codex windows that feed CLAUDE_CODE_AUTO_COMPACT_WINDOW are the expected values', () => {
    // The Codex bridge sets `CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(entry.contextWindow)`;
    // these are the threshold-source values (env-var wiring is covered by
    // anthropic-to-codex-bridge-provider.test.ts).
    expect(getModelContextWindow('gpt-5.5')).toBe(272_000);
    expect(getModelContextWindow('gpt-5.3-codex')).toBe(272_000);
    expect(getModelContextWindow('gpt-5.4-mini')).toBe(128_000);
    expect(getModelContextWindow('codex-mini')).toBe(128_000); // alias resolves
  });

  it('Kimi buildSdkConfig arms CLAUDE_CODE_AUTO_COMPACT_WINDOW per model (K2.7=262144, K3=1M)', () => {
    // Kimi buildSdkConfig is pure (no bridge server) so it is safe to drive here.
    const provider = new KimiProvider({ KIMI_API_KEY: 'key' });
    expect(provider.buildSdkConfig('kimi-k2.7-code').envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe(
      '262144'
    );
    expect(provider.buildSdkConfig('kimi-k3').envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe(
      '1048576'
    );
  });

  it('the ACTIVE kimi/codex threshold is the SDK window (buildProviderSettings), not the fallback reserve', () => {
    // Because PROVIDER_NO_SDK_AUTO_COMPACT is empty (N3), SDKMessageHandler
    // never reaches reserveBasedThreshold for kimi/codex — the SDK native
    // auto-compact governs. The active window is the one armed by
    // buildProviderSettings; the dormant reserve would be computed FROM that
    // same window only if the fallback were re-armed. Pin the relationship so a
    // regression to the active window (not the reserve) is what fails.
    const k2Window = buildProviderSettings('kimi', 262_144, 'kimi-k2.7-code')?.autoCompactWindow;
    const k3Window = buildProviderSettings('kimi', 1_048_576, 'kimi-k3')?.autoCompactWindow;
    expect(k2Window).toBe(262_144);
    expect(k3Window).toBe(1_048_576);
    // And the dormant reserve that would apply to those same active windows:
    expect(reserveBasedThreshold(262_144, 'kimi')).toBe(262_144 - 45_000);
    expect(reserveBasedThreshold(1_048_576, 'kimi')).toBe(1_048_576 - 45_000);
    // Codex stays native (no armed window) — its active threshold is the SDK's
    // own, fed by CLAUDE_CODE_AUTO_COMPACT_WINDOW above; reserveBasedThreshold
    // only documents what the dormant fallback would use.
    expect(buildProviderSettings('anthropic-codex', 272_000, 'gpt-5.5')).toBeUndefined();
  });
});

// ------------------------------------- N3: NeoKai fallback (dormant for kimi/codex)

describe('N3: NeoKai (HyperNeo) fallback applied only where intended', () => {
  // The C3 regression class: HyperNeo's proactive async `/compact` fallback
  // racing with or preempting the SDK's native auto-compact. The design contract
  // is that NO provider uses this fallback — `PROVIDER_NO_SDK_AUTO_COMPACT` is
  // intentionally empty. Kimi was previously special-cased into it and that
  // caused the ~7.7% overflow (the async fallback cannot prevent within-turn or
  // resume overflow). This group pins the empty-set invariant so no provider —
  // especially Kimi/Codex — can accidentally opt back into text-injection
  // compaction. It also keeps the context-fetcher capacity-mismatch warning
  // active for native providers (codex/glm), which is how a C2/C3 regression is
  // surfaced in production.

  it('PROVIDER_NO_SDK_AUTO_COMPACT is empty (no provider uses the async /compact fallback)', () => {
    expect(PROVIDER_NO_SDK_AUTO_COMPACT.size).toBe(0);
  });

  it.each([
    ['kimi', 'kimi'],
    ['anthropic-codex', 'anthropic-codex'],
    ['anthropic', 'anthropic'],
    ['anthropic-copilot', 'anthropic-copilot'],
    ['glm', 'glm'],
    ['openrouter', 'openrouter'],
    ['ollama', 'ollama'],
    ['minimax', 'minimax'],
    ['gemini', 'gemini'],
  ])('shouldUseHyperNeoCompactFallback(%s) is false', (_label, providerId) => {
    expect(shouldUseHyperNeoCompactFallback(providerId)).toBe(false);
  });

  it('every Kimi and Codex model id resolves to no HyperNeo fallback', () => {
    const ids = [
      ...KimiProvider.MODELS.map((m) => m.id),
      ...(Object.keys(MODEL_CONTEXT_WINDOWS) as Array<keyof typeof MODEL_CONTEXT_WINDOWS>),
    ];
    for (const id of ids) {
      // The provider id is what the gate keys on, not the model; assert both
      // Kimi and Codex provider ids are inert regardless of selected model.
      expect(shouldUseHyperNeoCompactFallback('kimi'), `kimi/${id}`).toBe(false);
      expect(shouldUseHyperNeoCompactFallback('anthropic-codex'), `codex/${id}`).toBe(false);
    }
  });
});

// ----------------------------- N4: literal /compact never in transcript/request

/**
 * Lean harness for the SDKMessageHandler compaction path. Constructs the handler
 * exactly as in production; only the I/O collaborators are mocked so the
 * assertion runs on whether `/compact` is enqueued (the only path by which
 * literal `/compact` text reaches the SDK user-message stream).
 */
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
  const shouldCompactAtSpy = mock(() => true); // adversarial: pretend the threshold is crossed
  const markCompactionTriggeredSpy = mock(() => {});

  const db = {
    saveSDKMessage: mock(() => true),
    updateSession: mock(() => {}),
    getMessagesByStatus: mock(() => []),
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
    setIdle: mock(async () => {}),
    setCompacting: mock(async () => {}),
    getState: mock(() => ({ phase: 'idle' })),
  } as unknown as ProcessingStateManager;

  const contextTracker = {
    getContextInfo: mock(() => ({ totalTokens: 1000, maxTokens: 128000 })),
    updateWithDetailedBreakdown: mock(() => {}),
    shouldCompact: mock(() => false),
    shouldCompactAt: shouldCompactAtSpy,
    markCompactionTriggered: markCompactionTriggeredSpy,
  } as unknown as ContextTracker;

  const messageQueue = {
    enqueue: enqueueSpy,
    enqueueWithId: mock(async () => {}),
    clear: mock(() => {}),
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
  // The C4 regression class: `/compact` injected as a user message that becomes
  // part of the conversation transcript or the provider request. The proactive
  // fallback is the ONLY path that enqueues `/compact` from the context-refresh
  // flow; it is gated by shouldUseHyperNeoCompactFallback. For Kimi and Codex
  // that gate is closed (N3), so the enqueue is structurally unreachable —
  // proven here at the handler level (not just the function level) so a wiring
  // regression that drops the gate is caught.

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
    // Codex (anthropic-codex) is in NATIVE_CONTEXT_WINDOW_PROVIDER_IDS and its
    // bridge routes real Codex IDs with preferContextWindowMetadata, so the SDK
    // reads the correct 272k/128k windows and its own auto-compact fires at the
    // right threshold. HyperNeo must not inject `/compact`.
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
      totalUsed: 260_000, // ~96% of capacity — well past any reserve threshold
      sdkMaxTokens: 272_000,
    });

    await harness.handler.handleMessage(resultMessage());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.getContextUsageSpy).toHaveBeenCalledTimes(1);
    // The gate short-circuits before the threshold check.
    expect(harness.shouldCompactAtSpy).not.toHaveBeenCalled();
    expect(harness.markCompactionTriggeredSpy).not.toHaveBeenCalled();
    expect(harness.enqueueSpy).not.toHaveBeenCalledWith('/compact', true);
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
      totalUsed: 120_000, // ~94% of capacity
      sdkMaxTokens: 128_000,
    });

    await harness.handler.handleMessage(resultMessage());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.shouldCompactAtSpy).not.toHaveBeenCalled();
    expect(harness.enqueueSpy).not.toHaveBeenCalledWith('/compact', true);
  });

  it('Kimi K3 (1M) session near capacity does NOT enqueue /compact', async () => {
    // K2.7 is already covered in sdk-message-handler.test.ts; K3 (the 1M model)
    // is the gap. Even at ~99% of the 1M window the gate must hold.
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
      totalUsed: 1_040_000, // ~99% of capacity
      sdkMaxTokens: 1_048_576,
    });

    await harness.handler.handleMessage(resultMessage());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.getContextUsageSpy).toHaveBeenCalledTimes(1);
    expect(harness.shouldCompactAtSpy).not.toHaveBeenCalled();
    expect(harness.markCompactionTriggeredSpy).not.toHaveBeenCalled();
    expect(harness.enqueueSpy).not.toHaveBeenCalledWith('/compact', true);
  });

  it('holds across the Kimi/Codex model matrix (every model near capacity, no /compact)', async () => {
    const matrix = [
      { provider: 'kimi', model: 'kimi-k2.7-code', contextWindow: 262_144, sdkMaxTokens: 200_000 },
      { provider: 'kimi', model: 'kimi-for-coding', contextWindow: 262_144, sdkMaxTokens: 200_000 },
      { provider: 'kimi', model: 'kimi-k3', contextWindow: 1_048_576, sdkMaxTokens: 1_048_576 },
      {
        provider: 'anthropic-codex',
        model: 'gpt-5.5',
        contextWindow: 272_000,
        sdkMaxTokens: 272_000,
      },
      {
        provider: 'anthropic-codex',
        model: 'gpt-5.3-codex',
        contextWindow: 272_000,
        sdkMaxTokens: 272_000,
      },
      {
        provider: 'anthropic-codex',
        model: 'gpt-5.4-mini',
        contextWindow: 128_000,
        sdkMaxTokens: 128_000,
      },
    ];

    for (const c of matrix) {
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
      // Drive at totalUsed past the largest reserve threshold for this window.
      const harness = driveCompactionRefresh({
        provider: c.provider,
        model: c.model,
        contextWindow: c.contextWindow,
        totalUsed: c.contextWindow - 1_000, // 1k shy of the full window
        sdkMaxTokens: c.sdkMaxTokens,
      });
      await harness.handler.handleMessage(resultMessage());
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(harness.enqueueSpy, `${c.provider}/${c.model}`).not.toHaveBeenCalledWith(
        '/compact',
        true
      );
      expect(harness.markCompactionTriggeredSpy, `${c.provider}/${c.model}`).not.toHaveBeenCalled();
    }
  });

  it('MessageQueue preserves the internal flag so an internal /compact stays out of the transcript', async () => {
    // MECHANISM only: this drives MessageQueue directly (with internal=true
    // supplied by the caller) to prove an internal `/compact` is yielded to the
    // SDK as a user message (so the SDK runs its built-in /compact slash command
    // — a structured control, not prompt text) but never reaches the yield-time
    // DB/UI broadcast hook that persists conversation turns. The PRODUCTION call
    // site that supplies internal=true is pinned by the next test.
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
    // internal messages never hit the yield-time persistence/broadcast hook.
    expect(yieldedSpy).not.toHaveBeenCalled();
  });

  it('when the dormant fallback fires, the handler enqueues /compact as internal (production call site)', async () => {
    // The kimi/codex cases prove the gate stays CLOSED (no enqueue). To pin the
    // production CALL SITE — that SDKMessageHandler enqueues `/compact` with
    // internal=true (not false, not omitted) — this test opens the gate for a
    // test-only provider by adding it to PROVIDER_NO_SDK_AUTO_COMPACT (the
    // production-empty set; restored in `finally` so the N3 invariant holds),
    // then drives the handler past the reserve threshold. Combined with the
    // MessageQueue mechanism test above, this proves the full production path
    // handler → enqueue('/compact', true) → internal (transcript-excluded)
    // message. Without this, a regression flipping the call site's `true` to
    // `false` would leave the suite green.
    const TEST_PROVIDER = 'test-fallback-provider';
    const fallbackSet = PROVIDER_NO_SDK_AUTO_COMPACT as Set<string>;
    fallbackSet.add(TEST_PROVIDER);
    try {
      setModelsCache(
        new Map([
          [
            'global',
            [
              {
                id: 'fb-model',
                name: 'Fallback Model',
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
        model: 'fb-model',
        contextWindow: 200_000,
        totalUsed: 195_000, // past the 167k (200k − 33k) reserve threshold
        sdkMaxTokens: 200_000,
      });
      await harness.handler.handleMessage(resultMessage());
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(harness.getContextUsageSpy).toHaveBeenCalledTimes(1);
      expect(harness.shouldCompactAtSpy).toHaveBeenCalled();
      expect(harness.markCompactionTriggeredSpy).toHaveBeenCalled();
      // The production call site enqueues /compact WITH internal=true.
      expect(harness.enqueueSpy).toHaveBeenCalledWith('/compact', true);
    } finally {
      fallbackSet.delete(TEST_PROVIDER);
      setModelsCache(new Map());
    }
  });
});
