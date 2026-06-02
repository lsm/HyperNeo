/**
 * GatePollManager — periodic script execution and message injection for workflow gates.
 *
 * When a workflow run becomes `in_progress`, this manager scans all gates in the
 * workflow definition for those with `poll` defined and starts a timer for each.
 * On each tick, the poll script is executed in a sandboxed environment with context
 * variables. If the output changes and is non-empty, a message is injected into
 * the target node's agent session.
 *
 * Mid-run config pickup:
 * - `refreshPolls()` — re-reads the workflow definition, diffs poll configs, and
 *   starts/stops/updates poll timers to match the latest definition. Called when a
 *   `spaceWorkflow.updated` event fires for a workflow with active runs.
 * - Timer closures read poll config from the `ActivePoll` state object (not from
 *   captured closure variables), so config changes picked up by `refreshPolls` are
 *   visible on the next tick without restarting the timer.
 *
 * Lifecycle:
 * - `startPolls()` — called when a workflow run starts
 * - `stopPolls()` — called when a workflow run reaches a terminal state
 * - `refreshPolls()` — called when the workflow definition changes mid-run
 * - All state is in-memory only; no DB persistence needed
 */

import type { Gate, GatePoll, SpaceWorkflow } from '@neokai/shared';
import { Logger } from '../../logger';
import { getEffectiveGatePoll } from './gate-features';
import { buildRestrictedEnv, collectWithMaxBuffer, MAX_BUFFER_BYTES } from './gate-script-executor';

const log = new Logger('gate-poll-manager');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum poll interval (10 seconds) to prevent abuse. */
export const MIN_POLL_INTERVAL_MS = 10_000;

/** Default script timeout for poll scripts (30 seconds). */
const DEFAULT_POLL_SCRIPT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Context resolution
// ---------------------------------------------------------------------------

/**
 * Context provided to poll script execution.
 * These values are injected as environment variables.
 */
export interface PollScriptContext {
  /** Task UUID */
  TASK_ID: string;
  /** Task title */
  TASK_TITLE: string;
  /** Space UUID */
  SPACE_ID: string;
  /** Associated PR URL (empty string if none) */
  PR_URL: string;
  /** PR number extracted from URL (empty string if none) */
  PR_NUMBER: string;
  /** Repo owner extracted from URL (empty string if none) */
  REPO_OWNER: string;
  /** Repo name extracted from URL (empty string if none) */
  REPO_NAME: string;
  /** Workflow run UUID */
  WORKFLOW_RUN_ID: string;
  /** Workflow run start timestamp, if known. */
  WORKFLOW_START_ISO?: string;
  /** Gate data last-updated timestamp, if known. */
  GATE_DATA_UPDATED_ISO?: string;
}

/**
 * Extract PR metadata from a PR URL.
 * Supports GitHub PR URLs in the format: https://github.com/{owner}/{name}/pull/{number}
 */
export function extractPrContext(prUrl: string): {
  PR_NUMBER: string;
  REPO_OWNER: string;
  REPO_NAME: string;
} {
  if (!prUrl) {
    return { PR_NUMBER: '', REPO_OWNER: '', REPO_NAME: '' };
  }

  try {
    const url = new URL(prUrl);
    const parts = url.pathname.split('/').filter(Boolean);
    // Expected: [owner, repo, 'pull', number] or [owner, repo, 'pull', number, ...]
    if (parts.length >= 4 && parts[2] === 'pull') {
      return {
        REPO_OWNER: parts[0],
        REPO_NAME: parts[1],
        PR_NUMBER: parts[3],
      };
    }
  } catch {
    // Not a valid URL
  }

  return { PR_NUMBER: '', REPO_OWNER: '', REPO_NAME: '' };
}

/**
 * Resolves the target node name for a polled gate by finding the channel
 * that references this gate.
 *
 * When `sourceName` is provided, the channel must also match that source so
 * per-source polls resolve the correct target node.
 */
