import { createHash } from 'node:crypto';
import type { NeoBinding, NeoProject } from '@hyperneo/shared/types/neo-context';
import { neoProjectMoveReason, neoProjectPath } from '@hyperneo/shared/types/neo-project-tree';
import type { NeoProjectFacts } from '../../lib/neo/project-cleanup.ts';
import type { Database } from '../sqlite-compat.ts';
import { NeoProjectMergeRepository } from './neo-project-merge-repository.ts';

const concernColumns = `id, title, summary, context, revision, parent_id AS parentId, epic_url AS epicUrl, home_path AS homePath,
  created_at AS createdAt, updated_at AS updatedAt`;
const bindingColumns = 'session_id AS sessionId, concern_id AS projectId, kind';
export type NeoProjectInput = Pick<NeoProject, 'id' | 'title' | 'summary' | 'context'>;
export class NeoRepository {
  readonly projectMerges: NeoProjectMergeRepository;
  constructor(
    private readonly db: Database,
    private readonly notify: () => void = () => {}
  ) {
    this.projectMerges = new NeoProjectMergeRepository(db, notify);
  }

  listProjects(): NeoProject[] {
    return this.db
      .prepare(`SELECT ${concernColumns} FROM neo_concerns
        WHERE id NOT IN (SELECT source_id FROM neo_project_merges) ORDER BY updated_at DESC, id`)
      .all() as NeoProject[];
  }

  projectCleanupFacts(): NeoProjectFacts[] {
    const rows = this.db
      .prepare(`SELECT c.id, c.title, c.created_at AS createdAt,
          (c.epic_url IS NOT NULL OR EXISTS (SELECT 1 FROM neo_concerns k WHERE k.parent_id = c.id)) AS section,
          length(c.context) AS context,
          (SELECT count(*) FROM neo_asks n WHERE n.project_id = c.id) AS asks,
          (SELECT count(*) FROM neo_asks n WHERE n.project_id = c.id
            AND n.status = 'open') AS liveAsks
        FROM neo_concerns c
        WHERE c.id NOT IN (SELECT source_id FROM neo_project_merges)`)
      .all() as (Omit<NeoProjectFacts, 'section' | 'aliases'> & { section: number })[];
    const aliases = this.db
      .prepare('SELECT project_id AS projectId, alias FROM neo_project_workspaces')
      .all() as { projectId: string; alias: string }[];
    return rows.map((row) => ({
      ...row,
      section: !!row.section,
      aliases: aliases.filter((entry) => entry.projectId === row.id).map((entry) => entry.alias),
    }));
  }

  deleteEmptyProject(projectId: string): void {
    this.db.transaction(() => {
      const empty = this.db
        .prepare(`SELECT 1 FROM neo_concerns c WHERE c.id = ? AND length(c.context) = 0
          AND c.epic_url IS NULL
          AND NOT EXISTS (SELECT 1 FROM neo_concerns k WHERE k.parent_id = c.id)
          AND NOT EXISTS (SELECT 1 FROM neo_asks n WHERE n.project_id = c.id)`)
        .get(projectId);
      if (!empty) throw new Error('the project is no longer empty');
      this.db.prepare('DELETE FROM neo_project_workspaces WHERE project_id = ?').run(projectId);
      this.db.prepare('DELETE FROM neo_concerns WHERE id = ?').run(projectId);
    })();
    this.notify();
  }

  forgetProject(
    projectId: string,
    afterForget: () => void = () => {}
  ): { forgotten: true } | { reason: 'project_missing' | 'project_in_use' } {
    const result = this.db.transaction(() => {
      if (!this.db.prepare('SELECT 1 FROM neo_concerns WHERE id = ?').get(projectId))
        return { reason: 'project_missing' as const };
      const used = this.db
        .prepare(`SELECT 1 WHERE EXISTS (SELECT 1 FROM neo_concerns WHERE parent_id = ?1)
          OR EXISTS (SELECT 1 FROM neo_asks WHERE project_id = ?1 AND status = 'open')
          OR EXISTS (SELECT 1 FROM neo_session_bindings WHERE concern_id = ?1)
          OR EXISTS (SELECT 1 FROM neo_project_merges WHERE source_id = ?1 OR target_id = ?1)`)
        .get(projectId);
      if (used) return { reason: 'project_in_use' as const };
      this.db.prepare('UPDATE neo_asks SET project_id = NULL WHERE project_id = ?').run(projectId);
      this.db.prepare('DELETE FROM neo_project_workspaces WHERE project_id = ?').run(projectId);
      this.db.prepare('DELETE FROM neo_concerns WHERE id = ?').run(projectId);
      afterForget();
      return { forgotten: true as const };
    })();
    if ('forgotten' in result) this.notify();
    return result;
  }

