/**
 * Retention sweeps for append-heavy / event-log tables.
 *
 * The daemon DB grows monotonically: external/github events, the MCP audit log
 * and space goal events are written continuously and never reaped. Over time the
 * file outgrows the OS page cache and scans hit cold disk. This module prunes
 * rows that have reached a terminal state and are older than a configurable TTL,
 * then reclaims the freed pages via `incremental_vacuum`.
 *
 * Policy:
 * - Deletion is OFF by default (`HYPERNEO_RETENTION_ENABLED=1` to activate) and
 *   each TTL is independently configurable. Default windows only matter once
 *   enabled — they are intentionally conservative.
 * - Only terminal-state event rows are pruned; in-flight states (published /
 *   routed / received / pending) are always kept so an active pipeline never
 *   loses work.
 * - `incremental_vacuum(500)` runs every cycle regardless of `enabled`: it is
 *   space maintenance, not deletion, and reclaims pages freed by any delete
 *   (including the pre-existing 7-day job_queue and worktree reapers). It is a
 *   no-op unless the DB is in incremental-vacuum mode (see migration 169 /
 *   DatabaseCore's fresh-DB pragma).
 */

import type { Database as BunDatabase } from 'bun:sqlite';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionConfig {
  /** Master switch for deletion sweeps. Vacuum still runs when disabled. */
  enabled: boolean;
  /** TTL (days) for terminal external + github events and their deliveries. */
  eventsDays: number;
  /** TTL (days) for mcp_audit_log rows. */
  mcpAuditDays: number;
  /** TTL (days) for space_goal_events rows. */
  goalEventsDays: number;
  /** Max pages reclaimed per incremental_vacuum. 0 disables vacuum. */
  vacuumPages: number;
}

export interface RetentionStats {
  externalEvents: number;
  deliveries: number;
  githubEvents: number;
  mcpAudit: number;
  goalEvents: number;
  vacuumedPages: number;
}

function emptyStats(): RetentionStats {
  return {
    externalEvents: 0,
    deliveries: 0,
    githubEvents: 0,
    mcpAudit: 0,
    goalEvents: 0,
    vacuumedPages: 0,
  };
}

function readEnv(name: string): string | undefined {
  return process.env[`HYPERNEO_RETENTION_${name}`];
}

function envBool(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}

function envInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

/**
 * Read retention configuration from `HYPERNEO_RETENTION_*` env vars.
 *
 * Read per-run (not cached at startup) so operators can adjust TTLs without a
 * daemon restart. Defaults are conservative and only take effect once enabled.
 */
export function loadRetentionConfig(): RetentionConfig {
  return {
    enabled: envBool(readEnv('ENABLED')),
    eventsDays: envInt(readEnv('EVENTS_DAYS'), 14),
    mcpAuditDays: envInt(readEnv('MCP_AUDIT_DAYS'), 30),
    goalEventsDays: envInt(readEnv('GOAL_EVENTS_DAYS'), 60),
    vacuumPages: envInt(readEnv('VACUUM_PAGES'), 500),
  };
}

// Terminal (resolved) states for the external-event pipeline. `published` /
// `routed` are in-flight (may still be delivered) and are never pruned.
const EXTERNAL_EVENT_TERMINAL_STATES = [
  'delivered',
  'delivery_failed',
  'failed',
  'ignored',
  'ambiguous',
] as const;

// Deliveries: `pending` is in-flight; only resolved deliveries are pruned.
const DELIVERY_TERMINAL_STATES = ['delivered', 'failed'] as const;

// GitHub events: `received` / `routed` are in-flight; the rest are resolved.
const GITHUB_EVENT_TERMINAL_STATES = [
  'processed',
  'ignored',
  'ambiguous',
  'delivered',
  'failed',
] as const;

function tableExists(db: BunDatabase, name: string): boolean {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}

/**
 * Count the matching rows, then delete them, returning the pre-delete count.
 *
 * We count first because `DELETE ... .changes` includes rows removed by FK
 * CASCADE (e.g. a pruned external event pulls its deliveries), which would
 * inflate the per-table stat. A SELECT COUNT is accurate and cheap (the age
 * columns are indexed). The `whereClause` may carry `?` placeholders bound by
 * `params`, used identically for the count and the delete.
 */