/**
 * Resolves the target node name for a polled gate by finding the channel
 * that references this gate.
 *
 * When `sourceName` is provided, the channel must also match that source so
 * per-source polls resolve the correct target node. If no exact match exists,
 * falls back to wildcard channels (`from: '*'`) so wildcard-gated polls can
 * still resolve their concrete target node.
 */
export function resolveTargetNodeName(
  gateId: string,
  workflow: SpaceWorkflow,
  target: 'from' | 'to',
  sourceName?: string
): string | null {
  const channels = workflow.channels ?? [];
  let channel: (typeof channels)[number] | undefined;
  if (sourceName !== undefined) {
    channel = channels.find((ch) => ch.gateId === gateId && ch.from === sourceName);
    if (!channel) {
      channel = channels.find((ch) => ch.gateId === gateId && ch.from === '*');
    }
  } else {
    channel = channels.find((ch) => ch.gateId === gateId);
  }
  if (!channel) {
    return null;
  }

  if (target === 'from') {
    // For wildcard channels, return the concrete sourceName instead of '*'
    return channel.from === '*' && sourceName !== undefined ? sourceName : channel.from;
  }

  // For 'to', handle both single and array targets
  const toTarget = Array.isArray(channel.to) ? channel.to[0] : channel.to;
  return toTarget ?? null;
}

/**
 * Format a message using the message template.
 * Replaces `{{output}}` placeholder with the actual output.
 */
export function formatPollMessage(output: string, template?: string): string {
  if (!template) {
    return output;
  }
  return template.replace(/\{\{output\}\}/g, output);
}

// ---------------------------------------------------------------------------
// Message injector interface
// ---------------------------------------------------------------------------

/**
 * Callback for injecting messages into agent sessions.
 * Abstracts the dependency on TaskAgentManager for testability.
 */
export interface PollMessageInjector {
  /**
   * Inject a message into a specific agent session.
   * @param sessionId — the agent session to inject into
   * @param message — the message content
   * @param isSynthetic — whether this is a synthetic/system message
   */
  injectSubSessionMessage(sessionId: string, message: string, isSynthetic?: boolean): Promise<void>;
}

/**
 * Callback for looking up active agent sessions for a node in a workflow run.
 */
export interface PollSessionResolver {
  /**
   * Returns the session ID of an active (non-terminal) agent execution for
   * the given (runId, nodeId) pair. Returns null when no active session exists.
   */
  getActiveSessionForNode(runId: string, nodeId: string): string | null;
}

/**
 * Callback for resolving the current PR URL for a workflow run.
 * Used to refresh PR-related context fields on each poll tick so that
 * polls can discover PR URLs that appear after the run starts (e.g. when
 * the coder creates a PR during the run).
 */
export interface PollPrUrlResolver {
  /**
   * Returns the current PR URL for the given run, or empty string if none.
   */
  getPrUrlForRun(runId: string): Promise<string>;
}

/**
 * Callback for re-reading the current workflow definition.
 * Used by `refreshPolls` so the manager can detect mid-run poll config
 * changes without being restarted.
 */
export interface PollWorkflowDefProvider {
  /**
   * Returns the current workflow definition for the given workflow ID,
   * or null if the workflow no longer exists.
   */
  getWorkflow(workflowId: string): SpaceWorkflow | null;
}

/**
 * Callback for resolving the last-updated timestamp of a gate's runtime data.
 * Used by poll ticks so feature scripts (e.g. codex_review_bot) can base their
 * timeout on the gate data write time rather than the workflow start time.
 */
export interface PollGateDataResolver {
  /**
   * Returns the ISO8601 timestamp of the most recent gate data write for
   * the given (runId, gateId), or undefined if no gate data exists.
   */
  getGateDataUpdatedIsoForRun(runId: string, gateId: string): string | undefined;
}

// ---------------------------------------------------------------------------
// GatePollManager
// ---------------------------------------------------------------------------

/**
 * In-memory state for a single active poll timer.
 */
interface PolledGate {
  gate: Gate;
  poll: GatePoll;
  /** The channel `from` value that caused this poll (for source-scoped Codex). */
  sourceName: string;
}

