import type { Database } from '../../storage/sqlite-compat.ts';
import { parseGitHubRefUrl } from '../github/parse-pr-url.ts';
import { extractNeoCardRefs } from './packs/coding/ask-prs.ts';

export interface NeoProjectFact {
  reference: string;
  projectOnly?: true;
  projectId: string | null | undefined;
}

export function neoRepoAlias(remote: string): string | null {
  const url = remote
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/\/?$/, '')
    .replace(/\.git$/, '');
  const ref = parseGitHubRefUrl(`${url}/issues/1`);
  return ref ? `repo:${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}\u0000` : null;
}

export function readNeoProjectFacts(db: Database, text: string): NeoProjectFact[] {
  const facts: NeoProjectFact[] = [];
  const ids = [...new Set([...text.matchAll(/[\w:.-]+/g)].map(([id]) => id.replace(/\.+$/, '')))];
  const aliasOwners = (kind: string, expression: string, reference: string) =>
    db
      .prepare(`SELECT project_id AS projectId FROM neo_project_workspaces
      WHERE alias LIKE '${kind}:%' AND ${expression} = ?`)
      .all(reference) as {
      projectId: string;
    }[];
  const folderExpression =
    "CAST(substr(CAST(alias AS BLOB), instr(CAST(alias AS BLOB), x'00') + 1) AS TEXT) COLLATE NOCASE";
  const workExpression =
    "CAST(substr(CAST(alias AS BLOB), instr(CAST(alias AS BLOB), x'00') + instr(substr(CAST(alias AS BLOB), instr(CAST(alias AS BLOB), x'00') + 1), x'00') + 1) AS TEXT) COLLATE NOCASE";
  const add = (
    reference: string,
    rows: { projectId: string | null }[],
    unknown = false,
    projectOnly = false
  ) =>
    facts.push(
      ...(rows.length ? rows : unknown ? [{ projectId: undefined }] : []).map((row) => ({
        reference,
        ...(projectOnly ? { projectOnly: true as const } : {}),
        projectId: row.projectId,
      }))
    );
  const sessions: { id: string; folder: string | null; worktree: string | null }[] = [];
  for (let start = 0; start < ids.length; start += 256) {
    const batch = ids.slice(start, start + 256);
    const placeholders = batch.map(() => '?').join(',');
    for (const table of ['legacy_neo_asks', 'neo_work', 'neo_consultations', 'neo_concerns'])
      facts.push(
        ...(db
          .prepare(`SELECT id AS reference, ${table === 'neo_concerns' ? 'id' : 'concern_id'} AS projectId
        FROM ${table} WHERE id COLLATE NOCASE IN (${placeholders})
        ${table === 'neo_concerns' ? "AND (id LIKE 'project:%' OR length(id) = 36)" : ''}`)
          .all(...batch) as NeoProjectFact[])
      );
    sessions.push(
      ...(db
        .prepare(`SELECT id, workspace_path AS folder, worktree_path AS worktree
      FROM sessions WHERE id COLLATE NOCASE IN (${placeholders})`)
        .all(...batch) as typeof sessions)
    );
  }
  for (const id of ids) add(id, aliasOwners('work', workExpression, id), false, true);
  for (const match of text.matchAll(/["'`]([^"'`]+)["'`]|(\/[^\s"'`<>(){},;!?]+)/g)) {
    const folder = (match[1] ?? match[2]).replace(/\.+$/, '');
    if (folder.startsWith('/'))
      add(folder, aliasOwners('folder', folderExpression, folder), false, true);
  }
  for (const session of sessions) {
    const owned = db
      .prepare(
        'SELECT concern_id AS projectId FROM neo_work WHERE session_id = ? OR target_session_id = ?'
      )
      .all(session.id, session.id) as { projectId: string | null }[];
    add(
      session.id,
      owned.length
        ? owned
        : aliasOwners('folder', folderExpression, session.worktree ?? session.folder ?? ''),
      true,
      !owned.length
    );
  }
  const urls = [
    ...text.matchAll(/https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:pull|issues)\/\d+/g),
  ].map(([url]) => ({ reference: url, ref: parseGitHubRefUrl(url)! }));
  const named = extractNeoCardRefs(text, null).map((ref) => ({
    reference: `${ref.owner}/${ref.repo}#${ref.number}`,
    ref,
  }));
  const todoRefs = !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'neo_todo_pr_refs'")
    .get();
  const prOwners = (column: 'reference' | 'number', value: string | number) =>
    db
      .prepare(`SELECT w.concern_id AS projectId FROM neo_route_pr_refs r
      JOIN neo_work w ON w.id = r.work_id WHERE r.${column} = ?${
        todoRefs
          ? ` UNION ALL SELECT a.project_id AS projectId FROM neo_todo_pr_refs r
      JOIN neo_todos t ON t.id = r.todo_id JOIN neo_asks a ON a.id = t.ask_id WHERE r.${column} = ?`
          : ''
      }`)
      .all(...(todoRefs ? [value, value] : [value])) as {
      projectId: string | null;
    }[];
  for (const [reference, number] of text.matchAll(/(?<![\w/])#(\d+)\b/g)) {
    add(reference, prOwners('number', Number(number)), true);
  }
  for (const { reference, ref } of [...urls, ...named]) {
    const repo = `${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}`;
    const explicit = prOwners('reference', `https://github.com/${repo}/pull/${ref.number}`);
    const matches = explicit.length
      ? explicit
      : aliasOwners('repo', 'substr(alias, 6, instr(alias, char(0)) - 6)', repo);
    add(reference, matches, true, !explicit.length);
  }
  for (const [reference] of text.matchAll(/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/gi)) {
    if (!facts.some((fact) => fact.reference.toLowerCase().includes(reference.toLowerCase())))
      facts.push({ reference, projectId: undefined });
  }
  return facts;
}

export function neoFactOwners(facts: readonly NeoProjectFact[]): (string | null)[] | null {
  if (facts.some((fact) => fact.projectId === undefined)) return null;
  for (const reference of new Set(facts.map((fact) => fact.reference))) {
    if (
      new Set(facts.filter((fact) => fact.reference === reference).map((fact) => fact.projectId))
        .size > 1
    )
      return null;
  }
  return [...new Set(facts.map((fact) => fact.projectId))] as (string | null)[];
}
