import type { Database } from '../../../../storage/sqlite-compat.ts';
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

export function codingCanonicalRepo(db: Database, repo: string): string {
  const row = db
    .prepare('SELECT canonical FROM pack_coding_repo_aliases WHERE alias = ?')
    .get(repo.toLowerCase()) as { canonical: string } | undefined;
  return (row?.canonical ?? repo).toLowerCase();
}

export function unwatchCodingRepos(
  db: Database,
  repos: readonly string[],
  remaining: readonly string[]
): void {
  const watched = codingWatchedRepos(db);
  if (watched === null) return;
  const canonical = (repo: string) => codingCanonicalRepo(db, repo);
  const kept = new Set(remaining.map(canonical));
  const removed = new Set(repos.map(canonical).filter((repo) => !kept.has(repo)));
  const next = watched.filter((repo) => !removed.has(canonical(repo)));
  if (next.length === watched.length) return;
  db.prepare(
    "UPDATE neo_pack_preferences SET value_json = ?, set_by = 'project_forget', set_at = ? WHERE pack = 'coding' AND scope_kind = 'global' AND scope_key = '' AND key = 'watchedRepos'"
  ).run(JSON.stringify(next), Date.now());
}
