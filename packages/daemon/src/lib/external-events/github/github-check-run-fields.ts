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

export type CheckRunTopicAction = 'failed' | 'cancelled' | 'skipped';

export function checkRunTopicAction(conclusion: string): CheckRunTopicAction | null {
  if (conclusion === 'cancelled') return 'cancelled';
  if (conclusion === 'skipped') return 'skipped';
  if (conclusion === '' || conclusion === 'success' || conclusion === 'neutral') return null;
  return 'failed';
}

export function checkRunOccurredAt(row: unknown): number {
  if (!row || typeof row !== 'object') return Date.now();
  const checkRun = row as { completed_at?: unknown; updated_at?: unknown; started_at?: unknown };
  return parseGitHubTimestamp(checkRun.completed_at ?? checkRun.updated_at ?? checkRun.started_at);
}
