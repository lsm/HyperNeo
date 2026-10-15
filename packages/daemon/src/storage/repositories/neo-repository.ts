import type { NeoBinding, NeoProject, NeoWork } from '@hyperneo/shared/types/neo-context';
import { neoProjectMoveReason, neoProjectPath } from '@hyperneo/shared/types/neo-project-tree';
import { CONSULTATION_TIMEOUT_MS } from '../../lib/neo/consultation-policy.ts';
import type { NeoProjectFacts, NeoRetiredHolder } from '../../lib/neo/project-cleanup.ts';
import type { Database } from '../sqlite-compat.ts';
import { NeoProjectMergeRepository } from './neo-project-merge-repository.ts';

const concernColumns = `id, title, summary, context, revision, parent_id AS parentId, epic_url AS epicUrl,
  created_at AS createdAt, updated_at AS updatedAt`;
const bindingColumns = 'session_id AS sessionId, concern_id AS projectId, kind';
const workColumns = `id, request_key AS requestKey, concern_id AS projectId,
  origin_session_id AS originSessionId, origin_message_id AS originMessageId,
  title, instruction, target_session_id AS targetSessionId, session_id AS sessionId,
  status, report, follows, created_at AS createdAt, updated_at AS updatedAt`;

export type NeoProjectInput = Pick<NeoProject, 'id' | 'title' | 'summary' | 'context'>;
export type NeoWorkInput = Pick<
  NeoWork,
  'id' | 'requestKey' | 'projectId' | 'originSessionId' | 'title' | 'instruction'
> &
  Partial<Pick<NeoWork, 'originMessageId' | 'follows'>> & { targetSessionId?: string | null };
export interface NeoWorkTarget {
  readonly id: string;
  readonly targetSessionId: string | null;
  readonly agent?: {
    readonly spaceId: string;
    readonly agentId: string;
    readonly sessionId: string;
  };
}
export type NeoWorkState = Pick<NeoWork, 'status' | 'sessionId' | 'report'>;

