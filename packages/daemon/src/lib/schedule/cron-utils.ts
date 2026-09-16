import { Cron } from 'croner';

export function isValidCronExpression(expr: string): boolean {
  try {
    new Cron(expr, { timezone: 'UTC', startAt: new Date(0), stopAt: new Date(0) });
    return true;
  } catch {
    return false;
  }
}

export function getNextRunAt(expr: string, tz = 'UTC', afterMs?: number): number | null {
  const after = afterMs !== undefined ? new Date(afterMs) : new Date();
  try {
    const job = new Cron(expr, { timezone: tz, startAt: after });
    const next = job.nextRun(after);
    return next ? next.getTime() : null;
  } catch {
    return null;
  }
}
