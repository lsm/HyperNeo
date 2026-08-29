import { describe, expect, it, mock } from 'bun:test';

import type { SDKMessage } from '@hyperneo/shared/sdk';
import type {
  SdkStartClassification,
  SdkStartObservation,
} from '../../../../src/lib/agent/sdk-start-terminal';
import {
  classifyStartupWatch,
  DEFAULT_SDK_START_INACTIVITY_BACKSTOP_MS,
  DEFAULT_SDK_STARTUP_NUDGE_THRESHOLD_MS,
  decideStartupWatchAction,
  emitStartupWatchOutcome,
  getSdkStartInactivityBackstopMs,
  observeStartupWatchEvent,
  runStartupWatch,
  type StartupWatchCtx,
  type StartupWatchDeps,
  type StartupWatchEvent,
  type StartupWatchOutcome,
} from '../../../../src/lib/agent/startup-watch-pipeline';

function msg(fields: Record<string, unknown>): SDKMessage {
  return fields as unknown as SDKMessage;
}

function assistantMessage(): SDKMessage {
  return msg({ type: 'assistant' });
}

function statusBlip(): SDKMessage {
  return msg({ type: 'system', subtype: 'status', status: 'connected' });
}

function watchEvent(overrides: Partial<StartupWatchEvent> = {}): StartupWatchEvent {
  return { processExit: null, streamClosed: false, messages: [], inactivity: null, ...overrides };
}

function observation(overrides: Partial<SdkStartObservation> = {}): SdkStartObservation {
  return { processExit: null, streamClosed: false, messages: [], inactivity: null, ...overrides };
}

function watchCtx(overrides: Partial<StartupWatchCtx> = {}): StartupWatchCtx {
  return {
    event: watchEvent(),
    deps: {},
    observation: null,
    classification: null,
    outcome: null,
    emitted: false,
    ...overrides,
  };
}

function decideCtx(
  classification: SdkStartClassification,
  inactivity: SdkStartObservation['inactivity'] = null,
  deps: StartupWatchDeps = {}
): StartupWatchCtx {
  return watchCtx({
    classification,
    observation: observation({ inactivity }),
    deps,
  });
}

describe('getSdkStartInactivityBackstopMs', () => {
  const rows: Array<[Record<string, string>, number]> = [
    [{}, DEFAULT_SDK_START_INACTIVITY_BACKSTOP_MS],
    [{ HYPERNEO_SDK_START_INACTIVITY_TIMEOUT_MS: '900000' }, 900_000],
    [{ HYPERNEO_SDK_START_INACTIVITY_TIMEOUT_MS: 'abc' }, DEFAULT_SDK_START_INACTIVITY_BACKSTOP_MS],
    [{ HYPERNEO_SDK_START_INACTIVITY_TIMEOUT_MS: '0' }, DEFAULT_SDK_START_INACTIVITY_BACKSTOP_MS],
  ];
  for (const [env, expected] of rows) {
    it(`resolves ${JSON.stringify(env)} to ${expected}`, () => {
      expect(getSdkStartInactivityBackstopMs(env)).toBe(expected);
    });
  }
});

describe('observeStartupWatchEvent', () => {
  it('copies a complete event into the observation verbatim', () => {
    const event = watchEvent({
      processExit: { code: 1, signal: null },
      streamClosed: true,
      messages: [assistantMessage()],
      inactivity: { elapsedMs: 42, lastActivityAt: 7 },
    });
    expect(observeStartupWatchEvent(watchCtx({ event })).observation).toEqual(
      observation({
        processExit: { code: 1, signal: null },
        streamClosed: true,
        messages: [assistantMessage()],
        inactivity: { elapsedMs: 42, lastActivityAt: 7 },
      })
    );
  });

  it('normalizes a partial runtime event', () => {
    const raw = { streamClosed: true } as unknown as StartupWatchEvent;
    expect(observeStartupWatchEvent(watchCtx({ event: raw })).observation).toEqual(
      observation({ streamClosed: true })
    );
  });
});

