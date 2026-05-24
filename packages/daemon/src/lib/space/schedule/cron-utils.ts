/**
 * Cron utilities — thin wrapper around `croner` for schedule validation and next-run computation.
 *
 * Provides:
 *   isValidCronExpression(expr)       — validate a cron expression (5 or 6 fields + named shortcuts)
 *   getNextRunAt(expr, tz, afterMs?)  — compute the next fire timestamp (ms since epoch)
 */

import { Cron } from 'croner';

/**
 * Check whether a cron expression is syntactically valid.
 *
 * Accepts standard 5-field cron expressions and named shortcuts:
 *   @hourly, @daily, @weekly, @monthly, @yearly / @annually
 *
 * Returns false for any expression that croner cannot parse.
 */
export function isValidCronExpression(expr: string): boolean {
  try {
    // dry-run with a sentinel date so croner parses but never actually schedules
    new Cron(expr, { timezone: 'UTC', startAt: new Date(0), stopAt: new Date(0) });
    return true;
  } catch {
    return false;
  }
}

/**
 * Compute the next fire timestamp (ms since epoch) for a cron expression.
 *
 * @param expr     - cron expression (5-field or @shortcut)
 * @param tz       - IANA timezone string (default: 'UTC')
 * @param afterMs  - compute next run after this timestamp (default: now)
 * @returns        - ms since epoch of next scheduled run, or null if the expression
 *                   has no future occurrence (e.g. stopped)
 */
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