function getPolledGates(workflow: SpaceWorkflow): PolledGate[] {
  const result: PolledGate[] = [];
  const nativeSeen = new Set<string>();
  const injectedSeen = new Set<string>();

  for (const channel of workflow.channels ?? []) {
    if (!channel.gateId) continue;
    const gate = workflow.gates?.find((g) => g.id === channel.gateId);
    if (!gate) continue;

    // A "native" poll is one that exists on the gate itself (gate.poll or a
    // registered feature poll). These are gate-scoped: one timer per gate.
    // Dynamically-injected Codex polls are source-scoped: one timer per
    // flagged channel source so the correct target node receives guidance.
    const hasNativePoll = !!getEffectiveGatePoll(gate, undefined);

    // Wildcard channels need special handling: resolveTargetNodeName cannot
    // target the literal '*' source, so expand dynamically-injected polls to
    // concrete node names.
    if (channel.from === '*') {
      const poll = getEffectiveGatePoll(gate, workflow, '*');
      if (!poll) continue;

      if (hasNativePoll) {
        if (nativeSeen.has(gate.id)) continue;
        nativeSeen.add(gate.id);
        result.push({ gate, poll, sourceName: '*' });
      } else {
        for (const node of workflow.nodes) {
          const nodePoll = getEffectiveGatePoll(gate, workflow, node.name);
          if (!nodePoll) continue;
          const key = `${gate.id}:${node.name}`;
          if (injectedSeen.has(key)) continue;
          injectedSeen.add(key);
          result.push({ gate, poll: nodePoll, sourceName: node.name });
        }
      }
      continue;
    }

    const poll = getEffectiveGatePoll(gate, workflow, channel.from);
    if (!poll) continue;

    if (hasNativePoll) {
      if (nativeSeen.has(gate.id)) continue;
      nativeSeen.add(gate.id);
      result.push({ gate, poll, sourceName: channel.from });
    } else {
      const key = `${gate.id}:${channel.from}`;
      if (injectedSeen.has(key)) continue;
      injectedSeen.add(key);
      result.push({ gate, poll, sourceName: channel.from });
    }
  }
  return result;
}

interface ActivePoll {
  /** The timer handle */
  timer: ReturnType<typeof setInterval>;
  /** The last known output (for change detection) */
  lastOutput: string;
  /**
   * Whether this poll is still active. Set to `false` by `stopPolls`/`stopAll`
   * before clearing the interval, so in-flight ticks can bail out early.
   */
  active: boolean;
  /**
   * Whether a tick is currently executing. Prevents overlapping ticks when
   * a script takes longer than the poll interval.
   */
  inFlight: boolean;
  /**
   * Snapshot of the poll config used to start this timer.
   * Updated by `refreshPolls` when the config changes mid-run.
   */
  pollConfig: GatePoll;
  /** The resolved target node ID for this poll. */
  targetNodeId: string;
  /** The script context (captured at start/refresh time). */
  context: PollScriptContext;
  /** The workspace path for script execution. */
  workspacePath: string;
}

export class GatePollManager {
  /**
   * Active polls keyed by `${runId}:${gateId}`.
   * In-memory only — starts empty on every daemon restart.
   */
  private activePolls = new Map<string, ActivePoll>();

  /**
   * Resolved gate channels cached per run for target resolution.
   * Keyed by runId.
   */
  private runContexts = new Map<
    string,
    {
      workflowId: string;
      workflow: SpaceWorkflow;
      workspacePath: string;
      spaceId: string;
      scriptContext: PollScriptContext | null;
    }
  >();

  constructor(
    private readonly messageInjector: PollMessageInjector,
    private readonly sessionResolver: PollSessionResolver,
    private readonly prUrlResolver?: PollPrUrlResolver,
    private readonly workflowDefProvider?: PollWorkflowDefProvider,
    private readonly gateDataResolver?: PollGateDataResolver
  ) {}

