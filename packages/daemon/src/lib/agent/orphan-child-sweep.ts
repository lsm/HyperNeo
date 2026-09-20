import { canListProcesses, listProcesses, type ProcessSnapshot } from '../process-watchdog.ts';
import type { AgentChildProcessRepository } from '../../storage/repositories/agent-child-process-repository.ts';

export interface PersistedAgentChild {
  pid: number;
  sessionId: string;
  command: string;
  startedAt: number;
  daemonPid: number;
}

export type OrphanSkipReason =
  | 'own_record'
  | 'own_child'
  | 'not_running'
  | 'start_time_mismatch'
  | 'command_mismatch';

export const ORPHAN_START_TIME_TOLERANCE_MS = 10_000;

export interface OrphanChildKillInput {
  child: PersistedAgentChild;
  observed: ProcessSnapshot | undefined;
  now: number;
  toleranceMs: number;
  currentDaemonPid: number;
}

export function decideOrphanChildKill(
  input: OrphanChildKillInput
): { value: number } | { reason: OrphanSkipReason } {
  const { child, observed, now, toleranceMs, currentDaemonPid } = input;
  if (child.daemonPid === currentDaemonPid) return { reason: 'own_record' };
  if (!observed) return { reason: 'not_running' };
  if (observed.ppid === currentDaemonPid) return { reason: 'own_child' };
  const observedStartedAt = now - observed.elapsedSeconds * 1000;
  if (Math.abs(observedStartedAt - child.startedAt) > toleranceMs) {
    return { reason: 'start_time_mismatch' };
  }
  return child.command.length > 0 && observed.command.includes(child.command)
    ? { value: child.pid }
    : { reason: 'command_mismatch' };
}

export interface OrphanChildSweepPlan {
  kill: number[];
  skipped: Array<{ pid: number; reason: OrphanSkipReason }>;
}

export function planOrphanChildSweep(
  persisted: readonly PersistedAgentChild[],
  snapshot: readonly ProcessSnapshot[],
  now: number,
  currentDaemonPid: number,
  toleranceMs: number = ORPHAN_START_TIME_TOLERANCE_MS
): OrphanChildSweepPlan {
  const byPid = new Map<number, ProcessSnapshot>();
  for (const snap of snapshot) byPid.set(snap.pid, snap);
  const plan: OrphanChildSweepPlan = { kill: [], skipped: [] };
  for (const child of persisted) {
    const decision = decideOrphanChildKill({
      child,
      observed: byPid.get(child.pid),
      now,
      toleranceMs,
      currentDaemonPid,
    });
    if ('reason' in decision) plan.skipped.push({ pid: child.pid, reason: decision.reason });
    else plan.kill.push(decision.value);
  }
  return plan;
}

export function killProcessGroupThenPid(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
    return;
  } catch {}
  process.kill(pid, 'SIGKILL');
}

export interface OrphanChildSweepIo {
  canList?: () => boolean;
  list?: () => Promise<ProcessSnapshot[]>;
  kill?: (pid: number) => void;
  now?: () => number;
}

export async function sweepOrphanedAgentChildren(
  repo: AgentChildProcessRepository,
  logInfo: (...args: unknown[]) => void,
  logError: (...args: unknown[]) => void,
  io: OrphanChildSweepIo = {}
): Promise<void> {
  try {
    await runOrphanChildSweep(repo, logInfo, logError, io);
  } catch (err) {
    logError('[Daemon] Orphaned agent child sweep failed; its record is kept for boot:', err);
  }
}

async function runOrphanChildSweep(
  repo: AgentChildProcessRepository,
  logInfo: (...args: unknown[]) => void,
  logError: (...args: unknown[]) => void,
  io: OrphanChildSweepIo
): Promise<void> {
  const canList = io.canList ?? canListProcesses;
  const list = io.list ?? listProcesses;
  const kill = io.kill ?? killProcessGroupThenPid;
  const now = io.now ?? Date.now;
  let persisted: ReturnType<AgentChildProcessRepository['list']>;
  try {
    persisted = repo.list();
  } catch (err) {
    logError('[Daemon] Orphaned agent child sweep could not read its record:', err);
    return;
  }
  if (persisted.length === 0) return;
  if (!canList()) {
    logInfo(
      `[Daemon] Orphaned agent child sweep skipped: this platform cannot enumerate processes; ` +
        `${persisted.length} record(s) kept`
    );
    return;
  }

  let snapshot: ProcessSnapshot[] = [];
  try {
    snapshot = await list();
  } catch (err) {
    logError('[Daemon] Orphaned agent child sweep could not list processes:', err);
    return;
  }

  const plan = planOrphanChildSweep(persisted, snapshot, now(), process.pid);
  let killed = 0;
  for (const pid of plan.kill) {
    try {
      kill(pid);
      killed++;
    } catch (err) {
      logError(`[Daemon] Failed to kill orphaned agent child ${pid}:`, err);
    }
  }
  repo.forgetMany(
    persisted.filter((child) => child.daemonPid !== process.pid).map((child) => child.pid)
  );
  logInfo(
    `[Daemon] Orphaned agent child sweep: ${killed} killed, ${plan.skipped.length} skipped ` +
      `(${persisted.length} recorded by daemon pid ${persisted[0]?.daemonPid ?? 'unknown'})`
  );
}
