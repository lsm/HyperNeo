import { NeoFrontInputRepository } from './neo-front-input-worker.ts';
import { SettingsRepository } from './settings-repository.ts';
import { publicationSpeaker, frontSessionId } from '../../lib/neo/front-mode.ts';
import { neoPublicationPageWrites } from './neo-publication-page-db.ts';
import type { readNeoPublicationPage } from '../../lib/neo/publication-read-operation.ts';
import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { NeoInputOrigin } from '@hyperneo/shared/types/neo-message';
import type { NeoAsk } from '@hyperneo/shared/types/neo-snapshot';
import type {
  NeoPublication,
  NeoPublicationAppendResult,
  NeoPublicationInput,
} from '@hyperneo/shared/types/neo-publication';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { admitNeoPublication, workerSession } from '../../lib/neo/publication.ts';
import type { Database } from '../sqlite-compat.ts';
import type { OperationCaller } from '../../lib/operations/registry.ts';
import { gatewayFor } from '../db-gateway/db-gateway.ts';

export type NeoPublicationWriteResult = NeoPublicationAppendResult & { versionCreated?: true };

type Row = { sequence: number; payloadJson: string; createdAt: string };
const columns = 'sequence, payload_json AS payloadJson, created_at AS createdAt';
const page = z.object({
  conversationId: z.string().uuid(),
  after: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  limit: z.number().int().min(1).max(100),
  before: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
});

function decode(row: Row): NeoPublication {
  const {
    interim: _interim,
    corrects: _corrects,
    correctedBy: _correctedBy,
    ...message
  } = JSON.parse(row.payloadJson);
  const parsed = admitNeoPublication(message);
  if ('reason' in parsed) throw new Error('Invalid stored Neo publication');
  return {
    ...parsed.value,
    session: workerSession(parsed.value.session),
    sequence: row.sequence,
    createdAt: row.createdAt,
  };
}

function withoutNeoSession(payloadJson: string): string {
  const { session, ...stored } = JSON.parse(payloadJson) as NeoPublicationInput;
  return workerSession(session) ? payloadJson : JSON.stringify(stored);
}

function hasTrigger(
  db: Database,
  conversationId: string,
  triggerId: string,
  publicationId: string
): boolean {
  return !!db
    .prepare(`SELECT 1 FROM neo_publications WHERE conversation_id = ?
      AND json_extract(payload_json, '$.triggerId') = ? AND publication_id <> ? LIMIT 1`)
    .get(conversationId, triggerId, publicationId);
}

