export class DeliveryTurnStallWatchdog {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private resolveFire: (() => void) | null = null;

  constructor(
    private timeoutMs: number,
    private readonly hasOutstandingTool: () => boolean,
    private readonly onFire?: () => void | Promise<void>,
    private readonly isPaused?: () => boolean
  ) {}

  arm(): Promise<void> {
    this.cancel();
    return new Promise<void>((resolve) => {
      this.resolveFire = resolve;
      this.schedule();
    });
  }

  bump(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.schedule();
    }
  }

  resizeTimeoutMs(timeoutMs: number): void {
    this.timeoutMs = timeoutMs;
    if (this.timer) {
      this.bump();
    }
  }

  getTimeoutMs(): number {
    return this.timeoutMs;
  }

  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.resolveFire = null;
  }

  private schedule(): void {
    this.timer = setTimeout(() => void this.onTick(), this.timeoutMs);
    if (typeof (this.timer as { unref?: () => void }).unref === 'function') {
      (this.timer as { unref: () => void }).unref();
    }
  }

  private async onTick(): Promise<void> {
    if (this.hasOutstandingTool() || this.isPaused?.()) {
      this.schedule();
      return;
    }
    this.timer = null;
    try {
      await this.onFire?.();
    } catch {}
    const resolve = this.resolveFire;
    this.resolveFire = null;
    resolve?.();
  }
}
