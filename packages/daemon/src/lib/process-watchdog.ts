import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Logger } from './logger.ts';

const execFileAsync = promisify(execFile);
const logger = new Logger('ProcessWatchdog');

export interface ProcessSnapshot {
  pid: number;
  ppid: number;
  pgid?: number;
  elapsedSeconds: number;
  command: string;
}

export type ProcessLister = () => Promise<ProcessSnapshot[]>;
export type ProcessKiller = (pid: number, signal: NodeJS.Signals) => void;
export type ProcessGroupKiller = (pgid: number, signal: NodeJS.Signals) => void;
export type RootPidProvider = (snapshot?: ProcessSnapshot[]) => {
  live: Iterable<number>;
  exited: Iterable<number>;
};

const SUSPICIOUS_THRESHOLDS = [
  { pattern: /\bbun\s+test\b/, thresholdMs: 15 * 60 * 1000 },
  { pattern: /\bmake\s+dev\b/, thresholdMs: 24 * 60 * 60 * 1000 },
] as const;

export const PROCESS_WATCHDOG_INTERVAL_MS = 5 * 60 * 1000;

export async function listProcesses(): Promise<ProcessSnapshot[]> {
  if (process.platform === 'win32') return [];

  if (usesBsdPsElapsedFormat()) {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,pgid=,etime=,command='], {
      maxBuffer: 1024 * 1024,
    });
    return parseProcessList(stdout, 'duration');
  }

  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,pgid=,etimes=,command='], {
    maxBuffer: 1024 * 1024,
  });
  return parseProcessList(stdout, 'seconds');
}

function usesBsdPsElapsedFormat(): boolean {
  return (
    process.platform === 'darwin' ||
    process.platform === 'freebsd' ||
    process.platform === 'openbsd'
  );
}

export function parseProcessList(
  stdout: string,
  elapsedFormat: 'seconds' | 'duration'
): ProcessSnapshot[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line): ProcessSnapshot[] => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
      if (!match) return [];
      const [, pidRaw, ppidRaw, pgidRaw, elapsedRaw, command] = match;
      const elapsedSeconds =
        elapsedFormat === 'seconds' ? Number(elapsedRaw) : parsePsElapsedDuration(elapsedRaw);
      if (!Number.isFinite(elapsedSeconds)) return [];
      return [
        {
          pid: Number(pidRaw),
          ppid: Number(ppidRaw),
          pgid: Number(pgidRaw),
          elapsedSeconds,
          command,
        },
      ];
    });
}

export function parsePsElapsedDuration(raw: string): number {
  const [dayPart, timePart] = raw.includes('-') ? raw.split('-', 2) : ['0', raw];
  const parts = timePart.split(':').map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part))) return Number.NaN;
  const days = Number(dayPart);
  if (!Number.isFinite(days)) return Number.NaN;

  if (parts.length === 2) {
    const [minutes, seconds] = parts;
    return days * 86400 + minutes * 60 + seconds;
  }
  if (parts.length === 3) {
    const [hours, minutes, seconds] = parts;
    return days * 86400 + hours * 3600 + minutes * 60 + seconds;
  }
  return Number.NaN;
}

