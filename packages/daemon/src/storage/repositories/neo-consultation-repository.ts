import type { NeoConsultation } from '@hyperneo/shared/types/neo-context';
import type { NeoPublicationInput } from '@hyperneo/shared/types/neo-publication';
import type { Database } from '../sqlite-compat.ts';
import { NeoPublicationRepository } from './neo-publication-repository.ts';
import { admitNeoPublication } from '../../lib/neo/publication.ts';
import {
  CONSULTATION_EXPIRED,
  CONSULTATION_TIMEOUT_MS,
} from '../../lib/neo/consultation-policy.ts';

const columns = `id, request_key AS requestKey, concern_id AS concernId,
  origin_session_id AS originSessionId, origin_message_id AS originMessageId,
  session_id AS sessionId, question, status,
  answer, created_at AS createdAt`;
const associationColumns =
  'consultation_id AS consultationId, conversation_id AS conversationId, publication_id AS publicationId, answer, created_at AS createdAt';

export type NeoConsultationPublication = Pick<
  NeoConsultationPublicationRow,
  'consultationId' | 'conversationId' | 'publicationId' | 'answer' | 'createdAt'
>;
type NeoConsultationPublicationRow = {
  consultationId: string;
  conversationId: string;
  publicationId: string;
  answer: string;
  createdAt: string;
};
export type NeoConsultationPublicationSettlement =
  | { accepted: true; created: boolean; association: NeoConsultationPublication }
  | { accepted: false; reason: NeoConsultationPublicationRejection };
export type NeoConsultationPublicationRejection =
  | 'unknown_consultation'
  | 'consultation_settled'
  | 'consultation_expired'
  | 'publication_conflict'
  | 'invalid_publication';
export type NeoConsultationPublicationInput = {
  consultationId: string;
  answer: string;
  publication: NeoPublicationInput;
};

class NeoSettlementRefusal extends Error {
  constructor(readonly reason: NeoConsultationPublicationRejection) {
    super(`Consultation publication refused: ${reason}`);
  }
}

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
        input.concernId,
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

  getPublication(consultationId: string): NeoConsultationPublication | null {
    const row = this.db
      .prepare(
        `SELECT ${associationColumns} FROM neo_consultation_publications WHERE consultation_id = ?`
      )
      .get(consultationId) as NeoConsultationPublicationRow | null;
    return row ?? null;
  }

  private storedAssociationPayload(consultationId: string): string | null {
    const row = this.db
      .prepare(
        'SELECT payload_json AS payloadJson FROM neo_consultation_publications WHERE consultation_id = ?'
      )
      .get(consultationId) as { payloadJson: string } | null;
    return row?.payloadJson ?? null;
  }

  private insertAssociation(
    input: NeoConsultationPublicationInput,
    payload: string,
    createdAt: string
  ): void {
    this.db
      .prepare(
        `INSERT INTO neo_consultation_publications
        (consultation_id, conversation_id, publication_id, answer, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.consultationId,
        input.publication.conversationId,
        input.publication.publicationId,
        input.answer,
        payload,
        createdAt
      );
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

  settleWithPublication(
    input: NeoConsultationPublicationInput
  ): NeoConsultationPublicationSettlement {
    const active =
      'inTransaction' in this.db ? Boolean(this.db.inTransaction) : this.db.isTransaction;
    if (active) throw new Error('Consultation publication settlement must own its commit boundary');
    const publications = new NeoPublicationRepository(this.db);
    let committed: NeoConsultationPublicationSettlement;
    try {
      committed = this.db.transaction((): NeoConsultationPublicationSettlement => {
        const admitted = admitNeoPublication(input.publication);
        if ('reason' in admitted) return { accepted: false, reason: admitted.reason };
        const item = this.get(input.consultationId);
        const existing = this.getPublication(input.consultationId);
        if (!item) return { accepted: false, reason: 'unknown_consultation' };
        const canonical = JSON.stringify(admitted.value);
        if (existing) {
          if (
            this.storedAssociationPayload(input.consultationId) !== canonical ||
            existing.answer !== input.answer
          )
            return { accepted: false, reason: 'publication_conflict' };
          return { accepted: true, created: false, association: existing };
        }
        if (item.status !== 'pending') return { accepted: false, reason: 'consultation_settled' };
        if (item.createdAt + CONSULTATION_TIMEOUT_MS <= Date.now())
          return { accepted: false, reason: 'consultation_expired' };
        const appended = publications.append(admitted.value);
        if (!appended.accepted) return { accepted: false, reason: appended.reason };
        const owner = this.publicationOwner(
          admitted.value.conversationId,
          admitted.value.publicationId
        );
        if (owner !== null && owner !== input.consultationId)
          throw new NeoSettlementRefusal('publication_conflict');
        const settled = this.db
          .prepare(
            `UPDATE neo_consultations SET status = 'reported', answer = ?
          WHERE id = ? AND status = 'pending'`
          )
          .run(input.answer, input.consultationId);
        if (!settled.changes) throw new NeoSettlementRefusal('consultation_settled');
        this.insertAssociation(input, canonical, appended.publication.createdAt);
        return {
          accepted: true,
          created: appended.created,
          association: {
            consultationId: input.consultationId,
            conversationId: admitted.value.conversationId,
            publicationId: admitted.value.publicationId,
            answer: input.answer,
            createdAt: appended.publication.createdAt,
          },
        };
      })();
    } catch (error) {
      if (error instanceof NeoSettlementRefusal) return { accepted: false, reason: error.reason };
      throw error;
    }
    if (committed.accepted) this.notifyCommitted();
    return committed;
  }

  private notifyCommitted(): void {
    try {
      this.notify();
    } catch {}
  }
}
