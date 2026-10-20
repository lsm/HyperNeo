import { claudeOwnerSession } from './pr-owner-session.ts';
import { Database } from 'bun:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readCodeIdentity } from '../../../packages/daemon/src/lib/drivers/code-identity.ts';
import { readCodexThread } from '../../../packages/daemon/src/lib/drivers/codex-desktop-adapter.ts';
import {
  codingRemoteRepo,
  planCodingPrOwner,
} from '../../../packages/daemon/src/lib/neo/packs/coding/pr-ledger.ts';
import { codingPrKey } from '../../../packages/daemon/src/lib/neo/packs/coding/todo-prs.ts';

if (process.argv.includes('--synthetic')) {
  const { verifySyntheticPrOwners } = await import('./pr-owners-synthetic.ts');
  await verifySyntheticPrOwners(process.argv.at(-1)!);
  process.exit(0);
}

const live = new Database(`file:${join(homedir(), '.hyperneo/data/daemon.db')}?mode=ro`, {
  readonly: true,
});
const rows = live
  .prepare(
    'SELECT repo, number, branch, owner FROM pack_coding_pr_ledger WHERE closed_at IS NULL ORDER BY repo, number'
  )
  .all() as { repo: string; number: number; branch: string; owner: string | null }[];
const claims = new Map(
  (
    live
      .prepare(
        `SELECT c.url, s.ref FROM pack_coding_pr_claims c
           JOIN neo_todo_sessions s ON s.todo_id = c.todo_id JOIN neo_todos t ON t.id = c.todo_id
          WHERE s.ref IS NOT NULL ORDER BY t.state IN ('todo', 'doing'), COALESCE(t.started_at, 0)`
      )
      .all() as { url: string; ref: string }[]
  ).map((row) => [row.url, row.ref])
);
const remotes = new Map<string, string[]>();
const repos = async (folder: string | null | undefined) => {
  if (!folder) return [];
  if (!remotes.has(folder))
    remotes.set(
      folder,
      ((await readCodeIdentity(folder)).remotes ?? []).flatMap((r) => codingRemoteRepo(r) ?? [])
    );
  return remotes.get(folder)!;
};
const keys = (urls: string[]) => urls.flatMap((url) => codingPrKey(url) ?? []);
type Session = {
  ref: string;
  active: number;
  repos: string[];
  branches: string[];
  owned: string[];
  prs: string[];
  dismissed: string[];
};
const sessions: Session[] = [];

const { createCodingClaudeOwnerReader } = await import(
  '../../../packages/daemon/src/lib/neo/packs/coding/claude-pr-owners.ts'
);
for (const value of await createCodingClaudeOwnerReader()()) {
  sessions.push(claudeOwnerSession(value));
}
const codexPath = join(homedir(), '.codex/state_5.sqlite');
const codex = new Database(`file:${codexPath}?mode=ro`, { readonly: true });
for (const { id } of codex
  .prepare('SELECT id FROM threads WHERE COALESCE(archived, 0) = 0')
  .all() as { id: string }[]) {
  const detail = readCodexThread(codexPath, id);
  if (!detail) continue;
  sessions.push({
    ref: JSON.stringify({ adapter: 'codex-desktop', id }),
    active: detail.thread.updatedAt,
    repos: await repos(detail.thread.folder),
    branches: detail.thread.branch ? [detail.thread.branch] : [],
    owned: [],
    prs: keys(detail.linkedPrs ?? []),
    dismissed: [],
  });
}
const old = new Map<string, string[]>();
const table = (name: string) =>
  live.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
const opened = table('pack_coding_session_facts')
  ? 'SELECT value AS url, ref FROM pack_coding_session_facts, json_each(opened)'
  : table('pack_coding_session_prs')
    ? 'SELECT url, ref FROM pack_coding_session_prs'
    : null;
for (const row of opened ? (live.prepare(opened).all() as { url: string; ref: string }[]) : [])
  old.set(row.ref, [...(old.get(row.ref) ?? []), row.url]);
for (const row of live
  .prepare(
    `SELECT id, COALESCE(worktree_branch, git_branch) AS branch, COALESCE(worktree_path, workspace_path) AS folder,
            last_active_at AS active FROM sessions WHERE archived_at IS NULL`
  )
  .all() as { id: string; branch: string | null; folder: string | null; active: string }[]) {
  const ref = JSON.stringify({ adapter: 'hyperneo', id: row.id });
  sessions.push({
    ref,
    active: Date.parse(row.active) || 0,
    repos: await repos(row.folder),
    branches: row.branch ? [row.branch] : [],
    owned: [],
    prs: old.get(ref) ?? [],
    dismissed: [],
  });
}
sessions.sort((a, b) => b.active - a.active);

const before = rows.filter((row) => row.owner).length;
const changes = rows.flatMap((row) => {
  const next = planCodingPrOwner(row, claims, sessions);
  return next === row.owner ? [] : [{ pr: `${row.repo}#${row.number}`, from: row.owner, to: next }];
});
const after = rows.filter((row) => planCodingPrOwner(row, claims, sessions) !== null).length;
console.log(
  `open rows ${rows.length}; owned before ${before}; owned after ${after}; sessions ${sessions.length}`
);
for (const change of changes) console.log(JSON.stringify(change));
if (process.argv.includes('--debug')) {
  console.log('sessions with prs', sessions.filter((s) => s.prs.length).length);
  console.log('sample prs', sessions.flatMap((s) => s.prs).slice(0, 8));
  console.log(
    'unowned',
    rows
      .filter((r) => !planCodingPrOwner(r, claims, sessions))
      .map((r) => `${r.repo}#${r.number}:${r.branch}`)
      .join(' ')
  );
}
