/**
 * Usage Accounting Invariant Suite
 *
 * Asserts arithmetic invariants — not single examples — that must hold across
 * the full input space for the two units feeding the user-visible context and
 * token displays:
 *
 *   • ContextFetcher.toContextInfo  — context-window breakdown accounting
 *   • SDKMessageHandler             — token/cost accumulation, thinking_tokens
 *                                     deltas, api_retry rendering
 *
 * Guards the mis-accounting classes fixed in #2241/#2242 (autocompact buffer
 * double-count, breakdown categories exceeding totalUsed) plus the
 * thinking-token and retry paths. Each test names the invariant it enforces so
 * a regression points straight at the violated contract:
 *
 *   I1  non-free breakdown categories never exceed totalUsed
 *   I2  a complete SDK breakdown sums (non-free) to exactly totalUsed
 *   I3  autocompact buffer excluded from breakdown rows (counted 0× as usage)
 *   I4  autocompact reserved tokens counted exactly once
 *        (freeSpace + nonFreeSum + reserved == capacity; threshold == capacity − reserved)
 *   I5  percentUsed always within [0, 100]
 *   I6  thinking deltas within a turn sum to the turn's peak (no re-count)
 *   I7  a stuck cumulative estimate stamps once, not once per block (#614)
 *   I8  thinking baseline never carries across turns (result / idle / init resets)
 *   I9  api_retry messages account zero tokens
 *   I10 totalTokens == inputTokens + outputTokens (exact, monotonic)
 *   I11 cost is monotonic across an SDK restart; each run's peak counted once
 *
 * Per the repo's testing lesson, assertions are on rendered/output state
 * (computed breakdown, stamped messages, accumulated metadata) — never on raw
 * inputs that would trivially pass.
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { SDKControlGetContextUsageResponse } from '@anthropic-ai/claude-agent-sdk';
import type { MessageHub, Session } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import { ContextFetcher } from '../../../../src/lib/agent/context-fetcher';
import type { ContextTracker } from '../../../../src/lib/agent/context-tracker';
import type { MessageQueue } from '../../../../src/lib/agent/message-queue';
import type { ProcessingStateManager } from '../../../../src/lib/agent/processing-state-manager';
import type { QueryLifecycleManager } from '../../../../src/lib/agent/query-lifecycle-manager';
import {
  SDKMessageHandler,
  type SDKMessageHandlerContext,
} from '../../../../src/lib/agent/sdk-message-handler';
import type { ErrorManager } from '../../../../src/lib/error-manager';
import type { InternalEventBus } from '../../../../src/lib/internal-event-bus';
import type { Database } from '../../../../src/storage/database';

// ---------------------------------------------------------------- helpers ----

type SdkResponse = SDKControlGetContextUsageResponse;
type FetchMetadata = Parameters<typeof ContextFetcher.toContextInfo>[1];

/** Minimal typed SDK context-usage response builder (mirrors the SDK shape). */
function baseResponse(overrides: Partial<SdkResponse> = {}): SdkResponse {
  return {
    categories: [],
    totalTokens: 0,
    maxTokens: 200000,
    rawMaxTokens: 200000,
    percentage: 0,
    gridRows: [],
    model: 'claude-sonnet-4-6',
    memoryFiles: [],
    mcpTools: [],
    agents: [],
    isAutoCompactEnabled: false,
    apiUsage: null,
    ...overrides,
  };
}

/** Deterministic LCG so property-test failures are reproducible (no Math.random). */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function approxEqual(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) <= eps;
}

/** Sum of all non-"free space" breakdown category token counts. */
function nonFreeSum(info: ReturnType<typeof ContextFetcher.toContextInfo>): number {
  return Object.entries(info.breakdown)
    .filter(([name]) => !name.toLowerCase().includes('free space'))
    .reduce((sum, [, data]) => sum + data.tokens, 0);
}

// -------------------------------------------------- ContextFetcher invariants

