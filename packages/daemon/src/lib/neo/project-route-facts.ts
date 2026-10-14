import type { Database } from '../../storage/sqlite-compat.ts';
import { parseGitHubRefUrl } from '../github/parse-pr-url.ts';
import { extractNeoCardRefs } from './packs/coding/ask-prs.ts';

export interface NeoProjectFact {
  reference: string;
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

function mentions(text: string, reference: string): boolean {
  const escaped = reference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\w:-])${escaped}(?=$|[^\\w:-])`, 'i').test(text);
}

export function readNeoProjectFacts(db: Database, text: string): NeoProjectFact[] {
  const facts: NeoProjectFact[] = [];
  const objects = db
    .prepare(`SELECT id AS reference, concern_id AS projectId FROM neo_asks
    UNION ALL SELECT id, concern_id FROM neo_work
    UNION ALL SELECT id, concern_id FROM neo_consultations
    UNION ALL SELECT id, id FROM neo_concerns WHERE id LIKE 'project:%' OR length(id) = 36`)
    .all() as NeoProjectFact[];
  facts.push(...objects.filter((row) => mentions(text, row.reference)));
  const aliases = db
    .prepare('SELECT alias, project_id AS projectId FROM neo_project_workspaces')
    .all() as { alias: string; projectId: string }[];
  for (const row of aliases.filter((row) => row.alias.startsWith('work:'))) {
    const reference = row.alias.split('\u0000').slice(2).join('\u0000');
    if (mentions(text, reference)) facts.push({ reference, projectId: row.projectId });
  }
  const byFolder = (folder: string) =>
    aliases.filter(
      (row) => row.alias.startsWith('folder:') && row.alias.endsWith(`\u0000${folder}`)
    );
  for (const row of aliases) {
    if (!row.alias.startsWith('folder:')) continue;
    const folder = row.alias.slice(row.alias.indexOf('\u0000') + 1);
    if (mentions(text, folder)) facts.push({ reference: folder, projectId: row.projectId });
  }
  const sessions = db
    .prepare('SELECT id, workspace_path AS folder, worktree_path AS worktree FROM sessions')
    .all() as { id: string; folder: string | null; worktree: string | null }[];
  for (const session of sessions.filter((row) => mentions(text, row.id))) {
    const owned = db
      .prepare(
        'SELECT concern_id AS projectId FROM neo_work WHERE session_id = ? OR target_session_id = ?'
      )
      .all(session.id, session.id) as { projectId: string | null }[];
    const matches = owned.length ? owned : byFolder(session.worktree ?? session.folder ?? '');
    facts.push(
      ...(matches.length ? matches : [{ projectId: undefined }]).map((row) => ({
        reference: session.id,
        projectId: row.projectId,
      }))
    );
  }
  const urls = [
    ...text.matchAll(/https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:pull|issues)\/\d+/g),
  ].map(([url]) => ({ reference: url, ref: parseGitHubRefUrl(url)! }));
  const named = extractNeoCardRefs(text, null).map((ref) => ({
    reference: `${ref.owner}/${ref.repo}#${ref.number}`,
    ref,
  }));
  const prs = db
    .prepare(`SELECT json_extract(p.value, '$.url') AS url, w.concern_id AS projectId
    FROM neo_work_prs r JOIN neo_work w ON w.id = r.work_id JOIN json_each(r.prs_json) p`)
    .all() as { url: string; projectId: string | null }[];
  for (const [reference, number] of text.matchAll(/(?<![\w/])#(\d+)\b/g)) {
    const matches = prs.filter((pr) => parseGitHubRefUrl(pr.url)?.number === Number(number));
    if (matches.length)
      facts.push(...matches.map((pr) => ({ reference, projectId: pr.projectId })));
    else if (!facts.length) facts.push({ reference, projectId: undefined });
  }
  for (const { reference, ref } of [...urls, ...named]) {
    const explicit = prs.filter((pr) => {
      const known = parseGitHubRefUrl(pr.url);
      return (
        known &&
        known.owner.toLowerCase() === ref.owner.toLowerCase() &&
        known.repo.toLowerCase() === ref.repo.toLowerCase() &&
        known.number === ref.number
      );
    });
    const matches = explicit.length
      ? explicit
      : aliases.filter((row) =>
          row.alias.startsWith(`repo:${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}\u0000`)
        );
    facts.push(
      ...(matches.length ? matches : [{ projectId: undefined }]).map((row) => ({
        reference,
        projectId: row.projectId,
      }))
    );
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