  /**
   * Start all polls for a workflow run.
   * Scans the workflow definition for gates with `poll` and starts a timer for each.
   *
   * @param runId — the workflow run ID
   * @param workflow — the workflow definition
   * @param workspacePath — absolute workspace path (cwd for scripts)
   * @param spaceId — the space ID (for context)
   * @param scriptContext — resolved context variables for scripts
   */
  startPolls(
    runId: string,
    workflow: SpaceWorkflow,
    workspacePath: string,
    spaceId: string,
    scriptContext: PollScriptContext
  ): void {
    const polledGates = getPolledGates(workflow);

    // Always store run context so refreshPollsForWorkflow can find this run
    // even when no gates have poll initially (polls may be added later).
    this.runContexts.set(runId, {
      workflowId: workflow.id,
      workflow,
      workspacePath,
      spaceId,
      scriptContext: { ...scriptContext },
    });

    if (polledGates.length === 0) {
      log.info(`GatePollManager: no polled gates configured for run "${runId}"`);
      return;
    }

    for (const { gate, poll, sourceName } of polledGates) {
      const key = `${runId}:${gate.id}:${sourceName}`;

      // Validate interval — skip polls with malformed intervalMs (e.g. NaN, string)
      if (
        typeof poll.intervalMs !== 'number' ||
        !Number.isFinite(poll.intervalMs) ||
        poll.intervalMs <= 0
      ) {
        log.warn(
          `GatePollManager: skipping poll for gate "${gate.id}" — invalid intervalMs: ${poll.intervalMs}`
        );
        continue;
      }

      // Enforce minimum interval
      const intervalMs = Math.max(poll.intervalMs, MIN_POLL_INTERVAL_MS);

      // Resolve target node scoped to the channel source
      const targetNodeName = resolveTargetNodeName(gate.id, workflow, poll.target, sourceName);
      if (!targetNodeName) {
        log.warn(
          `GatePollManager: skipping poll for gate "${gate.id}" — no channel references this gate (source=${sourceName})`
        );
        continue;
      }

      // Resolve target node ID from node name
      const targetNode = workflow.nodes.find((n) => n.name === targetNodeName);
      if (!targetNode) {
        log.warn(
          `GatePollManager: skipping poll for gate "${gate.id}" — target node "${targetNodeName}" not found`
        );
        continue;
      }

      log.info(
        `GatePollManager: starting poll for gate "${gate.id}" on run "${runId}" ` +
          `(interval=${intervalMs}ms, target=${poll.target}:${targetNodeName}, source=${sourceName})`
      );

      // Capture runId, gateId and sourceName for the closure — these are immutable.
      const capturedRunId = runId;
      const capturedGateId = gate.id;
      const capturedSourceName = sourceName;

      const timer = setInterval(async () => {
        const ap = this.activePolls.get(`${capturedRunId}:${capturedGateId}:${capturedSourceName}`);
        if (!ap || !ap.active) return;
        await this.executePollTick(
          capturedRunId,
          capturedGateId,
          capturedSourceName,
          ap.pollConfig,
          ap.workspacePath,
          ap.context,
          ap.targetNodeId
        );
      }, intervalMs);

      // Prevent the timer from keeping the process alive
      if (timer.unref) {
        timer.unref();
      }

      // NOTE: lastOutput starts empty on every startPolls call. This means the
      // first non-empty poll output after a run restarts or retries will always
      // be injected, even if the same output was seen in a previous lifecycle.
      // This is intentional: after a daemon restart there is no reliable way to
      // restore lastOutput without DB persistence, and re-injecting on restart
      // is safer than silently dropping the first poll result.
      this.activePolls.set(key, {
        timer,
        lastOutput: '',
        active: true,
        inFlight: false,
        pollConfig: { ...poll },
        targetNodeId: targetNode.id,
        context: { ...scriptContext },
        workspacePath,
      });
    }
  }

  /**
   * Stop all polls for a workflow run.
   * Called when the run reaches a terminal state.
   */
  stopPolls(runId: string): void {
    const prefix = `${runId}:`;
    for (const [key, poll] of this.activePolls) {
      if (key.startsWith(prefix)) {
        poll.active = false;
        clearInterval(poll.timer);
        this.activePolls.delete(key);
        log.info(`GatePollManager: stopped poll "${key}" for terminal run "${runId}"`);
      }
    }
    this.runContexts.delete(runId);
  }