describe('ContextFetcher breakdown invariants (I1, I2, I3, I5)', () => {
  // A spread of hand-picked scenarios covering native vs metadata-corrected
  // providers, over-/under-/exactly-scaled category sums, with and without an
  // autocompact buffer row and a free-space row.
  const SCENARIOS: Array<{ label: string; response: SdkResponse; metadata?: FetchMetadata }> = [
    {
      label: 'native anthropic, categories sum exactly to total',
      response: baseResponse({
        totalTokens: 20000,
        maxTokens: 200000,
        percentage: 10,
        categories: [
          { name: 'System prompt', tokens: 4000, color: 'gray' },
          { name: 'System tools', tokens: 15000, color: 'gray' },
          { name: 'Messages', tokens: 1000, color: 'blue' },
          { name: 'Free space', tokens: 180000, color: 'gray-dim' },
        ],
      }),
    },
    {
      // SDK reports a raw usage scaled to a 1M window while totalUsed reflects
      // the real (smaller) usage. Categories must be normalized down so no row
      // exceeds totalUsed and the sum matches.
      label: 'kimi, over-scaled categories normalized down to totalUsed',
      response: baseResponse({
        totalTokens: 90584,
        maxTokens: 1_000_000,
        rawMaxTokens: 1_000_000,
        percentage: 9.1,
        model: 'kimi-k2.7-code',
        categories: [
          { name: 'System prompt', tokens: 12000, color: 'gray' },
          { name: 'Messages', tokens: 202700, color: 'blue' },
          { name: 'Free space', tokens: 744300, color: 'gray-dim' },
        ],
      }),
      metadata: { id: 'kimi-k2.7-code', alias: 'kimi', contextWindow: 262144, provider: 'kimi' },
    },
    {
      label: 'glm, under-scaled categories normalized up to totalUsed',
      response: baseResponse({
        totalTokens: 120000,
        maxTokens: 200000,
        rawMaxTokens: 200000,
        percentage: 60,
        model: 'glm-5.1',
        categories: [
          { name: 'System prompt', tokens: 1000, color: 'gray' },
          { name: 'Messages', tokens: 4000, color: 'blue' },
          { name: 'Free space', tokens: 80000, color: 'gray-dim' },
        ],
      }),
      metadata: { id: 'glm-5.1', alias: 'glm-5.1', contextWindow: 200000, provider: 'glm' },
    },
    {
      label: 'no free-space category present',
      response: baseResponse({
        totalTokens: 5000,
        maxTokens: 200000,
        percentage: 2.5,
        categories: [
          { name: 'System prompt', tokens: 3000, color: 'gray' },
          { name: 'Messages', tokens: 2000, color: 'blue' },
        ],
      }),
    },
    {
      label: 'usage exceeds capacity (percentUsed clamps to 100)',
      response: baseResponse({
        totalTokens: 300000,
        maxTokens: 200000,
        rawMaxTokens: 272000,
        percentage: 150,
        categories: [{ name: 'Messages', tokens: 300000, color: 'blue' }],
      }),
    },
    {
      label: 'zero usage with empty categories',
      response: baseResponse({ totalTokens: 0, categories: [] }),
    },
  ];

  it.each(SCENARIOS.map((s) => [s.label, s] as const))('%s', (_label, scenario) => {
    const info = ContextFetcher.toContextInfo(scenario.response, scenario.metadata);
    assertBreakdownInvariants(info, scenario.label);
  });

  it('holds across 200 randomized category distributions and provider mixes', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rng = makeRng(seed);
      const isNative = rng() < 0.35;
      const provider = isNative ? 'anthropic' : rng() < 0.5 ? 'glm' : 'kimi';
      const metadataWindow = isNative ? 200000 : [200000, 262144, 1_000_000][Math.floor(rng() * 3)];
      const sdkWindow = isNative ? 200000 : rng() < 0.5 ? 1_000_000 : metadataWindow;

      // Build K non-free usage categories with random raw token counts.
      const categoryCount = 1 + Math.floor(rng() * 4);
      const categories: SdkResponse['categories'] = [];
      let rawUsage = 0;
      for (let i = 0; i < categoryCount; i++) {
        const tokens = Math.floor(rng() * 50_000) + 1;
        rawUsage += tokens;
        categories.push({ name: `Usage ${i}`, tokens, color: 'blue' });
      }

      // totalUsed may differ from the raw category sum (over- or under-scaled),
      // which is the case the normalization step exists to handle.
      const scale = 0.25 + rng() * 3;
      const totalUsed = Math.max(1, Math.round(rawUsage * scale));

      if (rng() < 0.6) {
        categories.push({
          name: 'Free space',
          tokens: Math.max(0, sdkWindow - rawUsage),
          color: 'gray-dim',
        });
      }
      if (rng() < 0.5) {
        // Autocompact buffer row — must be excluded from the breakdown.
        categories.push({
          name: 'Reserved for Autocompact',
          tokens: Math.floor(rng() * 40_000) + 1,
          color: 'gray',
        });
      }

      const label = `seed=${seed} provider=${provider}`;
      const info = ContextFetcher.toContextInfo(
        baseResponse({
          totalTokens: totalUsed,
          maxTokens: sdkWindow,
          rawMaxTokens: sdkWindow,
          percentage: Math.round((totalUsed / sdkWindow) * 100),
          model: `${provider}-model`,
          isAutoCompactEnabled: rng() < 0.5,
          categories,
        }),
        isNative ? undefined : { id: `${provider}-model`, contextWindow: metadataWindow, provider }
      );
      assertBreakdownInvariants(info, label);
    }
  });

  function assertBreakdownInvariants(
    info: ReturnType<typeof ContextFetcher.toContextInfo>,
    label: string
  ): void {
    const entries = Object.entries(info.breakdown);
    const nonFree = entries.filter(([name]) => !name.toLowerCase().includes('free space'));
    const sum = nonFree.reduce((acc, [, data]) => acc + data.tokens, 0);

    // I1: non-free categories never exceed totalUsed.
    expect(sum, `[${label}] I1 nonFreeSum <= totalUsed`).toBeLessThanOrEqual(info.totalUsed);
    for (const [name, data] of nonFree) {
      expect(data.tokens, `[${label}] I1 ${name} <= totalUsed`).toBeLessThanOrEqual(info.totalUsed);
    }

    // I2: a complete SDK breakdown sums (non-free) to exactly totalUsed.
    if (info.totalUsed > 0 && nonFree.some(([, data]) => data.tokens > 0)) {
      expect(sum, `[${label}] I2 nonFreeSum == totalUsed`).toBe(info.totalUsed);
    }

    // I3: autocompact buffer never appears as a breakdown row.
    for (const [name] of entries) {
      expect(name.toLowerCase(), `[${label}] I3 no autocompact row`).not.toContain('autocompact');
    }

    // I5: percentUsed is always within [0, 100].
    expect(info.percentUsed, `[${label}] I5 percentUsed >= 0`).toBeGreaterThanOrEqual(0);
    expect(info.percentUsed, `[${label}] I5 percentUsed <= 100`).toBeLessThanOrEqual(100);
  }
});

