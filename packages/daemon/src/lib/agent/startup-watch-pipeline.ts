import type { SDKMessage } from '@hyperneo/shared/sdk';
import superpipe, { type PipelineAPI } from 'superpipe';
import type {
  SdkStartClassification,
  SdkStartExitInfo,
  SdkStartInactivity,
  SdkStartObservation,
} from './sdk-start-terminal.ts';
import { classifySdkStartOutcome } from './sdk-start-terminal.ts';

export const DEFAULT_SDK_STARTUP_NUDGE_THRESHOLD_MS = 60_000;
export const DEFAULT_SDK_START_INACTIVITY_BACKSTOP_MS = 600_000;

export function getSdkStartInactivityBackstopMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.HYPERNEO_SDK_START_INACTIVITY_TIMEOUT_MS;
  if (!raw) return DEFAULT_SDK_START_INACTIVITY_BACKSTOP_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SDK_START_INACTIVITY_BACKSTOP_MS;
}

export type StartupWatchEvent = {
  processExit: SdkStartExitInfo | null;
  streamClosed: boolean;
  messages: SDKMessage[];
  inactivity: SdkStartInactivity | null;
};

export type StartupWatchOutcome =
  | { action: 'continue'; disarmed: boolean }
  | { action: 'nudge-slow'; inactivity: SdkStartInactivity }
  | {
      action: 'retry-dead';
      reason: 'process_exit' | 'stream_closed';
      exitInfo: SdkStartExitInfo | null;
    }
  | { action: 'abort-backstop'; inactivity: SdkStartInactivity };

export interface StartupWatchDeps {
  nudgeThresholdMs?: number;
  inactivityBackstopMs?: number;
  env?: NodeJS.ProcessEnv;
  emitOutcome?: (outcome: StartupWatchOutcome) => void | Promise<void>;
}

export interface StartupWatchCtx {
  event: StartupWatchEvent;
  deps: StartupWatchDeps;
  observation: SdkStartObservation | null;
  classification: SdkStartClassification | null;
  outcome: StartupWatchOutcome | null;
  emitted: boolean;
}

export function observeStartupWatchEvent(ctx: StartupWatchCtx): StartupWatchCtx {
  const event = ctx.event;
  return {
    ...ctx,
    observation: {
      processExit: event.processExit ?? null,
      streamClosed: event.streamClosed === true,
      messages: Array.isArray(event.messages) ? event.messages : [],
      inactivity: event.inactivity ?? null,
    },
  };
}

export function classifyStartupWatch(ctx: StartupWatchCtx): StartupWatchCtx {
  const observation = ctx.observation ?? {
    processExit: null,
    streamClosed: false,
    messages: [],
    inactivity: null,
  };
  return {
    ...ctx,
    classification: classifySdkStartOutcome(observation, {
      inactivityBackstopMs:
        ctx.deps.inactivityBackstopMs ?? getSdkStartInactivityBackstopMs(ctx.deps.env),
    }),
  };
}

export function decideStartupWatchAction(ctx: StartupWatchCtx): StartupWatchCtx {
  const classification = ctx.classification;
  if (classification === null) return ctx;
  if (classification.outcome === 'dead') {
    return {
      ...ctx,
      outcome: {
        action: 'retry-dead',
        reason: classification.reason,
        exitInfo: classification.reason === 'process_exit' ? classification.exitInfo : null,
      },
    };
  }
  if (classification.outcome === 'backstop') {
    return {
      ...ctx,
      outcome: { action: 'abort-backstop', inactivity: classification.inactivity },
    };
  }
  if (classification.progress) {
    return { ...ctx, outcome: { action: 'continue', disarmed: true } };
  }
  const inactivity = ctx.observation?.inactivity ?? null;
  const nudgeThresholdMs = ctx.deps.nudgeThresholdMs ?? DEFAULT_SDK_STARTUP_NUDGE_THRESHOLD_MS;
  if (inactivity !== null && inactivity.elapsedMs >= nudgeThresholdMs) {
    return { ...ctx, outcome: { action: 'nudge-slow', inactivity } };
  }
  return { ...ctx, outcome: { action: 'continue', disarmed: false } };
}

export async function emitStartupWatchOutcome(ctx: StartupWatchCtx): Promise<StartupWatchCtx> {
  const outcome = ctx.outcome;
  if (ctx.deps.emitOutcome && outcome !== null) {
    try {
      await ctx.deps.emitOutcome(outcome);
    } catch {}
  }
  return { ...ctx, emitted: true };
}

const run = (superpipe()('startup-watch') as PipelineAPI)
  .input(['ctx'])
  .pipe(observeStartupWatchEvent, 'ctx', 'ctx')
  .pipe(classifyStartupWatch, 'ctx', 'ctx')
  .pipe(decideStartupWatchAction, 'ctx', 'ctx')
  .pipe(emitStartupWatchOutcome, 'ctx', 'ctx')
  .endAsync('ctx') as (input: StartupWatchCtx) => Promise<StartupWatchCtx>;

export async function runStartupWatch(
  deps: StartupWatchDeps,
  event: StartupWatchEvent
): Promise<StartupWatchOutcome> {
  const ctx = await run({
    event,
    deps,
    observation: null,
    classification: null,
    outcome: null,
    emitted: false,
  });
  return ctx.outcome ?? { action: 'continue', disarmed: false };
}