describe('classifyStartupWatch', () => {
  it('applies the explicit inactivityBackstopMs dep', () => {
    const ctx = classifyStartupWatch(
      watchCtx({
        observation: observation({ inactivity: { elapsedMs: 250_000, lastActivityAt: 1 } }),
        deps: { inactivityBackstopMs: 300_000 },
      })
    );
    expect(ctx.classification).toEqual({
      outcome: 'backstop',
      inactivity: { elapsedMs: 250_000, lastActivityAt: 1 },
    });
  });

  it('prefers an explicit dep over the env dep', () => {
    const ctx = classifyStartupWatch(
      watchCtx({
        observation: observation({ inactivity: { elapsedMs: 250_000, lastActivityAt: null } }),
        deps: {
          inactivityBackstopMs: 600_000,
          env: { HYPERNEO_SDK_START_INACTIVITY_TIMEOUT_MS: '250000' },
        },
      })
    );
    expect(ctx.classification).toEqual({ outcome: 'alive', progress: false });
  });
});

interface DecideRow {
  name: string;
  classification: SdkStartClassification;
  inactivity?: SdkStartObservation['inactivity'];
  deps?: StartupWatchDeps;
  expected: StartupWatchOutcome;
}

const decideTable: DecideRow[] = [
  {
    name: 'process exit pre-first-message retries dead with exit info',
    classification: {
      outcome: 'dead',
      reason: 'process_exit',
      exitInfo: { code: 1, signal: null },
    },
    expected: { action: 'retry-dead', reason: 'process_exit', exitInfo: { code: 1, signal: null } },
  },
  {
    name: 'stream close pre-first-message retries dead without exit info',
    classification: { outcome: 'dead', reason: 'stream_closed' },
    expected: { action: 'retry-dead', reason: 'stream_closed', exitInfo: null },
  },
  {
    name: 'backstop classification aborts with its inactivity',
    classification: { outcome: 'backstop', inactivity: { elapsedMs: 600_000, lastActivityAt: 3 } },
    expected: { action: 'abort-backstop', inactivity: { elapsedMs: 600_000, lastActivityAt: 3 } },
  },
  {
    name: 'meaningful progress continues and disarms',
    classification: { outcome: 'alive', progress: true },
    inactivity: { elapsedMs: 900_000, lastActivityAt: 1 },
    expected: { action: 'continue', disarmed: true },
  },
  {
    name: 'inactivity at the nudge threshold nudges slow',
    classification: { outcome: 'alive', progress: false },
    inactivity: { elapsedMs: DEFAULT_SDK_STARTUP_NUDGE_THRESHOLD_MS, lastActivityAt: 2 },
    expected: { action: 'nudge-slow', inactivity: { elapsedMs: 60_000, lastActivityAt: 2 } },
  },
  {
    name: 'inactivity between nudge and backstop still only nudges, never aborts',
    classification: { outcome: 'alive', progress: false },
    inactivity: { elapsedMs: 599_999, lastActivityAt: 2 },
    expected: { action: 'nudge-slow', inactivity: { elapsedMs: 599_999, lastActivityAt: 2 } },
  },
  {
    name: 'inactivity below the nudge threshold keeps watching',
    classification: { outcome: 'alive', progress: false },
    inactivity: { elapsedMs: 59_999, lastActivityAt: 2 },
    expected: { action: 'continue', disarmed: false },
  },
  {
    name: 'custom nudge threshold dep is honored',
    classification: { outcome: 'alive', progress: false },
    inactivity: { elapsedMs: 5_000, lastActivityAt: 2 },
    deps: { nudgeThresholdMs: 5_000 },
    expected: { action: 'nudge-slow', inactivity: { elapsedMs: 5_000, lastActivityAt: 2 } },
  },
];