  resolveProjectRef(ref: string): string | null {
    const key = ref.trim();
    const bare = key.replace(/^project:/i, '');
    const resolve = (matches: { id: string }[]) => {
      const ids = new Set(
        matches
          .map(({ id }) => this.projectMerges.resolve(id) ?? id)
          .filter((id) => this.getProject(id))
      );
      return ids.size === 1 ? [...ids][0] : null;
    };
    const byId = this.db
      .prepare('SELECT id FROM neo_concerns WHERE id IN (?, ?)')
      .all(bare, `project:${bare}`) as { id: string }[];
    if (byId.length) return resolve(byId);
    return resolve(
      this.db.prepare('SELECT id FROM neo_concerns WHERE title = ? COLLATE NOCASE').all(key) as {
        id: string;
      }[]
    );
  }

  getProject(id: string): NeoProject | null {
    return this.db
      .prepare(`SELECT ${concernColumns} FROM neo_concerns WHERE id = ?`)
      .get(id) as NeoProject | null;
  }

  saveProject(input: NeoProjectInput, expectedRevision: number): NeoProject | null {
    const now = Date.now();
    const row =
      expectedRevision === 0
        ? this.db
            .prepare(`INSERT INTO neo_concerns
              (id, title, summary, context, revision, created_at, updated_at)
              VALUES (?, ?, ?, ?, 1, ?, ?) ON CONFLICT(id) DO NOTHING
              RETURNING ${concernColumns}`)
            .get(input.id, input.title, input.summary, input.context, now, now)
        : this.db
            .prepare(`UPDATE neo_concerns SET title = ?, summary = ?, context = ?,
              revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?
              RETURNING ${concernColumns}`)
            .get(input.title, input.summary, input.context, now, input.id, expectedRevision);
    if (row) this.notify();
    return row as NeoProject | null;
  }

