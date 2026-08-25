import type {
  HookCallback,
  PostToolUseFailureHookInput,
  PostToolUseHookInput,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import { Logger } from '../logger.ts';
import {
  advanceLoopStreak,
  bashFingerprintKey,
  buildArgKey,
  decideBashDeadLoop,
  decideIdenticalArgsLoop,
  evaluateBashFailureRing,
  recordBashRingOutcome,
  scopeKey,
  summariseArgs,
  type BashFailureRing,
  type LoopStreakState,
} from './loop-detector-gates.ts';

export interface LoopDetectorConfig {
  enabled: boolean;
  windowMs: number;
  thresholds?: Record<string, number>;
  bash?: BashLoopConfig;
}

export interface BashLoopConfig {
  enabled: boolean;
  threshold: number;
  failuresRequired: number;
}

export const DEFAULT_LOOP_DETECTOR_CONFIG: Required<LoopDetectorConfig> = {
  enabled: true,
  windowMs: 60_000,
  thresholds: {
    Read: 3,
    Grep: 5,
    Glob: 5,
  },
  bash: {
    enabled: true,
    threshold: 5,
    failuresRequired: 5,
  },
};

interface LoopDetectorState {
  ledger: Map<string, LoopStreakState>;
  bashFailures: Map<string, BashFailureRing>;
}

function createState(): LoopDetectorState {
  return {
    ledger: new Map(),
    bashFailures: new Map(),
  };
}

function sweepLedger(state: LoopDetectorState, now: number, windowMs: number): void {
  if (state.ledger.size > 256) {
    for (const [k, v] of state.ledger) {
      if (now - v.entry.lastSeenMs > windowMs) state.ledger.delete(k);
    }
  }
}

function recordBashOutcome(
  state: LoopDetectorState,
  scope: string,
  fingerprint: string,
  failed: boolean,
  finalConfig: Required<LoopDetectorConfig>,
  now: number
): void {
  const key = bashFingerprintKey(scope, fingerprint);
  state.bashFailures.set(
    key,
    recordBashRingOutcome({
      prev: state.bashFailures.get(key),
      failed,
      failuresRequired: finalConfig.bash.failuresRequired,
      now,
      windowMs: finalConfig.windowMs,
    })
  );
  if (state.bashFailures.size > 256) {
    for (const [k, v] of state.bashFailures) {
      if (now - v.lastSeenMs > finalConfig.windowMs) state.bashFailures.delete(k);
    }
  }
}

function resolveConfig(config: Partial<LoopDetectorConfig>): Required<LoopDetectorConfig> {
  const bashDefaults = DEFAULT_LOOP_DETECTOR_CONFIG.bash;
  const bashOverride = config.bash;
  return {
    enabled: config.enabled ?? DEFAULT_LOOP_DETECTOR_CONFIG.enabled,
    windowMs: config.windowMs ?? DEFAULT_LOOP_DETECTOR_CONFIG.windowMs,
    thresholds: config.thresholds ?? DEFAULT_LOOP_DETECTOR_CONFIG.thresholds,
    bash: bashOverride
      ? {
          enabled: bashOverride.enabled ?? bashDefaults.enabled,
          threshold: bashOverride.threshold ?? bashDefaults.threshold,
          failuresRequired: bashOverride.failuresRequired ?? bashDefaults.failuresRequired,
        }
      : bashDefaults,
  };
}

function buildPreToolUseCallback(
  state: LoopDetectorState,
  finalConfig: Required<LoopDetectorConfig>,
  logger: Logger
): HookCallback {
  return async (input, _toolUseID, { signal: _signal }) => {
    if (!finalConfig.enabled) return {};
    if (input.hook_event_name !== 'PreToolUse') return {};

    const preInput = input as PreToolUseHookInput;
    const { tool_name, tool_input, cwd, session_id, agent_id } = preInput;

    const scope = scopeKey({ session_id, agent_id });
    const threshold = finalConfig.thresholds[tool_name];
    const isBash = tool_name === 'Bash' && finalConfig.bash.enabled;
    const now = Date.now();

    if (typeof threshold !== 'number' && !isBash) {
      state.ledger.delete(scope);
      return {};
    }

    const args = (tool_input ?? {}) as Record<string, unknown>;
    const key = `${tool_name}:${buildArgKey(tool_name, args, cwd)}`;

    const streak = advanceLoopStreak({
      prev: state.ledger.get(scope),
      key,
      now,
      windowMs: finalConfig.windowMs,
    });
    state.ledger.set(scope, streak);
    sweepLedger(state, now, finalConfig.windowMs);

    if (isBash) {
      if (streak.entry.count >= finalConfig.bash.threshold) {
        const fingerprint = buildArgKey('Bash', args, cwd);
        const ringKey = bashFingerprintKey(scope, fingerprint);
        const ring = evaluateBashFailureRing({
          ring: state.bashFailures.get(ringKey),
          now,
          windowMs: finalConfig.windowMs,
        });
        if (ring.expired) state.bashFailures.delete(ringKey);
        const decision = decideBashDeadLoop({
          count: streak.entry.count,
          threshold: finalConfig.bash.threshold,
          failuresRequired: finalConfig.bash.failuresRequired,
          ring,
          input: args,
        });
        if (decision.action === 'deny') {
          logger.warn(
            `Bash dead-loop detected (scope=${scope}): same command ${streak.entry.count}x in a row, last ${ring.length} all failed (${summariseArgs('Bash', args)}); denying.`
          );
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse' as const,
              permissionDecision: 'deny' as const,
              permissionDecisionReason: decision.reason,
            },
          };
        }
      }
      return {};
    }

    const decision = decideIdenticalArgsLoop({
      toolName: tool_name,
      count: streak.entry.count,
      threshold,
      input: args,
    });
    if (decision.action === 'deny') {
      logger.warn(
        `Dead-loop detected (scope=${scope}): ${tool_name} called ${streak.entry.count}x in a row with identical args (${summariseArgs(tool_name, args)}); denying.`
      );
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: 'deny' as const,
          permissionDecisionReason: decision.reason,
        },
      };
    }

    return {};
  };
}

