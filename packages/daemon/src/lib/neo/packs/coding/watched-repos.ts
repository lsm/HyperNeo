import type { Database } from '../../../../storage/sqlite-compat.ts';
import { planCodingUnownedNotice, type CodingUnownedPr } from './pr-unowned.ts';
import { getNeoPackPreference } from '../../preferences.ts';

export function codingWatchedRepos(db: Database): string[] | null {
  const saved = getNeoPackPreference(db, 'coding', { kind: 'global', key: '' }, 'watchedRepos');
  return saved ? [...new Set((saved.value as string[]).map((repo) => repo.toLowerCase()))] : null;
}

export function initializeCodingWatches(db: Database, repos: readonly string[]): void {
  db.prepare(`INSERT OR IGNORE INTO neo_pack_preferences
    (pack, scope_kind, scope_key, key, value_json, set_by, set_at)
    VALUES ('coding', 'global', '', 'watchedRepos', ?, 'upgrade', ?)`).run(
    JSON.stringify([...new Set(repos.map((repo) => repo.toLowerCase()))]),
    Date.now()
  );
  const pending = db
    .prepare(
      'SELECT pending_key AS key FROM pack_coding_pr_unowned_state WHERE pending_key IS NOT NULL AND pending_rows IS NULL'
    )
    .get() as { key: string } | undefined;
  if (!pending) return;
  const rows = db
    .prepare(`SELECT l.repo, l.number, l.title, n.listed_at AS at
    FROM pack_coding_pr_ledger l JOIN pack_coding_pr_unowned n
    ON n.key = 'neo-pr-unowned:' || l.repo || '#' || l.number ORDER BY l.repo, l.number`)
    .all() as (CodingUnownedPr & { at: number })[];
  for (const at of new Set(rows.map((row) => row.at))) {
    const batch = rows
      .filter((row) => row.at === at)
      .map(({ repo, number, title }) => ({ repo, number, title }));
    if (planCodingUnownedNotice(batch)?.key === pending.key)
      db.prepare(
        'UPDATE pack_coding_pr_unowned_state SET pending_rows = ? WHERE pending_key = ?'
      ).run(JSON.stringify(batch), pending.key);
  }
}

export function codingRepoWatched(db: Database, repo: string): boolean {
  const watched = codingWatchedRepos(db);
  if (watched === null) return true;
  const key = repo.toLowerCase();
  return (
    watched.includes(key) ||
    !!db
      .prepare(`SELECT 1 FROM pack_coding_repo_aliases
    WHERE canonical = ? AND alias IN (SELECT value FROM json_each(?))`)
      .get(key, JSON.stringify(watched))
  );
}