describe('Autocompact buffer counted exactly once (I3, I4)', () => {
  // Metadata-corrected scenario where the SDK emits an autocompact buffer row.
  function autocompactScenario(
    overrides: Partial<{ messages: number; reserved: number; window: number }> = {}
  ): { info: ReturnType<typeof ContextFetcher.toContextInfo>; reserved: number; capacity: number } {
    const messages = overrides.messages ?? 193926;
    const reserved = overrides.reserved ?? 33037;
    const window = overrides.window ?? 272000;
    const response = baseResponse({
      totalTokens: messages,
      maxTokens: 200000,
      rawMaxTokens: 200000,
      percentage: 97,
      model: 'glm-5.1',
      autoCompactThreshold: 180000,
      isAutoCompactEnabled: true,
      categories: [
        { name: 'Messages', tokens: messages, color: 'blue' },
        { name: 'Reserved for Autocompact', tokens: reserved, color: 'gray' },
        { name: 'Free space', tokens: 45037, color: 'gray-dim' },
      ],
    });
    const info = ContextFetcher.toContextInfo(response, {
      id: 'glm-5.1',
      alias: 'glm-5.1',
      contextWindow: window,
      provider: 'glm',
    });
    return { info, reserved, capacity: window };
  }

  it('I3: excludes the autocompact row from the breakdown', () => {
    const { info } = autocompactScenario();
    expect(info.breakdown['Reserved for Autocompact']).toBeUndefined();
  });

  it('I4: subtracts the buffer exactly once from free space (freeSpace + used + reserved == capacity)', () => {
    const { info, reserved, capacity } = autocompactScenario();
    const free = info.breakdown['Free space']?.tokens ?? 0;
    const used = nonFreeSum(info);
    // The buffer is reserved and unavailable, so it is subtracted from free
    // space exactly once — not also counted as a usage row, and not twice.
    expect(free + used + reserved).toBe(capacity);
    // Equivalently: free space already accounts for the reserved zone.
    expect(free).toBe(Math.max(0, capacity - used - reserved));
  });

  it('I4: derives the threshold from the buffer exactly once (capacity − threshold == reserved)', () => {
    const { info, reserved, capacity } = autocompactScenario();
    expect(capacity - (info.autoCompactThreshold ?? capacity)).toBe(reserved);
  });

  it('I4: clamps free space to zero (still only one subtraction) when used + reserved >= capacity', () => {
    const { info, reserved, capacity } = autocompactScenario({
      messages: 260000,
      reserved: 20000,
      window: 272000,
    });
    const used = nonFreeSum(info);
    const free = info.breakdown['Free space']?.tokens ?? 0;
    expect(free).toBe(0);
    expect(capacity - (info.autoCompactThreshold ?? capacity)).toBe(reserved);
    // Even clamped, the reserved buffer is not also inflated into usage.
    expect(used).toBe(info.totalUsed);
  });

  it('holds across randomized buffer sizes and capacities', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const rng = makeRng(seed + 700);
      const capacity = [200000, 262144, 1_000_000][Math.floor(rng() * 3)];
      const reserved = Math.floor(rng() * (capacity * 0.3)) + 1;
      const used = Math.floor(rng() * capacity);
      const { info } = autocompactScenario({
        messages: used,
        reserved,
        window: capacity,
      });
      expect(info.breakdown['Reserved for Autocompact'], `seed=${seed}`).toBeUndefined();
      const free = info.breakdown['Free space']?.tokens ?? 0;
      const sumUsed = nonFreeSum(info);
      // I4 accounting identity, clamped form.
      expect(free, `seed=${seed}`).toBe(Math.max(0, capacity - sumUsed - reserved));
      // Threshold carries the buffer exactly once.
      if (reserved < capacity) {
        expect(capacity - (info.autoCompactThreshold ?? capacity), `seed=${seed}`).toBe(reserved);
      }
    }
  });
});