  /**
   * Stop all polls across all runs. Called during shutdown.
   */
  stopAll(): void {
    for (const [key, poll] of this.activePolls) {
      poll.active = false;
      clearInterval(poll.timer);
      log.info(`GatePollManager: stopped poll "${key}" during shutdown`);
    }
    this.activePolls.clear();
    this.runContexts.clear();
  }

  /**
   * Returns the number of active polls (for testing/diagnostics).
   */
  get activePollCount(): number {
    return this.activePolls.size;
  }

  /**
   * Returns whether a specific gate poll is active (for testing).
   * When `sourceName` is omitted, returns true if any source-scoped poll
   * for the gate is active.
   */
  isPollActive(runId: string, gateId: string, sourceName?: string): boolean {
    if (sourceName !== undefined) {
      return this.activePolls.has(`${runId}:${gateId}:${sourceName}`);
    }
    const prefix = `${runId}:${gateId}:`;
    for (const key of this.activePolls.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  /**
   * Returns the set of run IDs that are currently being polled (for testing/diagnostics).
   */
  get activeRunIds(): Set<string> {
    const runIds = new Set<string>();
    for (const key of this.activePolls.keys()) {
      const runId = key.split(':')[0];
      runIds.add(runId);
    }
    return runIds;
  }

  /**
   * Returns the workflow ID for a run, or undefined if the run has no active polls.
   */
  getWorkflowIdForRun(runId: string): string | undefined {
    return this.runContexts.get(runId)?.workflowId;
  }

  // ---------------------------------------------------------------------------
  // Mid-run config refresh
  // ---------------------------------------------------------------------------

  /**
   * Refresh polls for all active runs that use the given workflow.
   *
   * Called when a `spaceWorkflow.updated` event fires. For each active run
   * belonging to the updated workflow, this method:
   *   1. Re-reads the latest workflow definition
   *   2. Diffs gate poll configs against currently active polls
   *   3. Starts new polls, stops removed polls, updates changed polls
   *
   * If `workflowDefProvider` was not provided at construction time, this is a no-op.
   */
  refreshPollsForWorkflow(workflowId: string): void {
    if (!this.workflowDefProvider) return;

    // Find all active runs for this workflow
    for (const [runId, ctx] of this.runContexts) {
      if (ctx.workflowId !== workflowId) continue;
      this.refreshPollsForRun(runId);
    }
  }

  /**
   * Refresh polls for a single run by re-reading the latest workflow definition.
   *
   * Handles three cases:
   * - Poll added to a gate → start a new timer
   * - Poll removed from a gate → stop the timer
   * - Poll config changed (interval, script, target) → update the timer
   *
   * No-op if the run is not tracked or the workflow no longer exists.
   */
  refreshPollsForRun(runId: string): void {
    const ctx = this.runContexts.get(runId);
    if (!ctx) return;

    const latestWorkflow = this.workflowDefProvider?.getWorkflow(ctx.workflowId);
    if (!latestWorkflow) {
      log.warn(
        `GatePollManager: workflow "${ctx.workflowId}" no longer exists during refresh for run "${runId}" — keeping existing polls`
      );
      return;
    }

    // Update the cached workflow in runContexts
    ctx.workflow = latestWorkflow;

    const latestPolledKeys = new Set<string>();

    // Start or update polls for gates that now have poll config
    for (const { gate, poll, sourceName } of getPolledGates(latestWorkflow)) {
      const key = `${runId}:${gate.id}:${sourceName}`;
      const existing = this.activePolls.get(key);

      // Validate interval
      if (
        typeof poll.intervalMs !== 'number' ||
        !Number.isFinite(poll.intervalMs) ||
        poll.intervalMs <= 0
      ) {
        log.warn(
          `GatePollManager.refreshPolls: skipping gate "${gate.id}" — invalid intervalMs: ${poll.intervalMs}`
        );
        continue;
      }

      const intervalMs = Math.max(poll.intervalMs, MIN_POLL_INTERVAL_MS);

      // Resolve target node scoped to the channel source
      const targetNodeName = resolveTargetNodeName(
        gate.id,
        latestWorkflow,
        poll.target,
        sourceName
      );
      if (!targetNodeName) {
        log.warn(
          `GatePollManager.refreshPolls: skipping gate "${gate.id}" — no channel references this gate (source=${sourceName})`
        );
        continue;
      }
      const targetNode = latestWorkflow.nodes.find((n) => n.name === targetNodeName);
      if (!targetNode) {
        log.warn(
          `GatePollManager.refreshPolls: skipping gate "${gate.id}" — target node "${targetNodeName}" not found`
        );
        continue;
      }

      // Only mark as successfully polled after validation passes
      latestPolledKeys.add(`${gate.id}:${sourceName}`);
      if (!existing) {
        // NEW: poll was added to this gate/source — start a new timer
        log.info(
          `GatePollManager.refreshPolls: starting new poll for gate "${gate.id}" on run "${runId}" source=${sourceName} (poll was added mid-run)`
        );

        // Reuse context from another active poll for the same run so polls
        // added mid-run get the same TASK_ID / PR fields as polls started
        // at run start. Fall back to minimal context only if no peer exists.
        const peerContext = this.findPeerContext(runId);

        const capturedRunId = runId;
        const capturedGateId = gate.id;
        const capturedSourceName = sourceName;

        const timer = setInterval(async () => {
          const ap = this.activePolls.get(
            `${capturedRunId}:${capturedGateId}:${capturedSourceName}`
          );
          if (!ap || !ap.active) return;
          await this.executePollTick(
            capturedRunId,
            capturedGateId,
            capturedSourceName,
            ap.pollConfig,
            ap.workspacePath,
            ap.context,
            ap.targetNodeId
          );
        }, intervalMs);

        if (timer.unref) {
          timer.unref();
        }

        this.activePolls.set(key, {
          timer,
          lastOutput: '',
          active: true,
          inFlight: false,
          pollConfig: { ...poll },
          targetNodeId: targetNode.id,
          context: peerContext ?? {
            TASK_ID: '',
            TASK_TITLE: '',
            SPACE_ID: ctx.spaceId,
            PR_URL: '',
            PR_NUMBER: '',
            REPO_OWNER: '',
            REPO_NAME: '',
            WORKFLOW_RUN_ID: runId,
          },
          workspacePath: ctx.workspacePath,
        });
      } else {
        // Always update target node ID since channel endpoints may
        // have been rewired even if poll config is unchanged.
        existing.targetNodeId = targetNode.id;

        // EXISTING: check if config changed
        const configChanged =
          existing.pollConfig.intervalMs !== poll.intervalMs ||
          existing.pollConfig.script !== poll.script ||
          existing.pollConfig.target !== poll.target ||
          existing.pollConfig.messageTemplate !== poll.messageTemplate;

        if (configChanged) {
          log.info(
            `GatePollManager.refreshPolls: updating poll for gate "${gate.id}" on run "${runId}" source=${sourceName} (config changed mid-run)`
          );

          // If interval changed, we need to recreate the timer
          const intervalChanged =
            Math.max(existing.pollConfig.intervalMs, MIN_POLL_INTERVAL_MS) !== intervalMs;

          // Update the poll config on the existing ActivePoll.
          // The timer closure reads from ap.pollConfig on each tick,
          // so script/target/template changes take effect immediately.
          existing.pollConfig = { ...poll };

          if (intervalChanged) {
            // Recreate timer with new interval
            clearInterval(existing.timer);

            const capturedRunId = runId;
            const capturedGateId = gate.id;
            const capturedSourceName = sourceName;

            const timer = setInterval(async () => {
              const ap = this.activePolls.get(
                `${capturedRunId}:${capturedGateId}:${capturedSourceName}`
              );
              if (!ap || !ap.active) return;
              await this.executePollTick(
                capturedRunId,
                capturedGateId,
                capturedSourceName,
                ap.pollConfig,
                ap.workspacePath,
                ap.context,
                ap.targetNodeId
              );
            }, intervalMs);

            if (timer.unref) {
              timer.unref();
            }

            existing.timer = timer;
          }
        }
        // If config didn't change, no action needed
      }
    }

    // Stop polls for gate/sources that no longer have poll config
    const prefix = `${runId}:`;
    for (const [key, ap] of this.activePolls) {
      if (!key.startsWith(prefix)) continue;
      const suffix = key.slice(prefix.length);
      if (!latestPolledKeys.has(suffix)) {
        const gateId = suffix.split(':')[0];
        log.info(
          `GatePollManager.refreshPolls: stopping poll for gate "${gateId}" on run "${runId}" suffix=${suffix} (poll was removed mid-run)`
        );
        ap.active = false;
        clearInterval(ap.timer);
        this.activePolls.delete(key);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Find the script context from an existing active poll for the given run.
   * Used when a new poll is added mid-run to inherit the task/PR context.
   * Returns null if no active poll exists for the run.
   */
  private findPeerContext(runId: string): PollScriptContext | null {
    const prefix = `${runId}:`;
    for (const [key, ap] of this.activePolls) {
      if (key.startsWith(prefix) && ap.active) {
        return { ...ap.context };
      }
    }
    // No active peer — fall back to the script context stored when the run started.
    const ctx = this.runContexts.get(runId);
    if (ctx?.scriptContext) {
      return { ...ctx.scriptContext };
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Private: poll tick execution
  // ---------------------------------------------------------------------------

  /**
   * Execute a single poll tick: run the script, compare output, inject message.
   */
  private async executePollTick(
    runId: string,
    gateId: string,
    sourceName: string,
    poll: GatePoll,
    workspacePath: string,
    context: PollScriptContext,
    targetNodeId: string
  ): Promise<void> {
    const key = `${runId}:${gateId}:${sourceName}`;
    const activePoll = this.activePolls.get(key);
    if (!activePoll) {
      // Poll was stopped between timer fire and execution
      return;
    }

    // Prevent overlapping ticks - skip if a previous tick is still executing
    if (activePoll.inFlight) {
      log.debug(
        `GatePollManager: skipping poll tick for gate "${gateId}" on run "${runId}" - previous tick still in flight`
      );
      return;
    }
    activePoll.inFlight = true;

    try {
      // Refresh PR context from artifact store so polls discover PR URLs
      // that appear after the run starts (e.g. when coder creates a PR).
      if (this.prUrlResolver) {
        try {
          const freshPrUrl = await this.prUrlResolver.getPrUrlForRun(runId);
          context = { ...context, ...extractPrContext(freshPrUrl), PR_URL: freshPrUrl };
        } catch {
          // Resolver failure should not block the tick
        }
      }

      // Refresh gate data updated timestamp so poll scripts can base timeouts
      // on the gate data write time rather than the workflow start time.
      if (this.gateDataResolver) {
        try {
          const freshIso = this.gateDataResolver.getGateDataUpdatedIsoForRun(runId, gateId);
          if (freshIso) {
            context = { ...context, GATE_DATA_UPDATED_ISO: freshIso };
          }
        } catch {
          // Resolver failure should not block the tick
        }
      }

      const output = await this.executePollScript(poll.script, workspacePath, context);

      // Bail out if the poll was stopped while the script was executing
      if (!activePoll.active) return;

      if (output === null) {
        // Script error or empty output — do nothing
        return;
      }

      // Compare to last known output
      if (output === activePoll.lastOutput) {
        // No change — do nothing
        return;
      }

      // Output changed and is non-empty — attempt injection
      const message = formatPollMessage(output, poll.messageTemplate);
      const sessionId = this.sessionResolver.getActiveSessionForNode(runId, targetNodeId);

      if (!sessionId) {
        log.warn(
          `GatePollManager: no resumable session for node "${targetNodeId}" in run "${runId}" — ` +
            `will retry message injection for poll "${gateId}" on the next tick`
        );
        return;
      }

      await this.messageInjector.injectSubSessionMessage(sessionId, message, true);

      // Only mark output as seen after successful injection, so that if
      // there is no active session the change is re-attempted on the next tick.
      activePoll.lastOutput = output;

      log.info(
        `GatePollManager: injected poll message for gate "${gateId}" on run "${runId}" ` +
          `into session "${sessionId}" (${output.length} chars)`
      );
    } catch (err) {
      // Log error but continue polling — don't crash the poll loop
      log.warn(
        `GatePollManager: poll tick error for gate "${gateId}" on run "${runId}": ` +
          `${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      // Always clear inFlight so the next tick can execute
      const ap = this.activePolls.get(key);
      if (ap) ap.inFlight = false;
    }
  }

  /**
   * Execute a poll script and capture stdout.
   *
   * Uses the same sandboxed environment as gate scripts (credential stripping,
   * restricted env), with additional context variables for the poll.
   *
   * @returns stdout string on success, or null on error / empty output
   */
  private async executePollScript(
    script: string,
    workspacePath: string,
    context: PollScriptContext
  ): Promise<string | null> {
    // Build a gate-script-like context for the restricted env builder
    const gateContext = {
      workspacePath,
      gateId: '__poll__',
      runId: context.WORKFLOW_RUN_ID,
      gateData: context.PR_URL ? { pr_url: context.PR_URL } : undefined,
      workflowStartIso: context.WORKFLOW_START_ISO,
      gateDataUpdatedIso: context.GATE_DATA_UPDATED_ISO,
    };

    // Build restricted env from process environment (strips credentials)
    const env = buildRestrictedEnv(gateContext);

    if (context.PR_URL) {
      env.NEOKAI_GATE_DATA_JSON = JSON.stringify({ pr_url: context.PR_URL });
    }

    // Inject poll-specific context variables
    env.TASK_ID = context.TASK_ID;
    env.TASK_TITLE = context.TASK_TITLE;
    env.SPACE_ID = context.SPACE_ID;
    env.PR_URL = context.PR_URL;
    env.PR_NUMBER = context.PR_NUMBER;
    env.REPO_OWNER = context.REPO_OWNER;
    env.REPO_NAME = context.REPO_NAME;
    env.WORKFLOW_RUN_ID = context.WORKFLOW_RUN_ID;
    if (context.WORKFLOW_START_ISO) {
      env.WORKFLOW_START_ISO = context.WORKFLOW_START_ISO;
    }
    if (context.GATE_DATA_UPDATED_ISO) {
      env.NEOKAI_GATE_DATA_UPDATED_ISO = context.GATE_DATA_UPDATED_ISO;
    }

    let proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'>;
    try {
      proc = Bun.spawn(['bash', '-c', script], {
        cwd: workspacePath,
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`GatePollManager: failed to spawn poll script: ${message}`);
      return null;
    }

    // Drain stdout/stderr concurrently with timeout
    const [stdoutResult, stderrResult, exitCode] = await Promise.all([
      collectWithMaxBuffer(proc.stdout, MAX_BUFFER_BYTES),
      collectWithMaxBuffer(proc.stderr, MAX_BUFFER_BYTES),
      (async () => {
        let killed = false;
        const killTimer = setTimeout(() => {
          killed = true;
          proc.kill('SIGKILL');
        }, DEFAULT_POLL_SCRIPT_TIMEOUT_MS);

        const code = await proc.exited;
        clearTimeout(killTimer);
        return { code, timedOut: killed };
      })(),
    ]);

    if (exitCode.timedOut) {
      log.warn(`GatePollManager: poll script timed out after ${DEFAULT_POLL_SCRIPT_TIMEOUT_MS}ms`);
      return null;
    }

    if (exitCode.code !== 0) {
      const stderr = stderrResult.text.trim();
      log.warn(
        `GatePollManager: poll script exited with code ${exitCode.code}` +
          (stderr ? `: ${stderr.slice(0, 500)}` : '')
      );
      return null;
    }

    const output = stdoutResult.text.trim();
    if (output.length === 0) {
      return null;
    }

    return output;
  }
}