function prune(
  db: BunDatabase,
  table: string,
  whereClause: string,
  params: (string | number)[]
): number {
  const count = (
    db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${whereClause}`).get(...params) as {
      c: number;
    }
  ).c;
  if (count > 0) {
    db.prepare(`DELETE FROM ${table} WHERE ${whereClause}`).run(...params);
  }
  return count;
}

/** Current page count of the database file. */
function pageCount(db: BunDatabase): number {
  const row = db.prepare('PRAGMA page_count').get() as { page_count?: number } | null;
  return Number(row?.page_count ?? 0);
}

/**
 * Reclaim up to `maxPages` free pages from the end of the file.
 *
 * Returns the number of pages freed (page_count delta). A no-op — returns 0 —
 * when the DB is not in incremental-vacuum mode (auto_vacuum != INCREMENTAL),
 * which covers pre-migration existing databases.
 */
export function incrementalVacuum(db: BunDatabase, maxPages: number): number {
  if (maxPages <= 0) return 0;
  const mode = db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum?: number } | null;
  if (Number(mode?.auto_vacuum ?? 0) !== 2) return 0; // 2 == INCREMENTAL

  const before = pageCount(db);
  // Pragma arguments cannot be bound; maxPages is a validated non-negative int.
  db.exec(`PRAGMA incremental_vacuum(${maxPages})`);
  const after = pageCount(db);
  const freed = before - after;
  return freed > 0 ? freed : 0;
}

/**
 * Run retention sweeps for the configured tables, then reclaim freed pages.
 *
 * Each table is guarded by `tableExists` so this is safe to run against a DB
 * that hasn't yet had a given table created (e.g. minimal test schemas, or a
 * fresh DB mid-bootstrap). When `config.enabled` is false, no rows are deleted
 * but `incremental_vacuum` still runs.
 */
export function runRetention(db: BunDatabase, config: RetentionConfig): RetentionStats {
  const stats = emptyStats();

  if (config.enabled) {
    const now = Date.now();
    const eventsCutoff = now - config.eventsDays * DAY_MS;
    const mcpCutoff = now - config.mcpAuditDays * DAY_MS;
    const goalCutoff = now - config.goalEventsDays * DAY_MS;

    // Prune resolved deliveries BEFORE their events: the independent sweep reaps
    // old resolved deliveries under a kept (in-flight) event, and runs with an
    // accurate count. The event delete below then cascades any remaining
    // deliveries of pruned events (uncounted, by design).
    if (tableExists(db, 'space_external_event_deliveries')) {
      stats.deliveries = prune(
        db,
        'space_external_event_deliveries',
        `state IN (${placeholders(DELIVERY_TERMINAL_STATES.length)}) AND updated_at < ?`,
        [...DELIVERY_TERMINAL_STATES, eventsCutoff]
      );
    }

    if (tableExists(db, 'space_external_events')) {
      stats.externalEvents = prune(
        db,
        'space_external_events',
        `state IN (${placeholders(EXTERNAL_EVENT_TERMINAL_STATES.length)}) AND updated_at < ?`,
        [...EXTERNAL_EVENT_TERMINAL_STATES, eventsCutoff]
      );
    }

    if (tableExists(db, 'space_github_events')) {
      stats.githubEvents = prune(
        db,
        'space_github_events',
        `state IN (${placeholders(GITHUB_EVENT_TERMINAL_STATES.length)}) AND updated_at < ?`,
        [...GITHUB_EVENT_TERMINAL_STATES, eventsCutoff]
      );
    }

    if (tableExists(db, 'mcp_audit_log')) {
      stats.mcpAudit = prune(db, 'mcp_audit_log', 'timestamp < ?', [mcpCutoff]);
    }

    if (tableExists(db, 'space_goal_events')) {
      stats.goalEvents = prune(db, 'space_goal_events', 'created_at < ?', [goalCutoff]);
    }
  }

  stats.vacuumedPages = incrementalVacuum(db, config.vacuumPages);
  return stats;
}