// ---------------------------------------------- SDKMessageHandler test harness

/**
 * Lean harness for the usage-accounting code paths. The handler is constructed
 * exactly as in production; only the I/O collaborators (db, messageHub,
 * internalEventBus, stateManager) are mocked so assertions run on the
 * accumulated session metadata and persisted messages.
 */
function createHandler(): {
  handler: SDKMessageHandler;
  session: Session;
  saveSpy: ReturnType<typeof mock>;
  updateSpy: ReturnType<typeof mock>;
} {
  const session: Session = {
    id: 'invariant-session',
    title: 'Invariant Session',
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

  const saveSpy = mock(() => true);
  const updateSpy = mock(() => {});
  const db = {
    saveSDKMessage: saveSpy,
    updateSession: updateSpy,
    getMessagesByStatus: mock(() => []),
    getMessageByStatusAndUuid: mock(() => null),
    updateMessageStatus: mock(() => {}),
    updateMessageTimestamp: mock(() => {}),
    beginTransaction: mock(() => {}),
    commitTransaction: mock(() => {}),
    abortTransaction: mock(() => {}),
  } as unknown as Database;

  const messageHub = {
    event: mock(() => {}),
    onRequest: mock(() => () => {}),
    query: mock(async () => ({})),
    command: mock(async () => {}),
  } as unknown as MessageHub;

  const publish = mock(async () => {});
  const internalEventBus = {
    publish,
    publishAsync: publish,
    subscribe: mock(() => () => {}),
  } as unknown as InternalEventBus<Record<string, unknown>>;

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
    shouldCompactAt: mock(() => false),
    markCompactionTriggered: mock(() => {}),
  } as unknown as ContextTracker;

  const messageQueue = {
    enqueue: mock(async () => 'context-id'),
    enqueueWithId: mock(async () => {}),
    clear: mock(() => {}),
  } as unknown as MessageQueue;

  const errorManager = { handleError: mock(async () => {}) } as unknown as ErrorManager;
  const lifecycleManager = { stop: mock(async () => {}) } as unknown as QueryLifecycleManager;

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
    queryObject: null,
    queryPromise: null,
    onInitSlashCommands: mock(async () => {}),
    onCommandsChanged: mock(async () => {}),
  };

  return { handler: new SDKMessageHandler(ctx), session, saveSpy, updateSpy };
}