function buildPostToolUseCallback(
  state: LoopDetectorState,
  finalConfig: Required<LoopDetectorConfig>
): HookCallback {
  return async (input, _toolUseID, { signal: _signal }) => {
    if (!finalConfig.enabled) return {};
    if (!finalConfig.bash.enabled) return {};
    if (input.hook_event_name !== 'PostToolUse') return {};

    const postInput = input as PostToolUseHookInput;
    if (postInput.tool_name !== 'Bash') return {};

    const args = (postInput.tool_input ?? {}) as Record<string, unknown>;
    const fingerprint = buildArgKey('Bash', args, postInput.cwd);
    recordBashOutcome(state, scopeKey(postInput), fingerprint, false, finalConfig, Date.now());
    return {};
  };
}

function buildPostToolUseFailureCallback(
  state: LoopDetectorState,
  finalConfig: Required<LoopDetectorConfig>
): HookCallback {
  return async (input, _toolUseID, { signal: _signal }) => {
    if (!finalConfig.enabled) return {};
    if (!finalConfig.bash.enabled) return {};
    if (input.hook_event_name !== 'PostToolUseFailure') return {};

    const postInput = input as PostToolUseFailureHookInput;
    if (postInput.tool_name !== 'Bash') return {};
    if (postInput.is_interrupt === true) return {};

    const args = (postInput.tool_input ?? {}) as Record<string, unknown>;
    const fingerprint = buildArgKey('Bash', args, postInput.cwd);
    recordBashOutcome(state, scopeKey(postInput), fingerprint, true, finalConfig, Date.now());
    return {};
  };
}

export function createLoopDetectorHook(config: Partial<LoopDetectorConfig> = {}): HookCallback {
  const finalConfig = resolveConfig(config);
  const logger = new Logger('LoopDetectorHook');
  const state = createState();
  return buildPreToolUseCallback(state, finalConfig, logger);
}

export function createLoopDetectorHooks(config: Partial<LoopDetectorConfig> = {}): {
  preToolUse: HookCallback;
  postToolUse: HookCallback;
  postToolUseFailure: HookCallback;
} {
  const finalConfig = resolveConfig(config);
  const logger = new Logger('LoopDetectorHook');
  const state = createState();
  return {
    preToolUse: buildPreToolUseCallback(state, finalConfig, logger),
    postToolUse: buildPostToolUseCallback(state, finalConfig),
    postToolUseFailure: buildPostToolUseFailureCallback(state, finalConfig),
  };
}