function appendImmutable(
  db: Database,
  input: NeoPublicationInput,
  payload: string,
  speaker?: string
): NeoPublicationWriteResult {
  return db.transaction((): NeoPublicationWriteResult => {
    if (
      speaker &&
      speaker !==
        publicationSpeaker(
          input.conversationId,
          new SettingsRepository(db).getGlobalSettings().neo?.front?.enabled === true
        )
    )
      return { accepted: false, reason: 'publication_superseded' };
    if (input.cardReply) {
      const target = db
        .prepare('SELECT ask_id FROM neo_questions WHERE id = ?')
        .get(input.cardReply.questionId) as { ask_id: string } | null;
      if (target?.ask_id !== input.cardReply.askId)
        return { accepted: false, reason: 'invalid_publication' };
      const prior = db
        .prepare(`SELECT ${columns} FROM neo_publications WHERE conversation_id = ?
        AND (json_extract(payload_json, '$.cardReply.mutationId') = ? OR
          (json_extract(payload_json, '$.cardReply.askId') = ? AND
           json_extract(payload_json, '$.cardReply.sourceMessageIds') = ?)) ORDER BY sequence LIMIT 1`)
        .get(
          input.conversationId,
          input.cardReply.mutationId,
          input.cardReply.askId,
          JSON.stringify(input.cardReply.sourceMessageIds)
        ) as Row | null;
      if (prior) {
        const current = decode(prior);
        if (
          current.cardReply?.askId !== input.cardReply.askId ||
          JSON.stringify(current.cardReply.sourceMessageIds) !==
            JSON.stringify(input.cardReply.sourceMessageIds)
        )
          return { accepted: false, reason: 'publication_conflict' };
        if (
          input.publicationId === (current.revisionId ?? current.publicationId) ||
          current.revisions?.some(
            (revision) =>
              revision.revisionId === input.publicationId ||
              (input.cardReply!.mutationId !== current.cardReply!.mutationId &&
                revision.revisionId === input.cardReply!.mutationId)
          )
        )
          return { accepted: true, created: false, publication: current };
        if (
          input.artifacts &&
          current.artifacts?.some(
            (item) =>
              'type' in item &&
              !input.artifacts!.some((next) => JSON.stringify(next) === JSON.stringify(item))
          )
        )
          return { accepted: false, reason: 'publication_conflict' };
        const revisions = [...(current.revisions ?? [])];
        for (const revisionId of new Set([
          current.revisionId ?? current.publicationId,
          current.cardReply.mutationId,
        ])) {
          if (revisions.some((revision) => revision.revisionId === revisionId)) continue;
          revisions.push({
            revisionId,
            shortText: current.shortText,
            fullText: current.fullText,
            session: current.session,
            createdAt: current.editedAt ?? current.createdAt,
            producerInput: current.answerInput ?? current.producerInput,
            askOrigin: current.answerOrigin ?? current.askOrigin,
            awaiting: current.awaiting,
          });
        }
        const next = {
          ...(JSON.parse(prior.payloadJson) as NeoPublicationInput),
          shortText: input.shortText,
          fullText: input.fullText,
          artifacts: input.artifacts ?? current.artifacts,
          links: input.links,
          session: input.session,
          cardReply: input.cardReply,
          revisionId: input.publicationId,
          revisions,
        };
        db.prepare('UPDATE neo_publications SET payload_json = ? WHERE sequence = ?').run(
          JSON.stringify(next),
          current.sequence
        );
        return {
          accepted: true,
          created: false,
          versionCreated: true,
          publication: { ...next, sequence: current.sequence, createdAt: current.createdAt },
        };
      }
    }
    const inputs = new NeoFrontInputRepository(db);
    const ids = [
      ...new Set([...(input.replyTo ?? []), ...(input.cardReply?.sourceMessageIds ?? [])]),
    ].filter((id) => inputs.get(input.conversationId, id)?.eligible);
    if (
      ids.length &&
      !new NeoPublicationRepository(db).get(input.conversationId, input.publicationId)
    ) {
      if (
        !inputs.claim(
          input.conversationId,
          ids,
          speaker === frontSessionId(input.conversationId) ? 'front' : 'neo'
        )
      )
        return { accepted: false, reason: 'publication_superseded' };
    }
    const inserted = db
      .prepare(`INSERT INTO neo_publications(conversation_id, publication_id, payload_json, created_at)
        VALUES (?, ?, ?, ?) ON CONFLICT(conversation_id, publication_id) DO NOTHING
        RETURNING ${columns}`)
      .get(
        input.conversationId,
        input.publicationId,
        payload,
        new Date().toISOString()
      ) as Row | null;
    const row =
      inserted ??
      (db
        .prepare(
          `SELECT ${columns} FROM neo_publications WHERE conversation_id = ? AND publication_id = ?`
        )
        .get(input.conversationId, input.publicationId) as Row | null);
    if (!row) throw new Error('Neo publication append lost its reservation');
    const current = decode(row);
    const first = current.revisions?.[0];
    const {
      sequence: _sequence,
      createdAt: _createdAt,
      revisionId: _revisionId,
      revisions: _revisions,
      editedAt: _editedAt,
      editedBy: _editedBy,
      answerInput: _answerInput,
      answerOrigin: _answerOrigin,
      ...original
    } = current;
    const initial = first
      ? {
          ...original,
          shortText: first.shortText,
          fullText: first.fullText,
          session: workerSession(first.session),
          awaiting: first.awaiting,
        }
      : null;
    return withoutNeoSession(row.payloadJson) === payload ||
      (initial && JSON.stringify(admitNeoPublication(initial)) === JSON.stringify({ value: input }))
      ? { accepted: true, created: !!inserted, publication: decode(row) }
      : { accepted: false, reason: 'publication_conflict' };
  })();
}

const append = (superpipe({})('neo-publication-append') as PipelineAPI)
  .input(['input', 'db', 'speaker'])
  .pipe(admitNeoPublication, 'input', 'result:append')
  .pipe(
    (input: NeoPublicationInput) =>
      input.cardReply
        ? {
            ...input,
            replyTo: undefined,
            cardReply: {
              ...input.cardReply,
              sourceMessageIds: [...new Set(input.cardReply.sourceMessageIds)].sort(),
            },
          }
        : input,
    'append',
    'append'
  )
  .pipe(JSON.stringify, 'append', 'payload')
  .pipe(appendImmutable, ['db', 'append', 'payload', 'speaker'], 'append')
  .end('append') as (
  input: unknown,
  db: Database,
  speaker?: string
) => NeoPublicationWriteResult | 'invalid_publication';