// Message builders ------------------------------------------------------------

function thinkingTokensMsg(uuid: string, estimated: number): SDKMessage {
  return {
    type: 'system',
    subtype: 'thinking_tokens',
    uuid,
    session_id: 'invariant-session',
    estimated_tokens: estimated,
    estimated_tokens_delta: estimated,
  } as unknown as SDKMessage;
}

function thinkingAssistant(uuid: string): SDKMessage {
  return {
    type: 'assistant',
    uuid,
    session_id: 'invariant-session',
    message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'chunk' }] },
    parent_tool_use_id: null,
  } as unknown as SDKMessage;
}

function resultMsg(
  uuid: string,
  usage: { input_tokens: number; output_tokens: number },
  costUsd: number
): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    uuid,
    usage: {
      ...usage,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    total_cost_usd: costUsd,
    modelUsage: {},
  } as unknown as SDKMessage;
}

function sessionStateIdleMsg(uuid: string): SDKMessage {
  return {
    type: 'system',
    subtype: 'session_state_changed',
    uuid,
    session_id: 'invariant-session',
    state: 'idle',
  } as unknown as SDKMessage;
}

function initMsg(uuid: string): SDKMessage {
  return {
    type: 'system',
    subtype: 'init',
    uuid,
    session_id: 'invariant-session',
    slash_commands: [],
  } as unknown as SDKMessage;
}

function apiRetryMsg(uuid: string): SDKMessage {
  return {
    type: 'system',
    subtype: 'api_retry',
    uuid,
    session_id: 'retry-session',
    attempt: 1,
    max_retries: 3,
    retry_delay_ms: 1000,
    error_status: 429,
    error: 'rate_limit',
  } as unknown as SDKMessage;
}

/** Read the `estimated_thinking_tokens` stamped on a persisted assistant message. */
function stampedDelta(saveSpy: ReturnType<typeof mock>, uuid: string): number | undefined {
  const call = saveSpy.mock.calls.find((c) => (c[1] as SDKMessage).uuid === uuid);
  if (!call) return undefined;
  const value = (call[1] as Record<string, unknown>).estimated_thinking_tokens;
  return typeof value === 'number' ? value : undefined;
}

// --------------------------------------------- thinking_tokens delta invariants