export class NeoRepository {
  readonly projectMerges: NeoProjectMergeRepository;
  constructor(
    private readonly db: Database,
    private readonly notify: () => void = () => {},
    private readonly onSettled: (work: NeoWork) => void = () => {}
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
          (SELECT count(*) FROM neo_asks a WHERE a.concern_id = c.id) AS asks,
          (SELECT count(*) FROM neo_asks a WHERE a.concern_id = c.id
            AND a.status IN ('open', 'waiting', 'blocked')) AS liveAsks,
          (SELECT count(*) FROM neo_work w WHERE w.concern_id = c.id
            AND w.status IN ('proposed', 'queued')) AS liveWork,
          (SELECT count(*) FROM neo_routing_log r WHERE r.concern_id = c.id) AS routed,
          (SELECT count(*) FROM neo_session_bindings b JOIN sdk_messages m ON m.session_id = b.session_id
            WHERE b.kind = 'project' AND b.concern_id = c.id) AS holderMessages,
          EXISTS (SELECT 1 FROM neo_session_bindings b JOIN sessions s ON s.id = b.session_id
            WHERE b.kind = 'project' AND b.concern_id = c.id AND s.status = 'archived') AS archived,
          (SELECT b.session_id FROM neo_session_bindings b
            WHERE b.kind = 'project' AND b.concern_id = c.id) AS holder
        FROM neo_concerns c
        WHERE c.id NOT IN (SELECT source_id FROM neo_project_merges)`)
      .all() as (Omit<NeoProjectFacts, 'section' | 'archived' | 'work' | 'aliases'> & {
      section: number;
      archived: number;
    })[];
    const work = this.db
      .prepare(`SELECT w.concern_id AS projectId,
          json_extract(t.ref, '$.adapter') || char(0) || json_extract(t.ref, '$.id') AS ref
        FROM neo_work w LEFT JOIN neo_work_driver_targets t ON t.work_id = w.id`)
      .all() as { projectId: string; ref: string | null }[];
    const aliases = this.db
      .prepare('SELECT project_id AS projectId, alias FROM neo_project_workspaces')
      .all() as { projectId: string; alias: string }[];
    return rows.map((row) => ({
      ...row,
      section: !!row.section,
      archived: !!row.archived,
      work: work.filter((entry) => entry.projectId === row.id).map((entry) => ({ ref: entry.ref })),
      aliases: aliases.filter((entry) => entry.projectId === row.id).map((entry) => entry.alias),
    }));
  }

  deleteEmptyProject(projectId: string): string | null {
    const holder = this.db.transaction(() => {
      const empty = this.db
        .prepare(`SELECT 1 FROM neo_concerns c WHERE c.id = ? AND length(c.context) = 0
          AND c.epic_url IS NULL
          AND NOT EXISTS (SELECT 1 FROM neo_concerns k WHERE k.parent_id = c.id)
          AND NOT EXISTS (SELECT 1 FROM neo_asks a WHERE a.concern_id = c.id)
          AND NOT EXISTS (SELECT 1 FROM neo_work w WHERE w.concern_id = c.id)
          AND NOT EXISTS (SELECT 1 FROM neo_routing_log r WHERE r.concern_id = c.id)
          AND NOT EXISTS (SELECT 1 FROM neo_session_bindings b JOIN sdk_messages m
            ON m.session_id = b.session_id WHERE b.kind = 'project' AND b.concern_id = c.id)`)
        .get(projectId);
      if (!empty) throw new Error('the project is no longer empty');
      const session = this.getBindingForProject(projectId)?.sessionId ?? null;
      this.db.prepare('DELETE FROM neo_project_workspaces WHERE project_id = ?').run(projectId);
      this.db
        .prepare("DELETE FROM neo_session_bindings WHERE concern_id = ? AND kind = 'project'")
        .run(projectId);
      this.db.prepare('DELETE FROM neo_concerns WHERE id = ?').run(projectId);
      return session;
    })();
    this.notify();
    return holder;
  }

  retiredHolders(): NeoRetiredHolder[] {
    return (
      this.db
        .prepare(`SELECT m.source_id AS projectId, c.title, m.source_session_id AS sessionId,
            EXISTS (SELECT 1 FROM sdk_messages x WHERE x.session_id = m.source_session_id) AS spoke
          FROM neo_project_merges m
          JOIN neo_concerns c ON c.id = m.source_id
          JOIN sessions s ON s.id = m.source_session_id
          WHERE s.status != 'archived'`)
        .all() as (Omit<NeoRetiredHolder, 'spoke'> & { spoke: number })[]
    ).map((row) => ({ ...row, spoke: !!row.spoke }));
  }

  sessionSpoke(sessionId: string): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM sdk_messages WHERE session_id = ? LIMIT 1')
      .get(sessionId);
  }

  listProjectTitles(): Array<{ id: string; title: string }> {
    return this.db.prepare('SELECT id, title FROM neo_concerns').all() as Array<{
      id: string;
      title: string;
    }>;
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

  retireArchivedBinding(projectId: string, sessionId: string): boolean {
    const result = this.db
      .prepare(`DELETE FROM neo_session_bindings
        WHERE concern_id = ? AND session_id = ? AND kind = 'project'`)
      .run(projectId, sessionId);
    if (result.changes > 0) this.notify();
    return result.changes > 0;
  }

  discardUnopenedProject(id: string): boolean {
    const removed = this.db.transaction(() => {
      this.db
        .prepare(`DELETE FROM neo_session_bindings WHERE concern_id = ? AND kind = 'project'
          AND NOT EXISTS (SELECT 1 FROM sessions WHERE sessions.id = neo_session_bindings.session_id)`)
        .run(id);
      return this.db
        .prepare(`DELETE FROM neo_concerns WHERE id = ?
          AND NOT EXISTS (SELECT 1 FROM neo_session_bindings WHERE concern_id = ?)
          AND NOT EXISTS (SELECT 1 FROM neo_concerns WHERE parent_id = ?)`)
        .run(id, id, id).changes;
    })();
    if (removed > 0) this.notify();
    return removed > 0;
  }

  reserveBinding(binding: NeoBinding): boolean {
    const result = this.db
      .prepare(`INSERT INTO neo_session_bindings (session_id, concern_id, kind)
        VALUES (?, ?, ?) ON CONFLICT DO NOTHING`)
      .run(binding.sessionId, binding.projectId, binding.kind);
    if (result.changes > 0) this.notify();
    return result.changes > 0;
  }

  saveConsultationContext(
    input: NeoProjectInput,
    expectedRevision: number,
    consultationId: string,
    holderSessionId: string
  ): NeoProject | null {
    const saved = this.db.transaction(() => {
      const now = Date.now();
      const row = this.db
        .prepare(`UPDATE neo_concerns SET title = ?, summary = ?, context = ?,
          revision = revision + 1, updated_at = ?
          WHERE id = ? AND revision = ? AND EXISTS (
            SELECT 1 FROM neo_context_write_grants g
            JOIN neo_consultations c ON c.id = g.consultation_id
            JOIN neo_session_bindings b ON b.session_id = c.session_id
            WHERE c.id = ? AND c.session_id = ? AND c.concern_id = neo_concerns.id
              AND b.kind = 'project' AND b.concern_id = c.concern_id
              AND c.status = 'pending' AND c.created_at > ?
              AND g.context_revision = neo_concerns.revision
          ) RETURNING ${concernColumns}`)
        .get(
          input.title,
          input.summary,
          input.context,
          now,
          input.id,
          expectedRevision,
          consultationId,
          holderSessionId,
          now - CONSULTATION_TIMEOUT_MS
        ) as NeoProject | null;
      if (row)
        this.db
          .prepare(
            'UPDATE neo_context_write_grants SET context_revision = ? WHERE consultation_id = ?'
          )
          .run(row.revision, consultationId);
      return row;
    })();
    if (saved) this.notify();
    return saved;
  }

  getBindingBySession(sessionId: string): NeoBinding | null {
    return this.db
      .prepare(`SELECT ${bindingColumns} FROM neo_session_bindings WHERE session_id = ?`)
      .get(sessionId) as NeoBinding | null;
  }

  getBindingForProject(projectId: string | null): NeoBinding | null {
    return this.db
      .prepare(`SELECT ${bindingColumns} FROM neo_session_bindings
        WHERE concern_id IS ? AND kind IN ('neo', 'project')`)
      .get(projectId) as NeoBinding | null;
  }

  listProjectBindings(projectId?: string): (NeoBinding & { kind: 'project'; projectId: string })[] {
    return this.db
      .prepare(`SELECT ${bindingColumns} FROM neo_session_bindings WHERE kind = 'project'
        ${projectId === undefined ? '' : 'AND concern_id = ?'} ORDER BY session_id`)
      .all(...(projectId === undefined ? [] : [projectId])) as (NeoBinding & {
      kind: 'project';
      projectId: string;
    })[];
  }

  proposedBy(originSessionId: string, since: number, until: number): NeoWork[] {
    return this.db
      .prepare(
        `SELECT ${workColumns} FROM neo_work
          WHERE origin_session_id = ? AND created_at > ? AND created_at <= ?
          ORDER BY created_at, id`
      )
      .all(originSessionId, since, until) as NeoWork[];
  }

  listWork(projectId?: string | null): NeoWork[] {
    const condition = projectId === undefined ? '' : 'WHERE concern_id IS ?';
    return this.db
      .prepare(`SELECT ${workColumns} FROM neo_work ${condition} ORDER BY created_at DESC, id`)
      .all(...(projectId === undefined ? [] : [projectId])) as NeoWork[];
  }

  getWork(id: string): NeoWork | null {
    return this.db
      .prepare(`SELECT ${workColumns} FROM neo_work WHERE id = ?`)
      .get(id) as NeoWork | null;
  }

  workForRequest(requestKey: string): NeoWork | null {
    return (
      (this.db
        .prepare(`SELECT ${workColumns} FROM neo_work WHERE request_key = ?`)
        .get(requestKey) as NeoWork | undefined) ?? null
    );
  }

  findWorkBySession(sessionId: string): NeoWork | null {
    return this.db
      .prepare(`SELECT ${workColumns} FROM neo_work WHERE session_id = ?
        ORDER BY created_at DESC, id DESC LIMIT 1`)
      .get(sessionId) as NeoWork | null;
  }

  getWorkTarget(id: string): NeoWorkTarget | null {
    return (
      (this.db
        .prepare('SELECT id, target_session_id AS targetSessionId FROM neo_work WHERE id = ?')
        .get(id) as NeoWorkTarget | null) ?? null
    );
  }

  proposeWork(input: NeoWorkInput): NeoWork {
    const now = Date.now();
    const result = this.db
      .prepare(`INSERT INTO neo_work
        (id, request_key, concern_id, origin_session_id, origin_message_id, target_session_id, title, instruction,
          session_id, status, report, follows, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'proposed', NULL, ?, ?, ?)
        ON CONFLICT(request_key) DO NOTHING`)
      .run(
        input.id,
        input.requestKey,
        input.projectId,
        input.originSessionId,
        input.originMessageId ?? null,
        input.targetSessionId ?? null,
        input.title,
        input.instruction,
        input.follows ?? null,
        now,
        now
      );
    if (result.changes > 0) this.notify();
    return this.db
      .prepare(`SELECT ${workColumns} FROM neo_work WHERE request_key = ?`)
      .get(input.requestKey) as NeoWork;
  }

  moveWork(
    ids: readonly string[],
    owner: { projectId: string; originSessionId: string; originMessageId: string }
  ): void {
    if (ids.length === 0) return;
    const moved = this.db
      .prepare(`UPDATE neo_work SET concern_id = ?, origin_session_id = ?, origin_message_id = ?
        WHERE id IN (SELECT value FROM json_each(?))`)
      .run(owner.projectId, owner.originSessionId, owner.originMessageId, JSON.stringify(ids));
    if (moved.changes > 0) this.notify();
  }

  transitionWork(
    id: string,
    expected: NeoWorkState,
    patch: Pick<NeoWorkState, 'status'> & Partial<Omit<NeoWorkState, 'status'>>
  ): NeoWork | null {
    const row = this.db
      .prepare(`UPDATE neo_work SET status = ?, session_id = ?, report = ?, updated_at = ?
        WHERE id = ? AND status = ? AND session_id IS ? AND report IS ?
        RETURNING ${workColumns}`)
      .get(
        patch.status,
        patch.sessionId === undefined ? expected.sessionId : patch.sessionId,
        patch.report === undefined ? expected.report : patch.report,
        Date.now(),
        id,
        expected.status,
        expected.sessionId,
        expected.report
      );
    if (row) this.notify();
    if (row && expected.status === 'queued' && patch.status !== 'queued')
      this.onSettled(row as NeoWork);
    return row as NeoWork | null;
  }
}