const readPage = (superpipe({})('neo-publication-page') as PipelineAPI)
  .input(['input', 'db'])
  .pipe(
    (input: unknown) => {
      const parsed = page.safeParse(input);
      return parsed.success ? { value: parsed.data } : { reason: null };
    },
    'input',
    'result:publications'
  )
  .pipe(
    (db: Database, input: z.infer<typeof page>) =>
      (
        db
          .prepare(
            input.before === undefined
              ? `SELECT ${columns} FROM neo_publications
        WHERE conversation_id = ? AND sequence > ? ORDER BY sequence LIMIT ?`
              : `SELECT * FROM (SELECT ${columns} FROM neo_publications
        WHERE conversation_id = ? AND sequence < ? ORDER BY sequence DESC LIMIT ?) ORDER BY sequence`
          )
          .all(input.conversationId, input.before ?? input.after, input.limit) as Row[]
      ).map(decode),
    ['db', 'publications'],
    'publications'
  )
  .end('publications') as (input: unknown, db: Database) => NeoPublication[] | null;

export class NeoPublicationRepository {
  constructor(private readonly db: Database) {}

  readPageCurrent(page: Parameters<typeof readNeoPublicationPage>[0], caller: OperationCaller) {
    return gatewayFor(this.db).call(neoPublicationPageWrites, 'read', page, {
      source: caller.source,
      principal: caller.principal,
      role: caller.role,
      sessionId: caller.sessionId,
    });
  }

  append(input: unknown, speaker?: string): NeoPublicationWriteResult {
    const result = append(input, this.db, speaker);
    if (result === 'invalid_publication') return { accepted: false, reason: result };
    return result;
  }

  get(conversationId: string, publicationId: string): NeoPublication | null {
    const row = this.db
      .prepare(
        `SELECT ${columns} FROM neo_publications WHERE conversation_id = ? AND publication_id = ?`
      )
      .get(conversationId, publicationId) as Row | null;
    return row ? decode(row) : null;
  }

  toldForAsk(
    conversationId: string,
    ask: Pick<NeoAsk, 'id' | 'originSessionId' | 'originMessageId'>
  ): NeoPublication[] {
    return (
      this.db
        .prepare(
          `SELECT ${columns} FROM neo_publications WHERE conversation_id = ?
            AND (json_extract(payload_json, '$.triggerId') LIKE ?
              OR (json_extract(payload_json, '$.askOrigin.sessionId') = ?
                AND json_extract(payload_json, '$.askOrigin.messageId') = ?))
          ORDER BY sequence`
        )
        .all(
          conversationId,
          `%:${ask.id}:%`,
          ask.originSessionId,
          ask.originMessageId ?? ''
        ) as Row[]
    ).map(decode);
  }

  byTrigger(conversationId: string, triggerId: string): NeoPublication | null {
    const row = this.db
      .prepare(`SELECT ${columns} FROM neo_publications WHERE conversation_id = ?
        AND json_extract(payload_json, '$.triggerId') = ? ORDER BY sequence LIMIT 1`)
      .get(conversationId, triggerId) as Row | null;
    return row ? decode(row) : null;
  }

  toldSince(conversationId: string, askOrigin: NeoInputOrigin, since: string): boolean {
    return !!this.db
      .prepare(`SELECT 1 FROM neo_publications WHERE conversation_id = ?
        AND ((json_extract(payload_json, '$.askOrigin.sessionId') = ?
          AND json_extract(payload_json, '$.askOrigin.messageId') = ?)
          OR (? = 'neo:' || conversation_id AND EXISTS (
            SELECT 1 FROM json_each(payload_json, '$.replyTo') WHERE value = ?)))
        AND created_at >= ? LIMIT 1`)
      .get(
        conversationId,
        askOrigin.sessionId,
        askOrigin.messageId,
        askOrigin.sessionId,
        askOrigin.messageId,
        since
      );
  }

  hasTrigger(conversationId: string, triggerId: string, publicationId: string): boolean {
    return hasTrigger(this.db, conversationId, triggerId, publicationId);
  }

  list(conversationId: string, after = 0, limit = 50, before?: number): NeoPublication[] | null {
    return readPage({ conversationId, after, limit, before }, this.db);
  }

  listRecent(conversationId: string, limit: number): NeoPublication[] {
    return (
      this.db
        .prepare(
          `SELECT ${columns} FROM neo_publications WHERE conversation_id = ?
          ORDER BY sequence DESC LIMIT ?`
        )
        .all(conversationId, limit) as Row[]
    ).map(decode);
  }
}

export const neoPublicationWrites = defineRepositoryOp(
  'neo.publications.write',
  'write',
  NeoPublicationRepository,
  ['append']
);