describe('thinking_tokens delta invariants (I6, I7, I8)', () => {
  let handler: SDKMessageHandler;
  let saveSpy: ReturnType<typeof mock>;

  beforeEach(() => {
    const harness = createHandler();
    handler = harness.handler;
    saveSpy = harness.saveSpy;
  });

  it('I6: stamped deltas within a turn sum to the turn peak (no re-count)', async () => {
    // Non-decreasing cumulative estimate, split across several assistant
    // blocks. Each increase is attributed to exactly one block.
    const peaks = [100, 250, 250, 400, 400, 600];
    for (let i = 0; i < peaks.length; i++) {
      await handler.handleMessage(thinkingTokensMsg(`tt-${i}`, peaks[i]));
      await handler.handleMessage(thinkingAssistant(`a-${i}`));
    }
    const stamps: number[] = [];
    for (let i = 0; i < peaks.length; i++) {
      const d = stampedDelta(saveSpy, `a-${i}`);
      if (d !== undefined) stamps.push(d);
    }
    const sum = stamps.reduce((acc, d) => acc + d, 0);
    expect(sum).toBe(600); // final cumulative peak — counted once, not summed per block
    // No single stamp may exceed the increment since the previous stamp.
    expect(stamps.every((d) => d > 0)).toBe(true);
  });

  it('I6: holds across 50 randomized non-decreasing cumulative sequences', async () => {
    for (let seed = 1; seed <= 50; seed++) {
      const harness = createHandler();
      handler = harness.handler;
      saveSpy = harness.saveSpy;
      const rng = makeRng(seed + 3000);
      const len = 3 + Math.floor(rng() * 6);
      let current = Math.floor(rng() * 200) + 1;
      const peaks = [current];
      for (let i = 1; i < len; i++) {
        // Non-decreasing with frequent plateaus (the stuck-cumulative shape).
        current = rng() < 0.4 ? current : current + Math.floor(rng() * 300) + 1;
        peaks.push(current);
      }
      for (let i = 0; i < peaks.length; i++) {
        await handler.handleMessage(thinkingTokensMsg(`tt-${seed}-${i}`, peaks[i]));
        await handler.handleMessage(thinkingAssistant(`a-${seed}-${i}`));
      }
      const stamps: number[] = [];
      for (let i = 0; i < peaks.length; i++) {
        const d = stampedDelta(saveSpy, `a-${seed}-${i}`);
        if (d !== undefined) stamps.push(d);
      }
      const sum = stamps.reduce((acc, d) => acc + d, 0);
      expect(sum, `seed=${seed} peaks=${peaks.join(',')}`).toBe(peaks[peaks.length - 1]);
    }
  });

  it('I7: a stuck cumulative estimate stamps once, not once per block (#614)', async () => {
    const estimate = 814;
    await handler.handleMessage(thinkingTokensMsg('tt-0', estimate));
    for (let i = 0; i < 4; i++) {
      if (i > 0) {
        // Provider keeps emitting the same cumulative total.
        await handler.handleMessage(thinkingTokensMsg(`tt-${i}`, estimate));
      }
      await handler.handleMessage(thinkingAssistant(`a-${i}`));
    }
    const stamps: number[] = [];
    for (let i = 0; i < 4; i++) {
      const d = stampedDelta(saveSpy, `a-${i}`);
      if (d !== undefined) stamps.push(d);
    }
    expect(stamps).toEqual([estimate]); // only the first block stamps
    expect(stamps.reduce((acc, d) => acc + d, 0)).toBe(estimate); // not estimate * 4
  });

  it('I8: a result message resets the baseline so the next turn stamps its own estimate', async () => {
    await handler.handleMessage(thinkingTokensMsg('tt-1', 500));
    await handler.handleMessage(thinkingAssistant('a-1'));
    expect(stampedDelta(saveSpy, 'a-1')).toBe(500);

    // Turn end resets tracking.
    await handler.handleMessage(resultMsg('r-1', { input_tokens: 10, output_tokens: 5 }, 0.001));

    // New turn: its first block must stamp its own estimate, not estimate − 500.
    await handler.handleMessage(thinkingTokensMsg('tt-2', 300));
    await handler.handleMessage(thinkingAssistant('a-2'));
    expect(stampedDelta(saveSpy, 'a-2')).toBe(300);
  });

  it('I8: a session_state_changed idle resets the baseline', async () => {
    await handler.handleMessage(thinkingTokensMsg('tt-1', 500));
    await handler.handleMessage(thinkingAssistant('a-1'));

    await handler.handleMessage(sessionStateIdleMsg('idle-1'));

    await handler.handleMessage(thinkingTokensMsg('tt-2', 200));
    await handler.handleMessage(thinkingAssistant('a-2'));
    expect(stampedDelta(saveSpy, 'a-2')).toBe(200);
  });

  it('I8: an init message resets the baseline', async () => {
    await handler.handleMessage(thinkingTokensMsg('tt-1', 500));
    await handler.handleMessage(thinkingAssistant('a-1'));

    await handler.handleMessage(initMsg('init-1'));

    await handler.handleMessage(thinkingTokensMsg('tt-2', 200));
    await handler.handleMessage(thinkingAssistant('a-2'));
    expect(stampedDelta(saveSpy, 'a-2')).toBe(200);
  });
});

// -------------------------------------------------------- api_retry invariant

