import type { NeoBinding, NeoConcern, NeoWork } from '@hyperneo/shared/types/neo-context';
import type { Database } from '../sqlite-compat.ts';
import { CONSULTATION_TIMEOUT_MS } from '../../lib/neo/consultation-policy.ts';

const concernColumns = `id, title, summary, context, revision,
  created_at AS createdAt, updated_at AS updatedAt`;
const bindingColumns = 'session_id AS sessionId, concern_id AS concernId, kind';
const workColumns = `id, request_key AS requestKey, concern_id AS concernId,
  origin_session_id AS originSessionId, origin_message_id AS originMessageId,
  title, instruction, target_session_id AS targetSessionId, session_id AS sessionId,
  status, report, created_at AS createdAt, updated_at AS updatedAt`;

export type NeoConcernInput = Pick<NeoConcern, 'id' | 'title' | 'summary' | 'context'>;
export type NeoWorkInput = Pick<
  NeoWork,
  'id' | 'requestKey' | 'concernId' | 'originSessionId' | 'title' | 'instruction'
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

  listConcerns(): NeoConcern[] {
    return this.db
      .prepare(`SELECT ${concernColumns} FROM neo_concerns ORDER BY updated_at DESC, id`)
      .all() as NeoConcern[];
  }

  getConcern(id: string): NeoConcern | null {
    return this.db
      .prepare(`SELECT ${concernColumns} FROM neo_concerns WHERE id = ?`)
      .get(id) as NeoConcern | null;
  }

  saveConcern(input: NeoConcernInput, expectedRevision: number): NeoConcern | null {
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
    return row as NeoConcern | null;
  }

  reserveBinding(binding: NeoBinding): boolean {
    const result = this.db
      .prepare(`INSERT INTO neo_session_bindings (session_id, concern_id, kind)
        VALUES (?, ?, ?) ON CONFLICT DO NOTHING`)
      .run(binding.sessionId, binding.concernId, binding.kind);
    if (result.changes > 0) this.notify();
    return result.changes > 0;
  }

  saveConsultationContext(
    input: NeoConcernInput,
    expectedRevision: number,
    consultationId: string,
    holderSessionId: string
  ): NeoConcern | null {
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
              AND b.kind = 'concern' AND b.concern_id = c.concern_id
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
        ) as NeoConcern | null;
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

  getBindingForConcern(concernId: string | null): NeoBinding | null {
    return this.db
      .prepare(`SELECT ${bindingColumns} FROM neo_session_bindings
        WHERE concern_id IS ? AND kind IN ('neo', 'concern')`)
      .get(concernId) as NeoBinding | null;
  }

  listWork(concernId?: string | null): NeoWork[] {
    const condition = concernId === undefined ? '' : 'WHERE concern_id IS ?';
    return this.db
      .prepare(`SELECT ${workColumns} FROM neo_work ${condition} ORDER BY created_at DESC, id`)
      .all(...(concernId === undefined ? [] : [concernId])) as NeoWork[];
  }

  getWork(id: string): NeoWork | null {
    return this.db
      .prepare(`SELECT ${workColumns} FROM neo_work WHERE id = ?`)
      .get(id) as NeoWork | null;
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
        input.concernId,
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
