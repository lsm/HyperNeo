import { resolve as resolvePath } from 'node:path';

export interface LoopStreakEntry {
  count: number;
  firstSeenMs: number;
  lastSeenMs: number;
}

export interface LoopStreakState {
  lastKey: string;
  entry: LoopStreakEntry;
}

export interface BashFailureRing {
  outcomes: boolean[];
  lastSeenMs: number;
}

export interface BashFailureRingEvaluation {
  allFailures: boolean;
  length: number;
  expired: boolean;
}

export type LoopInterventionDecision = { action: 'allow' } | { action: 'deny'; reason: string };

export function stableStringify(value: unknown): string {
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

export function buildArgKey(
  toolName: string,
  input: Record<string, unknown>,
  cwd?: string
): string {
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

export function summariseArgs(toolName: string, input: Record<string, unknown>): string {
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

export function buildRecoveryMessage(toolName: string, count: number, argSummary: string): string {
  return [
    `Loop detected: ${toolName} was called ${count} times in a row with identical arguments (${argSummary}).`,
    'The result has not changed since the previous call. STOP re-running this tool — move on to the next step in your task.',
    'If you have a TodoWrite list, mark progress and proceed to the next item.',
    'If you genuinely need fresh data, perform a *different* action (edit a file, run a command, ask a question) before retrying.',
  ].join(' ');
}

export function buildBashRecoveryMessage(
  count: number,
  argSummary: string,
  failures: number
): string {
  return [
    `Bash dead-loop detected: the same command was run ${count} times in a row and the last ${failures} attempts all failed (${argSummary}).`,
    'Re-running the same failing command will not change the outcome. STOP and reconsider:',
    '(1) read the previous error output carefully,',
    '(2) inspect the relevant files or run a *different* diagnostic command,',
    '(3) only retry after you have changed something that could plausibly affect the outcome.',
    'If you are checking for a file or path, run a different probe (e.g. `ls` on the parent directory) instead of re-running the failing command.',
  ].join(' ');
}

export function scopeKey(input: { session_id: string; agent_id?: string }): string {
  return `${input.session_id}::${input.agent_id ?? 'main'}`;
}

export function bashFingerprintKey(scope: string, fingerprint: string): string {
  return `${scope}::${fingerprint}`;
}

export function advanceLoopStreak(args: {
  prev: LoopStreakState | undefined;
  key: string;
  now: number;
  windowMs: number;
}): LoopStreakState {
  const prev = args.prev;
  if (prev && prev.lastKey === args.key && args.now - prev.entry.firstSeenMs <= args.windowMs) {
    return {
      lastKey: args.key,
      entry: {
        count: prev.entry.count + 1,
        firstSeenMs: prev.entry.firstSeenMs,
        lastSeenMs: args.now,
      },
    };
  }
  return {
    lastKey: args.key,
    entry: { count: 1, firstSeenMs: args.now, lastSeenMs: args.now },
  };
}

export function recordBashRingOutcome(args: {
  prev: BashFailureRing | undefined;
  failed: boolean;
  failuresRequired: number;
  now: number;
  windowMs: number;
}): BashFailureRing {
  const isStale = args.prev != null && args.now - args.prev.lastSeenMs > args.windowMs;
  const outcomes = !args.prev || isStale ? [] : [...args.prev.outcomes];
  outcomes.push(args.failed);
  while (outcomes.length > args.failuresRequired) outcomes.shift();
  return { outcomes, lastSeenMs: args.now };
}

export function evaluateBashFailureRing(args: {
  ring: BashFailureRing | undefined;
  now: number;
  windowMs: number;
}): BashFailureRingEvaluation {
  const ring = args.ring;
  if (!ring || ring.outcomes.length === 0) {
    return { allFailures: false, length: 0, expired: false };
  }
  if (args.now - ring.lastSeenMs > args.windowMs) {
    return { allFailures: false, length: 0, expired: true };
  }
  for (const failed of ring.outcomes) {
    if (!failed) return { allFailures: false, length: ring.outcomes.length, expired: false };
  }
  return { allFailures: true, length: ring.outcomes.length, expired: false };
}

export function decideIdenticalArgsLoop(args: {
  toolName: string;
  count: number;
  threshold: number | undefined;
  input: Record<string, unknown>;
}): LoopInterventionDecision {
  if (typeof args.threshold !== 'number' || args.count < args.threshold) {
    return { action: 'allow' };
  }
  const argSummary = summariseArgs(args.toolName, args.input);
  return { action: 'deny', reason: buildRecoveryMessage(args.toolName, args.count, argSummary) };
}

export function decideBashDeadLoop(args: {
  count: number;
  threshold: number;
  failuresRequired: number;
  ring: BashFailureRingEvaluation;
  input: Record<string, unknown>;
}): LoopInterventionDecision {
  if (args.count < args.threshold) return { action: 'allow' };
  if (!args.ring.allFailures || args.ring.length < args.failuresRequired) {
    return { action: 'allow' };
  }
  const argSummary = summariseArgs('Bash', args.input);
  return {
    action: 'deny',
    reason: buildBashRecoveryMessage(args.count, argSummary, args.ring.length),
  };
}