describe('api_retry usage invariants (I9)', () => {
  let handler: SDKMessageHandler;
  let session: Session;

  beforeEach(() => {
    const harness = createHandler();
    handler = harness.handler;
    session = harness.session;
  });

  it('I9: an api_retry message mutates zero usage counters', async () => {
    // Seed non-zero counters so a regression that adds tokens is detectable.
    session.metadata = {
      messageCount: 7,
      totalTokens: 1234,
      inputTokens: 1000,
      outputTokens: 234,
      totalCost: 0.42,
      toolCallCount: 3,
    };
    const before = { ...session.metadata };

    await handler.handleMessage(apiRetryMsg('retry-1'));

    // api_retry carries operational metadata only; it must not feed token/cost
    // accounting (retried-request tokens are billed via the normal result path).
    expect(session.metadata?.totalTokens).toBe(before.totalTokens);
    expect(session.metadata?.inputTokens).toBe(before.inputTokens);
    expect(session.metadata?.outputTokens).toBe(before.outputTokens);
    expect(session.metadata?.totalCost).toBe(before.totalCost);
    expect(session.metadata?.messageCount).toBe(before.messageCount);
    expect(session.metadata?.toolCallCount).toBe(before.toolCallCount);
  });

  it('I9: a retry followed by a successful result bills tokens exactly once (via the result path)', async () => {
    await handler.handleMessage(apiRetryMsg('retry-1'));
    await handler.handleMessage(resultMsg('r-1', { input_tokens: 100, output_tokens: 50 }, 0.001));
    // Only the single result message's tokens are accumulated.
    expect(session.metadata?.totalTokens).toBe(150);
    expect(session.metadata?.inputTokens).toBe(100);
    expect(session.metadata?.outputTokens).toBe(50);
  });
});

// ----------------------------------------- token + cost accumulation invariants

describe('token + cost accumulation invariants (I10, I11)', () => {
  let handler: SDKMessageHandler;
  let session: Session;

  beforeEach(() => {
    const harness = createHandler();
    handler = harness.handler;
    session = harness.session;
  });

  it('I10: totalTokens == inputTokens + outputTokens and totals are monotonic across turns', async () => {
    const turns = [
      { input_tokens: 100, output_tokens: 50 },
      { input_tokens: 0, output_tokens: 0 }, // zero-token result (synthetic) must not break the identity
      { input_tokens: 320, output_tokens: 180 },
      { input_tokens: 75, output_tokens: 25 },
    ];
    let expectedInput = 0;
    let expectedOutput = 0;
    let prevTotal = -1;
    for (let i = 0; i < turns.length; i++) {
      await handler.handleMessage(resultMsg(`r-${i}`, turns[i], 0.001 * (i + 1)));
      expectedInput += turns[i].input_tokens;
      expectedOutput += turns[i].output_tokens;
      const inputTokens = session.metadata?.inputTokens ?? 0;
      const outputTokens = session.metadata?.outputTokens ?? 0;
      const totalTokens = session.metadata?.totalTokens ?? 0;
      expect(inputTokens, `turn ${i}`).toBe(expectedInput);
      expect(outputTokens, `turn ${i}`).toBe(expectedOutput);
      // I10 exactness invariant.
      expect(totalTokens, `turn ${i}`).toBe(inputTokens + outputTokens);
      expect(totalTokens).toBe(expectedInput + expectedOutput);
      // Monotonic non-decreasing.
      expect(totalTokens).toBeGreaterThanOrEqual(prevTotal);
      prevTotal = totalTokens;
    }
  });

  it('I11: totalCost is monotonic across an SDK restart; each run counted once', async () => {
    // Run 1: cumulative cost climbs. Run 2: SDK restarted, cost drops then
    // climbs again. The baseline fold must count run 1's peak exactly once.
    const sequence = [
      { cost: 0.42, expectedTotal: 0.42 },
      { cost: 0.73, expectedTotal: 0.73 },
      { cost: 0.25, expectedTotal: 0.98 }, // restart: fold 0.73 once, +0.25
      { cost: 0.5, expectedTotal: 1.23 }, // continue run 2
    ];
    let prev = -Infinity;
    for (let i = 0; i < sequence.length; i++) {
      await handler.handleMessage(
        resultMsg(`r-${i}`, { input_tokens: 10, output_tokens: 5 }, sequence[i].cost)
      );
      const total = session.metadata?.totalCost ?? 0;
      // Monotonic non-decreasing across the restart.
      expect(total, `step ${i}`).toBeGreaterThanOrEqual(prev - 1e-9);
      // Each run's cumulative total counted exactly once.
      expect(approxEqual(total, sequence[i].expectedTotal), `step ${i}`).toBe(true);
      prev = total;
    }
    // Final = run-1 peak (0.73) + run-2 peak (0.50), no double count of the
    // pre-restart total and no loss of the restarted run.
    expect(approxEqual(session.metadata?.totalCost ?? 0, 0.73 + 0.5)).toBe(true);
  });
});
