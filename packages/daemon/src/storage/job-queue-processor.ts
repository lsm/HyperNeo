import type { Job, JobQueueRepository } from './repositories/job-queue-repository';

export type JobHandler = (job: Job) => Promise<Record<string, unknown> | void>;

export interface JobQueueProcessorOptions {
  pollIntervalMs?: number;
  maxConcurrent?: number;
  staleThresholdMs?: number;
}

export class JobQueueProcessor {
  private handlers = new Map<string, JobHandler>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private inFlight = 0;
  private running = false;
  private changeNotifier: ((table: string) => void) | null = null;
  private readonly pollIntervalMs: number;
  private readonly maxConcurrent: number;
  private readonly staleThresholdMs: number;
  private lastStaleCheck = 0;
  private static readonly STALE_CHECK_INTERVAL = 60_000;

  constructor(
    private repo: JobQueueRepository,
    options?: JobQueueProcessorOptions
  ) {
    this.pollIntervalMs = options?.pollIntervalMs ?? 1000;
    this.maxConcurrent = options?.maxConcurrent ?? 1;
    this.staleThresholdMs = options?.staleThresholdMs ?? 5 * 60 * 1000;
  }

  register(queue: string, handler: JobHandler): void {
    this.handlers.set(queue, handler);
  }

  start(): void {
    this.running = true;
    // Eagerly reclaim stale jobs from a previous crash before the first poll tick,
    // so crash-recovery is instant rather than delayed by up to STALE_CHECK_INTERVAL.
    this.repo.reclaimStale(Date.now() - this.staleThresholdMs);
    this.lastStaleCheck = Date.now();
    this.pollTimer = setInterval(() => {
      this.tick();
    }, this.pollIntervalMs);
    this.tick();
  }

  stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    return new Promise<void>((resolve) => {
      if (this.inFlight === 0) {
        resolve();
        return;
      }
      const check = setInterval(() => {
        if (this.inFlight === 0) {
          clearInterval(check);
          resolve();
        }
      }, 50);
    });
  }

  async tick(): Promise<number> {
    this.checkStaleJobs();

    const available = this.maxConcurrent - this.inFlight;
    if (available <= 0) return 0;

    let claimed = 0;
    let slots = available;

    for (const queue of this.handlers.keys()) {
      if (slots <= 0) break;
      const jobs = this.repo.dequeue(queue, slots);
      for (const job of jobs) {
        this.processJob(job);
      }
      claimed += jobs.length;
      slots -= jobs.length;
    }

    return claimed;
  }

  private async processJob(job: Job): Promise<void> {
    this.inFlight++;
    try {
      const handler = this.handlers.get(job.queue);
      if (!handler) {
        this.repo.fail(job.id, `No handler registered for queue: ${job.queue}`);
        this.notifyChange();
        return;
      }
      const result = await handler(job);
      this.repo.complete(job.id, result ?? undefined);
      this.notifyChange();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.repo.fail(job.id, message);
      this.notifyChange();
    } finally {
      this.inFlight--;
    }
  }

  setChangeNotifier(notifier: (table: string) => void): void {
    this.changeNotifier = notifier;
  }

  private notifyChange(): void {
    if (this.changeNotifier) {
      this.changeNotifier('job_queue');
    }
  }

  private checkStaleJobs(): void {
    const now = Date.now();
    if (now - this.lastStaleCheck < JobQueueProcessor.STALE_CHECK_INTERVAL) return;
    this.repo.reclaimStale(now - this.staleThresholdMs);
    this.lastStaleCheck = now;
  }
}
