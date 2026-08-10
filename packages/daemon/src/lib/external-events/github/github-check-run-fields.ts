/**
 * GitHub `check_run` row field decoders — pure helpers that read typed fields
 * off a raw GitHub check-run row (`unknown` / `Record<string, unknown>`) and
 * return primitive values with safe fallbacks.
 *
 * Canonical home. These helpers previously lived inline at the bottom of
 * {@link file://./github-event-extension.ts} (the check-run polling handler);
 * that file now imports them from here.
 *
 * Narrow capability surface: {@link checkRunIdFrom}, {@link checkRunConclusionFrom},
 * {@link checkRunAppKeyFrom}, {@link checkRunNameFrom}, {@link checkRunOccurredAt},
 * and {@link isNonFailureConclusion}. No module-private members.
 */

import { parseGitHubTimestamp } from './github-normalizer';

export function checkRunIdFrom(row: unknown): number | string {
  if (!row || typeof row !== 'object') return 'unknown';
  const id = (row as { id?: unknown }).id;
  return typeof id === 'number' || typeof id === 'string' ? id : 'unknown';
}

export function checkRunConclusionFrom(row: unknown): string {
  if (!row || typeof row !== 'object') return '';
  const conclusion = (row as { conclusion?: unknown }).conclusion;
  return typeof conclusion === 'string' ? conclusion : '';
}

export function checkRunAppKeyFrom(row: unknown): string {
  if (!row || typeof row !== 'object') return '';
  const app = (row as { app?: unknown }).app;
  if (!app || typeof app !== 'object') return '';
  const slug = (app as { slug?: unknown }).slug;
  if (typeof slug === 'string' && slug) return slug;
  const id = (app as { id?: unknown }).id;
  return typeof id === 'number' ? String(id) : '';
}

export function checkRunNameFrom(row: unknown): string {
  if (!row || typeof row !== 'object') return '';
  const name = (row as { name?: unknown }).name;
  return typeof name === 'string' ? name : '';
}

/**
 * Returns true for conclusions that represent a non-failure (CI is green or
 * skipped). Used to suppress earlier failed runs of the same check name when a
 * newer run superseded them.
 */
export function isNonFailureConclusion(conclusion: string): boolean {
  return conclusion === 'success' || conclusion === 'skipped' || conclusion === 'neutral';
}

export function checkRunOccurredAt(row: unknown): number {
  if (!row || typeof row !== 'object') return Date.now();
  const checkRun = row as { completed_at?: unknown; updated_at?: unknown; started_at?: unknown };
  return parseGitHubTimestamp(checkRun.completed_at ?? checkRun.updated_at ?? checkRun.started_at);
}
