import { PerformanceObserver } from 'node:perf_hooks';

interface Activity {
  name: string;
  kind: 'start' | 'end' | 'event' | 'gc';
  atMs: number;
  durationMs?: number;
  gcKind?: number;
}

let active: EventLoopActivity | null = null;
const noop = () => {};

export class EventLoopActivity {
  private entries: Activity[] = [];
  private dropped = 0;

  constructor(private now: () => number = () => performance.now()) {}

  activate(): () => void {
    active = this;
    return () => {
      if (active === this) active = null;
      this.drain();
    };
  }

  record(name: string, kind: Activity['kind'] = 'event', durationMs?: number): void {
    this.add({
      name: name.slice(0, 160),
      kind,
      atMs: this.now(),
      ...(durationMs === undefined ? {} : { durationMs }),
    });
  }

  gc(entry: { startTime: number; duration: number; detail?: { kind?: number } }): void {
    this.add({
      name: 'gc',
      kind: 'gc',
      atMs: entry.startTime,
      durationMs: entry.duration,
      gcKind: entry.detail?.kind,
    });
  }

  private add(entry: Activity): void {
    if (this.entries.length === 512) {
      this.entries.shift();
      this.dropped++;
    }
    this.entries.push(entry);
  }

  drain(since = -Infinity): { entries: Activity[]; dropped: number } {
    const result = {
      entries: this.entries.filter(
        (entry) => entry.atMs + (entry.kind === 'gc' ? (entry.durationMs ?? 0) : 0) >= since
      ),
      dropped: this.dropped,
    };
    this.entries = [];
    this.dropped = 0;
    return result;
  }

  phase(name: string): () => void {
    const start = this.now();
    this.record(name, 'start');
    return () => {
      if (active === this) this.record(name, 'end', this.now() - start);
    };
  }
}

export function beginLagPhase(name: string): () => void {
  return active?.phase(name) ?? noop;
}

export function observeLagGc(activity: EventLoopActivity): {
  status: string;
  stop: () => void;
  flush: () => void;
} {
  if (!PerformanceObserver.supportedEntryTypes.includes('gc'))
    return { status: 'unsupported', stop: noop, flush: noop };
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) activity.gc(entry);
  });
  observer.observe({ entryTypes: ['gc'] });
  return {
    status: 'supported',
    stop: () => observer.disconnect(),
    flush: () => {
      for (const entry of observer.takeRecords()) activity.gc(entry);
    },
  };
}

export function runLagPhase<T>(name: string, run: () => T): T {
  if (!active) return run();
  const end = beginLagPhase(name);
  try {
    const result = run();
    if (result instanceof Promise) void result.then(end, end);
    else end();
    return result;
  } catch (error) {
    end();
    throw error;
  }
}