describe('decideStartupWatchAction decision table', () => {
  for (const row of decideTable) {
    it(row.name, () => {
      const ctx = decideStartupWatchAction(
        decideCtx(row.classification, row.inactivity ?? null, row.deps ?? {})
      );
      expect(ctx.outcome).toEqual(row.expected);
    });
  }

  it('passes the ctx through untouched without a classification', () => {
    const ctx = watchCtx();
    expect(decideStartupWatchAction(ctx)).toEqual(ctx);
  });
});

describe('emitStartupWatchOutcome', () => {
  it('awaits the emitter with the outcome and marks emitted', async () => {
    const emitOutcome = mock(async () => {});
    const outcome: StartupWatchOutcome = { action: 'continue', disarmed: false };
    const ctx = await emitStartupWatchOutcome(watchCtx({ deps: { emitOutcome }, outcome }));
    expect(emitOutcome).toHaveBeenCalledTimes(1);
    expect(emitOutcome.mock.calls[0][0]).toEqual(outcome);
    expect(ctx.emitted).toBe(true);
  });

  it('marks emitted without an emitter dep and swallows emitter failures', async () => {
    const bare = await emitStartupWatchOutcome(
      watchCtx({ outcome: { action: 'continue', disarmed: true } })
    );
    expect(bare.emitted).toBe(true);
    const failing = await emitStartupWatchOutcome(
      watchCtx({
        deps: {
          emitOutcome: () => {
            throw new Error('sink down');
          },
        },
        outcome: { action: 'nudge-slow', inactivity: { elapsedMs: 61_000, lastActivityAt: 1 } },
      })
    );
    expect(failing.emitted).toBe(true);
  });
});

interface PipelineRow {
  name: string;
  event: Partial<StartupWatchEvent>;
  deps?: StartupWatchDeps;
  expected: StartupWatchOutcome;
}

const pipelineTable: PipelineRow[] = [
  {
    name: 'meaningful message continues and disarms',
    event: { messages: [statusBlip(), assistantMessage()] },
    expected: { action: 'continue', disarmed: true },
  },
  {
    name: 'process exit pre-first-message retries dead',
    event: { processExit: { code: null, signal: 'SIGKILL' } },
    expected: {
      action: 'retry-dead',
      reason: 'process_exit',
      exitInfo: { code: null, signal: 'SIGKILL' },
    },
  },
  {
    name: 'default thresholds nudge at sixty seconds',
    event: { inactivity: { elapsedMs: 60_000, lastActivityAt: 2 } },
    expected: { action: 'nudge-slow', inactivity: { elapsedMs: 60_000, lastActivityAt: 2 } },
  },
  {
    name: 'default backstop aborts at ten minutes',
    event: { inactivity: { elapsedMs: 600_000, lastActivityAt: null } },
    expected: {
      action: 'abort-backstop',
      inactivity: { elapsedMs: 600_000, lastActivityAt: null },
    },
  },
  {
    name: 'env-configured backstop aborts',
    event: { inactivity: { elapsedMs: 250_000, lastActivityAt: null } },
    deps: { env: { HYPERNEO_SDK_START_INACTIVITY_TIMEOUT_MS: '250000' } },
    expected: {
      action: 'abort-backstop',
      inactivity: { elapsedMs: 250_000, lastActivityAt: null },
    },
  },
  {
    name: 'bare event keeps watching',
    event: {},
    expected: { action: 'continue', disarmed: false },
  },
];

describe('runStartupWatch end-to-end', () => {
  for (const row of pipelineTable) {
    it(row.name, async () => {
      expect(await runStartupWatch(row.deps ?? {}, watchEvent(row.event))).toEqual(row.expected);
    });
  }

  it('is idempotent once disarmed', async () => {
    const event = watchEvent({ messages: [assistantMessage()] });
    expect(await runStartupWatch({}, event)).toEqual({ action: 'continue', disarmed: true });
    expect(await runStartupWatch({}, event)).toEqual({ action: 'continue', disarmed: true });
  });
});
