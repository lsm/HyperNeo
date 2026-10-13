import type { NeoBinding, NeoProject, NeoWork } from '@hyperneo/shared/types/neo-context';
import type { Database } from '../sqlite-compat.ts';
import { CONSULTATION_TIMEOUT_MS } from '../../lib/neo/consultation-policy.ts';

const concernColumns = `id, title, summary, context, revision,
  created_at AS createdAt, updated_at AS updatedAt`;
const bindingColumns = 'session_id AS sessionId, concern_id AS projectId, kind';
const workColumns = `id, request_key AS requestKey, concern_id AS projectId,
  origin_session_id AS originSessionId, origin_message_id AS originMessageId,
  title, instruction, target_session_id AS targetSessionId, session_id AS sessionId,
  status, report, created_at AS createdAt, updated_at AS updatedAt`;

export type NeoProjectInput = Pick<NeoProject, 'id' | 'title' | 'summary' | 'context'>;
export type NeoWorkInput = Pick<
  NeoWork,
  'id' | 'requestKey' | 'projectId' | 'originSessionId' | 'title' | 'instruction'
> &
  Partial<Pick<NeoWork, 'originMessageId'>> & { targetSessionId?: string | null };
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
  constructor(
    private readonly db: Database,
    private readonly notify: () => void = () => {}
  ) {}

  listProjects(): NeoProject[] {
    return this.db
      .prepare(`SELECT ${concernColumns} FROM neo_concerns ORDER BY updated_at DESC, id`)
      .all() as NeoProject[];
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
          AND NOT EXISTS (SELECT 1 FROM neo_session_bindings WHERE concern_id = ?)`)
        .run(id, id).changes;
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
          session_id, status, report, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'proposed', NULL, ?, ?)
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
    return row as NeoWork | null;
  }
}
