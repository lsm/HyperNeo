import type { NeoConsultation } from '@hyperneo/shared/types/neo-context';
import type { Database } from '../sqlite-compat.ts';
const columns = `id, request_key AS requestKey, concern_id AS projectId,
  origin_session_id AS originSessionId, origin_message_id AS originMessageId,
  session_id AS sessionId, question, status,
  answer, created_at AS createdAt`;

export class NeoConsultationRepository {
  constructor(
    private readonly db: Database,
    private readonly notify: () => void
  ) {}

  get(id: string): NeoConsultation | null {
    return this.db
      .prepare(`SELECT ${columns} FROM neo_consultations WHERE id = ?`)
      .get(id) as NeoConsultation | null;
  }

  find(originSessionId: string, requestKey: string): NeoConsultation | null {
    return this.db
      .prepare(`SELECT ${columns} FROM neo_consultations
      WHERE origin_session_id = ? AND request_key = ?`)
      .get(originSessionId, requestKey) as NeoConsultation | null;
  }

  list(projectId?: string): NeoConsultation[] {
    return this.db
      .prepare(`SELECT ${columns} FROM neo_consultations
      ${projectId ? 'WHERE concern_id = ?' : ''}
      ORDER BY (status = 'pending') DESC, created_at DESC LIMIT 20`)
      .all(...(projectId ? [projectId] : [])) as NeoConsultation[];
  }

  startedBy(originSessionId: string, projectId: string): NeoConsultation[] {
    return this.db
      .prepare(`SELECT ${columns} FROM neo_consultations
      WHERE origin_session_id = ? AND concern_id = ? AND status = 'reported'
      ORDER BY created_at DESC`)
      .all(originSessionId, projectId) as NeoConsultation[];
  }

  unsettled(): NeoConsultation[] {
    return this.db
      .prepare(`SELECT ${columns} FROM neo_consultations
      WHERE status = 'pending' OR returned = 0`)
      .all() as NeoConsultation[];
  }

  reserve(
    input: Omit<NeoConsultation, 'status' | 'answer' | 'createdAt' | 'originMessageId'> & {
      originMessageId?: string | null;
    }
  ): NeoConsultation | null {
    const result = this.db
      .prepare(`INSERT INTO neo_consultations
      (id, request_key, concern_id, origin_session_id, origin_message_id,
      session_id, question, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?) ON CONFLICT DO NOTHING`)
      .run(
        input.id,
        input.requestKey,
        input.projectId,
        input.originSessionId,
        input.originMessageId ?? null,
        input.sessionId,
        input.question,
        Date.now()
      );
    if (result.changes) this.notify();
    return this.db
      .prepare(`SELECT ${columns} FROM neo_consultations
      WHERE origin_session_id = ? AND request_key = ?`)
      .get(input.originSessionId, input.requestKey) as NeoConsultation | null;
  }

  finish(id: string, status: 'reported' | 'failed', answer: string): NeoConsultation | null {
    const result = this.db
      .prepare(`UPDATE neo_consultations SET status = ?, answer = ?
      WHERE id = ? AND status = 'pending'`)
      .run(status, answer, id);
    if (result.changes) this.notify();
    return this.get(id);
  }

  returned(id: string): void {
    this.db
      .prepare("UPDATE neo_consultations SET returned = 1 WHERE id = ? AND status != 'pending'")
      .run(id);
  }

  returnsPublication(conversationId: string, publicationId: string): boolean {
    const owner = this.publicationOwner(conversationId, publicationId);
    return owner !== null && !this.isReturned(owner);
  }

  wasPublished(id: string): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM neo_consultation_publications WHERE consultation_id = ?')
      .get(id);
  }

  isReturned(id: string): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM neo_consultations WHERE id = ? AND returned = 1')
      .get(id);
  }

  private publicationOwner(conversationId: string, publicationId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT consultation_id AS consultationId FROM neo_consultation_publications
        WHERE conversation_id = ? AND publication_id = ?`
      )
      .get(conversationId, publicationId) as { consultationId: string } | null;
    return row?.consultationId ?? null;
  }
}