  ensureHomePath(project: NeoProject): string {
    const slug =
      project.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 48) || 'project';
    const path = `projects/${slug}-${createHash('sha256').update(project.id).digest('hex').slice(0, 12)}`;
    const changed = this.db
      .prepare('UPDATE neo_concerns SET home_path = ? WHERE id = ? AND home_path IS NULL')
      .run(path, project.id);
    if (changed.changes) this.notify();
    return this.getProject(project.id)!.homePath!;
  }

  allRepositories(projectId?: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT DISTINCT lower(CASE WHEN alias LIKE 'repository:github.com/%'
              THEN substr(alias, length('repository:github.com/') + 1)
              ELSE substr(alias, 6, instr(alias || char(0), char(0)) - 6) END) AS repo
             FROM neo_project_workspaces
            WHERE (alias LIKE 'repository:github.com/%' OR alias LIKE 'repo:%')
              AND (?1 IS NULL OR project_id = ?1)
            ORDER BY repo`
        )
        .all(projectId ?? null) as { repo: string }[]
    ).map((row) => row.repo);
  }

  repositories(): Map<string, string> {
    const canonical = new Map<string, string>();
    const legacy = new Map<string, Set<string>>();
    for (const row of this.db
      .prepare(
        "SELECT alias, project_id FROM neo_project_workspaces WHERE alias >= 'repo' AND alias < 'repp'"
      )
      .all() as { alias: string; project_id: string }[]) {
      if (row.alias.startsWith('repository:'))
        canonical.set(
          row.project_id,
          row.alias.slice('repository:'.length).replace(/^github\.com\//, '')
        );
      else if (row.alias.startsWith('repo:'))
        legacy
          .set(row.project_id, legacy.get(row.project_id) ?? new Set())
          .get(row.project_id)!
          .add(row.alias.slice('repo:'.length).split('\u0000')[0]);
    }
    for (const [projectId, names] of legacy)
      if (!canonical.has(projectId) && names.size === 1) canonical.set(projectId, [...names][0]);
    return canonical;
  }

  workspaceAliases(id: string, projects = this.listProjects()): string[] {
    for (const project of neoProjectPath(projects, id).reverse()) {
      const rows = this.db
        .prepare('SELECT alias FROM neo_project_workspaces WHERE project_id = ?')
        .all(project.id) as { alias: string }[];
      if (rows.length) return rows.map((row) => row.alias);
    }
    return [];
  }

  private sectionWorkspaceMatches(
    epicUrl: string,
    parentId: string,
    projects = this.listProjects()
  ): boolean {
    const repository = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/\d+$/i
      .exec(epicUrl)?.[1]
      .toLowerCase();
    return (
      !!repository &&
      this.workspaceAliases(parentId, projects).some((alias) =>
        alias.startsWith(`repo:${repository}\u0000`)
      )
    );
  }

  moveProject(
    id: string,
    parentId: string | null,
    expectedRevision: number
  ): { ok: true } | { ok: false; reason: string } {
    const result = this.db.transaction(() => {
      const project = this.getProject(id);
      if (!project || project.revision !== expectedRevision)
        return { ok: false as const, reason: 'superseded' };
      const reason = neoProjectMoveReason(this.listProjects(), id, parentId);
      if (reason) return { ok: false as const, reason };
      if (project.epicUrl && parentId === null)
        return { ok: false as const, reason: 'section_needs_parent' };
      const moved = this.listProjects().map((item) =>
        item.id === id ? { ...item, parentId } : item
      );
      for (const section of moved.filter(
        (item) => item.epicUrl && neoProjectPath(moved, item.id).some((node) => node.id === id)
      )) {
        if (
          !section.parentId ||
          !this.sectionWorkspaceMatches(section.epicUrl!, section.parentId, moved)
        )
          return { ok: false as const, reason: 'section_workspace_mismatch' };
      }
      if ((project.parentId ?? null) === parentId) return { ok: true as const };
      this.db
        .prepare(`UPDATE neo_concerns SET parent_id = ?, revision = revision + 1,
        updated_at = ? WHERE id = ? AND revision = ?`)
        .run(parentId, Date.now(), id, expectedRevision);
      return { ok: true as const };
    })();
    if (result.ok) this.notify();
    return result;
  }

  createSection(
    parentId: string,
    epicUrl: string,
    title: string
  ): { ok: true; projectId: string } | { ok: false; reason: string } {
    const result = this.db.transaction(() => {
      if (parentId === 'inbox' || !this.getProject(parentId))
        return { ok: false as const, reason: 'unknown_parent' };
      if (!this.sectionWorkspaceMatches(epicUrl, parentId))
        return { ok: false as const, reason: 'section_workspace_mismatch' };
      const existing = this.db
        .prepare('SELECT id, parent_id AS parentId FROM neo_concerns WHERE epic_url = ?')
        .get(epicUrl) as { id: string; parentId: string } | null;
      if (existing)
        return existing.parentId === parentId
          ? { ok: true as const, projectId: existing.id }
          : { ok: false as const, reason: 'epic_already_has_section' };
      const id = crypto.randomUUID();
      const now = Date.now();
      this.db
        .prepare(`INSERT INTO neo_concerns
        (id, title, summary, context, revision, created_at, updated_at, parent_id, epic_url)
        VALUES (?, ?, ?, '', 1, ?, ?, ?, ?)`)
        .run(id, title, `Section for ${epicUrl}`, now, now, parentId, epicUrl);
      return { ok: true as const, projectId: id };
    })();
    if (result.ok) this.notify();
    return result;
  }

  reserveBinding(binding: NeoBinding): boolean {
    const result = this.db
      .prepare(`INSERT INTO neo_session_bindings (session_id, concern_id, kind)
        VALUES (?, ?, ?) ON CONFLICT DO NOTHING`)
      .run(binding.sessionId, binding.projectId, binding.kind);
    if (result.changes > 0) this.notify();
    return result.changes > 0;
  }

  getBindingBySession(sessionId: string): NeoBinding | null {
    return this.db
      .prepare(`SELECT ${bindingColumns} FROM neo_session_bindings WHERE session_id = ?`)
      .get(sessionId) as NeoBinding | null;
  }

  defaultBinding(): NeoBinding | null {
    return this.db
      .prepare(`SELECT ${bindingColumns} FROM neo_session_bindings WHERE kind = 'neo'`)
      .get() as NeoBinding | null;
  }

  conversationId(): string | null {
    const stored = this.db.prepare('SELECT id FROM neo_conversation').get() as {
      id: string;
    } | null;
    if (stored) return stored.id;
    const session = this.defaultBinding()?.sessionId;
    if (!session?.startsWith('neo:')) return null;
    this.db
      .prepare(
        'INSERT OR IGNORE INTO neo_conversation (singleton, id, created_at) VALUES (1, ?, ?)'
      )
      .run(session.slice(4), Date.now());
    return (this.db.prepare('SELECT id FROM neo_conversation').get() as { id: string }).id;
  }
}
