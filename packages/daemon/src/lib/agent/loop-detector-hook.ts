import type {
  HookCallback,
  PostToolUseFailureHookInput,
  PostToolUseHookInput,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import { resolve as resolvePath } from 'node:path';
import { Logger } from '../logger';

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

interface LedgerEntry {
  count: number;
  firstSeenMs: number;
  lastSeenMs: number;
}

interface AgentState {
  lastKey: string;
  entry: LedgerEntry;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function buildArgKey(toolName: string, input: Record<string, unknown>, cwd?: string): string {
  if (toolName === 'Read' && typeof input.file_path === 'string') {
    const normalisedPath = cwd ? resolvePath(cwd, input.file_path) : input.file_path;
    const normalised = { ...input, file_path: normalisedPath };
    return stableStringify(normalised);
  }
  if (toolName === 'Bash') {
    const { description: _description, ...rest } = input;
    const normalised = {
      ...rest,
      run_in_background: rest.run_in_background ?? false,
    };
    const withCwd = cwd ? { ...normalised, __cwd: cwd } : normalised;
    return stableStringify(withCwd);
  }
  return stableStringify(input);
}

function summariseArgs(toolName: string, input: Record<string, unknown>): string {
  const candidates: string[] = [];
  if (typeof input.file_path === 'string') candidates.push(`file_path=${input.file_path}`);
  if (typeof input.pattern === 'string') candidates.push(`pattern=${input.pattern}`);
  if (typeof input.path === 'string' && toolName !== 'Read') {
    candidates.push(`path=${input.path}`);
  }
  if (typeof input.glob === 'string') candidates.push(`glob=${input.glob}`);
  if (toolName === 'Bash' && typeof input.command === 'string') {
    candidates.push(`command=${(input.command as string).slice(0, 160)}`);
  }
  if (candidates.length === 0) return JSON.stringify(input).slice(0, 120);
  return candidates.join(', ').slice(0, 240);
}

function buildRecoveryMessage(toolName: string, count: number, argSummary: string): string {
  return [
    `Loop detected: ${toolName} was called ${count} times in a row with identical arguments (${argSummary}).`,
    'The result has not changed since the previous call. STOP re-running this tool — move on to the next step in your task.',
    'If you have a TodoWrite list, mark progress and proceed to the next item.',
    'If you genuinely need fresh data, perform a *different* action (edit a file, run a command, ask a question) before retrying.',
  ].join(' ');
}

function buildBashRecoveryMessage(count: number, argSummary: string, failures: number): string {
  return [
    `Bash dead-loop detected: the same command was run ${count} times in a row and the last ${failures} attempts all failed (${argSummary}).`,
    'Re-running the same failing command will not change the outcome. STOP and reconsider:',
    '(1) read the previous error output carefully,',
    '(2) inspect the relevant files or run a *different* diagnostic command,',
    '(3) only retry after you have changed something that could plausibly affect the outcome.',
    'If you are checking for a file or path, run a different probe (e.g. `ls` on the parent directory) instead of re-running the failing command.',
  ].join(' ');
}

interface LoopDetectorState {
  ledger: Map<string, AgentState>;
  bashFailures: Map<string, BashFailureRing>;
}

interface BashFailureRing {
  outcomes: boolean[];
  lastSeenMs: number;
}

function createState(): LoopDetectorState {
  return {
    ledger: new Map(),
    bashFailures: new Map(),
  };
}

function scopeKey(input: { session_id: string; agent_id?: string }): string {
  return `${input.session_id}::${input.agent_id ?? 'main'}`;
}

function bashFingerprintKey(scope: string, fingerprint: string): string {
  return `${scope}::${fingerprint}`;
}

function recordBashOutcome(
  state: LoopDetectorState,
  scope: string,
  fingerprint: string,
  failed: boolean,
  failuresRequired: number,
  now: number,
  windowMs: number
): void {
  const key = bashFingerprintKey(scope, fingerprint);
  const existing = state.bashFailures.get(key);
  const isStale = existing != null && now - existing.lastSeenMs > windowMs;
  const outcomes = !existing || isStale ? [] : existing.outcomes;
  outcomes.push(failed);
  while (outcomes.length > failuresRequired) outcomes.shift();
  state.bashFailures.set(key, { outcomes, lastSeenMs: now });

  if (state.bashFailures.size > 256) {
    for (const [k, v] of state.bashFailures) {
      if (now - v.lastSeenMs > windowMs) state.bashFailures.delete(k);
    }
  }
}

function lastNAllFailures(
  state: LoopDetectorState,
  scope: string,
  fingerprint: string,
  now: number,
  windowMs: number
): {
  allFailures: boolean;
  length: number;
} {
  const key = bashFingerprintKey(scope, fingerprint);
  const ring = state.bashFailures.get(key);
  if (!ring || ring.outcomes.length === 0) return { allFailures: false, length: 0 };
  if (now - ring.lastSeenMs > windowMs) {
    state.bashFailures.delete(key);
    return { allFailures: false, length: 0 };
  }
  for (const failed of ring.outcomes) {
    if (!failed) return { allFailures: false, length: ring.outcomes.length };
  }
  return { allFailures: true, length: ring.outcomes.length };
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

    const agentState = state.ledger.get(scope);
    const sameKey = agentState?.lastKey === key;
    const withinWindow = agentState && now - agentState.entry.firstSeenMs <= finalConfig.windowMs;

    const continueStreak = sameKey && withinWindow;
    const nextCount = continueStreak ? agentState!.entry.count + 1 : 1;
    const firstSeenMs = continueStreak ? agentState!.entry.firstSeenMs : now;
    state.ledger.set(scope, {
      lastKey: key,
      entry: { count: nextCount, firstSeenMs, lastSeenMs: now },
    });

    if (state.ledger.size > 256) {
      for (const [k, v] of state.ledger) {
        if (now - v.entry.lastSeenMs > finalConfig.windowMs) state.ledger.delete(k);
      }
    }

    if (isBash) {
      const bashThreshold = finalConfig.bash.threshold;
      if (nextCount >= bashThreshold) {
        const fingerprint = buildArgKey('Bash', args, cwd);
        const { allFailures, length } = lastNAllFailures(
          state,
          scope,
          fingerprint,
          now,
          finalConfig.windowMs
        );
        if (allFailures && length >= finalConfig.bash.failuresRequired) {
          const argSummary = summariseArgs('Bash', args);
          const reason = buildBashRecoveryMessage(nextCount, argSummary, length);
          logger.warn(
            `Bash dead-loop detected (scope=${scope}): same command ${nextCount}x in a row, last ${length} all failed (${argSummary}); denying.`
          );
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse' as const,
              permissionDecision: 'deny' as const,
              permissionDecisionReason: reason,
            },
          };
        }
      }
      return {};
    }

    if (typeof threshold === 'number' && nextCount >= threshold) {
      const argSummary = summariseArgs(tool_name, args);
      const reason = buildRecoveryMessage(tool_name, nextCount, argSummary);
      logger.warn(
        `Dead-loop detected (scope=${scope}): ${tool_name} called ${nextCount}x in a row with identical args (${argSummary}); denying.`
      );
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: 'deny' as const,
          permissionDecisionReason: reason,
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
    const scope = scopeKey(postInput);
    recordBashOutcome(
      state,
      scope,
      fingerprint,
      false,
      finalConfig.bash.failuresRequired,
      Date.now(),
      finalConfig.windowMs
    );
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
    const scope = scopeKey(postInput);
    recordBashOutcome(
      state,
      scope,
      fingerprint,
      true,
      finalConfig.bash.failuresRequired,
      Date.now(),
      finalConfig.windowMs
    );
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
