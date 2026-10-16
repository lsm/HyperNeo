import type {
  NeoPublicationAppendResult,
  NeoPublicationInput,
} from '@hyperneo/shared/types/neo-publication';
import type { Database } from '../sqlite-compat.ts';
import type { NeoAskOrigin } from '../../lib/neo/ask-origin.ts';
import type { NeoConsultationWaiterRepository } from './neo-consultation-waiter-repository.ts';

export interface NeoCrossProjectPart {
  projectId: string;
  quote: string;
  question: string;
}
export interface NeoCrossProjectGroup {
  id: string;
  rootSessionId: string;
  originMessageId: string;
  askSessionId: string;
  askMessageId: string;
  partsJson: string;
  publicationId: string | null;
}
export interface NeoCrossProjectMember {
  id: string;
  projectId: string;
  status: string;
  answer: string | null;
}
const columns = `id, root_session_id AS rootSessionId, origin_message_id AS originMessageId,
  ask_session_id AS askSessionId, ask_message_id AS askMessageId, parts_json AS partsJson, publication_id AS publicationId`;

export function neoCrossProjectReplyId(group: Pick<NeoCrossProjectGroup, 'id'>): string {
  return `neo-cross-project:${group.id}:reply`;
}

export class NeoCrossProjectRepository {
  constructor(private readonly db: Database) {}

  forAsk(ask: NeoAskOrigin): NeoCrossProjectGroup | null {
    return this.db
      .prepare(
        `SELECT ${columns} FROM neo_cross_project_dispatches WHERE ask_session_id = ? AND ask_message_id = ?`
      )
      .get(ask.sessionId, ask.messageId) as NeoCrossProjectGroup | null;
  }

  forReceipt(id: string): NeoCrossProjectGroup | null {
    const row = this.db
      .prepare('SELECT group_id FROM neo_cross_project_dispatch_members WHERE receipt_id = ?')
      .get(id) as { group_id: string } | null;
    return row
      ? (this.db
          .prepare(`SELECT ${columns} FROM neo_cross_project_dispatches WHERE id = ?`)
          .get(row.group_id) as NeoCrossProjectGroup)
      : null;
  }

  pending(): NeoCrossProjectGroup[] {
    return this.db
      .prepare(`SELECT ${columns} FROM neo_cross_project_dispatches WHERE publication_id IS NULL`)
      .all() as NeoCrossProjectGroup[];
  }

  members(group: NeoCrossProjectGroup): NeoCrossProjectMember[] {
    return this.db
      .prepare(`SELECT m.receipt_id AS id, m.project_id AS projectId,
      COALESCE(c.status, w.status) AS status, c.answer FROM neo_cross_project_dispatch_members m
      JOIN neo_consultation_waiters w ON w.id = m.receipt_id
      LEFT JOIN neo_consultations c ON c.id = m.receipt_id WHERE m.group_id = ? ORDER BY m.project_id`)
      .all(group.id) as NeoCrossProjectMember[];
  }

  bind(
    rootSessionId: string,
    originMessageId: string,
    ask: NeoAskOrigin,
    parts: readonly NeoCrossProjectPart[],
    sessions: ReadonlyMap<string, string>,
    waiters: NeoConsultationWaiterRepository
  ): { value: NeoCrossProjectGroup } | { reason: string } {
    return this.db.transaction(() => {
      const partsJson = JSON.stringify(
        [...parts].sort((a, b) => a.projectId.localeCompare(b.projectId))
      );
      const existing = this.forAsk(ask);
      if (existing)
        return existing.rootSessionId === rootSessionId && existing.partsJson === partsJson
          ? { value: existing }
          : { reason: 'cross_project_conflict' };
      const id = crypto.randomUUID();
      this.db
        .prepare(
          `INSERT INTO neo_cross_project_dispatches (id, root_session_id, origin_message_id, ask_session_id, ask_message_id, parts_json) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(id, rootSessionId, originMessageId, ask.sessionId, ask.messageId, partsJson);
      for (const part of parts) {
        const receiptId = crypto.randomUUID();
        const waiter = waiters.enqueue({
          id: receiptId,
          requestKey: `cross:${id}:${part.projectId}`,
          projectId: part.projectId,
          originSessionId: rootSessionId,
          originMessageId,
          sessionId: sessions.get(part.projectId)!,
          question: `${part.question}\n\nHuman's words:\n${part.quote}`,
        });
        if (waiter?.id !== receiptId) throw new Error('Cross-project receipt conflict');
        this.db
          .prepare(
            'INSERT INTO neo_cross_project_dispatch_members (group_id, receipt_id, project_id) VALUES (?, ?, ?)'
          )
          .run(id, receiptId, part.projectId);
      }
      return { value: this.forAsk(ask)! };
    })();
  }

  ready(group: NeoCrossProjectGroup): boolean {
    const members = this.members(group);
    return (
      members.length === (JSON.parse(group.partsJson) as NeoCrossProjectPart[]).length &&
      members.every((member) => ['reported', 'failed', 'cancelled'].includes(member.status))
    );
  }

  publicationProblem(input: NeoPublicationInput): string | null {
    const group = this.forAsk(input.askOrigin);
    if (!group) return null;
    if (input.producerInput.sessionId !== group.rootSessionId) return 'cross_project_root_only';
    return null;
  }

  append(
    input: NeoPublicationInput,
    publish: () => NeoPublicationAppendResult
  ): NeoPublicationAppendResult {
    return this.db.transaction(() => {
      const problem = this.publicationProblem(input);
      if (problem) return { accepted: false as const, reason: 'invalid_publication' as const };
      const receipt = publish();
      const group = this.forAsk(input.askOrigin);
      if (
        receipt.accepted &&
        receipt.created &&
        group &&
        input.producerInput.messageId === neoCrossProjectReplyId(group)
      )
        this.db
          .prepare(
            'UPDATE neo_cross_project_dispatches SET publication_id = ? WHERE ask_session_id = ? AND ask_message_id = ?'
          )
          .run(
            receipt.publication.publicationId,
            input.askOrigin.sessionId,
            input.askOrigin.messageId
          );
      return receipt;
    })();
  }
}
