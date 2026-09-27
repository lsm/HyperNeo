import type { NeoConsultation } from '@hyperneo/shared/types/neo-context';
import type { Database } from '../sqlite-compat.ts';
import {
  CONSULTATION_EXPIRED,
  CONSULTATION_TIMEOUT_MS,
} from '../../lib/neo/consultation-policy.ts';

const columns = `id, request_key AS requestKey, concern_id AS concernId,
  origin_session_id AS originSessionId, session_id AS sessionId, question, status,
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

  list(concernId?: string): NeoConsultation[] {
    return this.db
      .prepare(`SELECT ${columns} FROM neo_consultations
      ${concernId ? 'WHERE concern_id = ?' : ''}
      ORDER BY (status = 'pending') DESC, created_at DESC LIMIT 20`)
      .all(...(concernId ? [concernId] : [])) as NeoConsultation[];
  }

  unsettled(): NeoConsultation[] {
    return this.db
      .prepare(`SELECT ${columns} FROM neo_consultations
      WHERE status = 'pending' OR returned = 0`)
      .all() as NeoConsultation[];
  }

  reserve(input: Omit<NeoConsultation, 'status' | 'answer' | 'createdAt'>): NeoConsultation | null {
    const result = this.db
      .prepare(`INSERT INTO neo_consultations
      (id, request_key, concern_id, origin_session_id, session_id, question, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?) ON CONFLICT DO NOTHING`)
      .run(
        input.id,
        input.requestKey,
        input.concernId,
        input.originSessionId,
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
    if (status === 'reported') this.expire(id);
    const result = this.db
      .prepare(`UPDATE neo_consultations SET status = ?, answer = ?
      WHERE id = ? AND status = 'pending'`)
      .run(status, answer, id);
    if (result.changes) this.notify();
    return this.get(id);
  }

  expire(id: string): NeoConsultation | null {
    const result = this.db
      .prepare(`UPDATE neo_consultations SET status = 'failed', answer = ?
      WHERE id = ? AND status = 'pending' AND created_at <= ?`)
      .run(CONSULTATION_EXPIRED, id, Date.now() - CONSULTATION_TIMEOUT_MS);
    if (result.changes) this.notify();
    return this.get(id);
  }

  returned(id: string): void {
    this.db
      .prepare("UPDATE neo_consultations SET returned = 1 WHERE id = ? AND status != 'pending'")
      .run(id);
  }
}