export async function cleanupSuspiciousProcesses(options?: {
  listProcesses?: ProcessLister;
  killProcess?: ProcessKiller;
  killProcessGroup?: ProcessGroupKiller;
  getRootPids?: RootPidProvider;
}): Promise<number> {
  const lister = options?.listProcesses ?? listProcesses;
  const killer = options?.killProcess ?? ((pid, signal) => process.kill(pid, signal));
  const groupKiller =
    options?.killProcessGroup ??
    (process.platform === 'win32'
      ? () => {}
      : (pgid, signal) => {
          try {
            process.kill(-pgid, signal);
          } catch {}
        });
  const quickResult = options?.getRootPids
    ? options.getRootPids()
    : { live: [] as number[], exited: [] as number[] };
  const quickLive = [...quickResult.live];
  const quickExited = [...quickResult.exited];
  if (quickLive.length === 0 && quickExited.length === 0) return 0;

  const snapshots = await lister();

  const rootResult = options?.getRootPids
    ? options.getRootPids(snapshots)
    : { live: [] as number[], exited: [] as number[] };
  const liveRoots = new Set(rootResult.live);
  const exitedRoots = new Set(rootResult.exited);
  if (liveRoots.size === 0 && exitedRoots.size === 0) return 0;
  const ownedPids = collectDescendantPids(snapshots, liveRoots, exitedRoots);
  const snapshotPids = new Set<number>();
  for (const snap of snapshots) snapshotPids.add(snap.pid);
  let killed = 0;

  for (const snapshot of snapshots) {
    if (!ownedPids.has(snapshot.pid)) continue;
    const runtimeMs = snapshot.elapsedSeconds * 1000;
    const threshold = SUSPICIOUS_THRESHOLDS.find(
      ({ pattern, thresholdMs }) => pattern.test(snapshot.command) && runtimeMs > thresholdMs
    );
    if (!threshold) continue;

    try {
      if (
        typeof snapshot.pgid === 'number' &&
        Number.isFinite(snapshot.pgid) &&
        snapshot.pgid > 1 &&
        !liveRoots.has(snapshot.pgid) &&
        (ownedPids.has(snapshot.pgid) ||
          (exitedRoots.has(snapshot.pgid) && !snapshotPids.has(snapshot.pgid)))
      ) {
        try {
          groupKiller(snapshot.pgid, 'SIGTERM');
        } catch {}
      }
      try {
        killer(snapshot.pid, 'SIGTERM');
      } catch (error: unknown) {
        if (
          !(
            error &&
            typeof error === 'object' &&
            'code' in error &&
            (error as { code: string }).code === 'ESRCH'
          )
        ) {
          throw error;
        }
      }
      killed++;
      logger.warn(
        `Killing suspicious daemon-owned long-running process pid=${snapshot.pid} ppid=${snapshot.ppid} ` +
          `runtimeMs=${runtimeMs} thresholdMs=${threshold.thresholdMs} command=${snapshot.command}`
      );
    } catch (error) {
      logger.warn(
        `Failed to kill suspicious daemon-owned process pid=${snapshot.pid}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return killed;
}

export function collectDescendantPids(
  snapshots: ProcessSnapshot[],
  liveRootPids: ReadonlySet<number>,
  exitedRootPids?: ReadonlySet<number>
): Set<number> {
  const childrenByParent = new Map<number, number[]>();
  const processesByGroup = new Map<number, number[]>();
  const snapshotPids = new Set<number>();
  for (const snapshot of snapshots) {
    snapshotPids.add(snapshot.pid);
    const children = childrenByParent.get(snapshot.ppid) ?? [];
    children.push(snapshot.pid);
    childrenByParent.set(snapshot.ppid, children);

    if (typeof snapshot.pgid === 'number' && Number.isFinite(snapshot.pgid)) {
      const groupProcesses = processesByGroup.get(snapshot.pgid) ?? [];
      groupProcesses.push(snapshot.pid);
      processesByGroup.set(snapshot.pgid, groupProcesses);
    }
  }

  const owned = new Set<number>();
  const queue: number[] = [];

  for (const pid of liveRootPids) {
    if (snapshotPids.has(pid)) {
      queue.push(pid);
    }
  }

  const effectiveExited = exitedRootPids ?? new Set<number>();
  for (const pid of effectiveExited) {
    if (snapshotPids.has(pid)) continue;
    const groupMembers = processesByGroup.get(pid);
    if (groupMembers) queue.push(...groupMembers);
  }

  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (owned.has(pid)) continue;
    owned.add(pid);
    queue.push(...(childrenByParent.get(pid) ?? []));
    queue.push(...(processesByGroup.get(pid) ?? []));
  }
  return owned;
}

export class ProcessWatchdog {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly intervalMs = PROCESS_WATCHDOG_INTERVAL_MS,
    private readonly cleanup: () => Promise<number> = cleanupSuspiciousProcesses
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.cleanup().catch((error) => {
        logger.warn(
          `Process watchdog cleanup failed: ${error instanceof Error ? error.message : String(error)}`
        );
      });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
