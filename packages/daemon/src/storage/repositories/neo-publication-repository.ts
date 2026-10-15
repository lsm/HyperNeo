import type { NeoInputOrigin } from '@hyperneo/shared/types/neo-message';
import type { NeoAsk } from '@hyperneo/shared/types/neo-snapshot';
import type {
  NeoPublication,
  NeoPublicationAppendResult,
  NeoPublicationChangeResult,
  NeoPublicationInput,
} from '@hyperneo/shared/types/neo-publication';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { admitNeoPublication } from '../../lib/neo/publication.ts';
import type { Database } from '../sqlite-compat.ts';
import { NeoRoutingLogRepository } from './neo-routing-log-repository.ts';

type Row = { sequence: number; payloadJson: string; createdAt: string };
const columns = 'sequence, payload_json AS payloadJson, created_at AS createdAt';
const page = z.object({
  conversationId: z.string().uuid(),
  after: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  limit: z.number().int().min(1).max(100),
  before: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
});

function decode(row: Row): NeoPublication {
  const parsed = admitNeoPublication(JSON.parse(row.payloadJson));
  if ('reason' in parsed) throw new Error('Invalid stored Neo publication');
  return { ...parsed.value, sequence: row.sequence, createdAt: row.createdAt };
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

const sameAnswer = (a: NeoPublicationInput, b: NeoPublicationInput) =>
  a.shortText === b.shortText &&
  a.fullText === b.fullText &&
  a.awaiting === b.awaiting &&
  JSON.stringify(a.links) === JSON.stringify(b.links);

export function findNeoRepeatedPublication(
  priors: readonly NeoPublication[],
  input: NeoPublicationInput
): NeoPublication | null {
  return priors.find((prior) => sameAnswer(prior, input)) ?? null;
}

function repeatOnTrigger(db: Database, input: NeoPublicationInput): NeoPublication | null {
  if (!input.triggerId) return null;
  const rows = db
    .prepare(`SELECT ${columns} FROM neo_publications WHERE conversation_id = ?
      AND json_extract(payload_json, '$.triggerId') = ? AND publication_id <> ?
      ORDER BY sequence`)
    .all(input.conversationId, input.triggerId, input.publicationId) as Row[];
  return findNeoRepeatedPublication(rows.map(decode), input);
}

function appendImmutable(
  db: Database,
  input: NeoPublicationInput,
  payload: string
): NeoPublicationAppendResult {
  return db.transaction((): NeoPublicationAppendResult => {
    const repeat = repeatOnTrigger(db, input);
    if (repeat) return { accepted: true, created: false, publication: repeat };
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
    return row.payloadJson === payload
      ? { accepted: true, created: !!inserted, publication: decode(row) }
      : { accepted: false, reason: 'publication_conflict' };
  })();
}

const append = (superpipe({})('neo-publication-append') as PipelineAPI)
  .input(['input', 'db'])
  .pipe(admitNeoPublication, 'input', 'result:append')
  .pipe(JSON.stringify, 'append', 'payload')
  .pipe(appendImmutable, ['db', 'append', 'payload'], 'append')
  .end('append') as (
  input: unknown,
  db: Database
) => NeoPublicationAppendResult | 'invalid_publication';

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

  append(input: unknown): NeoPublicationAppendResult {
    const result = append(input, this.db);
    if (result === 'invalid_publication') return { accepted: false, reason: result };
    if (result.accepted && !result.publication.interim) this.recordReplyOutcome(result.publication);
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

  edit(
    conversationId: string,
    publicationId: string,
    text: { shortText?: string; fullText?: string },
    at: string,
    by: string,
    input?: NeoInputOrigin
  ): NeoPublicationChangeResult {
    const current = this.get(conversationId, publicationId);
    if (!current) return { accepted: false, reason: 'not_found' };
    const { sequence: _sequence, createdAt: _createdAt, awaiting: _awaiting, ...stored } = current;
    const next = admitNeoPublication({
      ...stored,
      ...text,
      editedAt: at,
      editedBy: by,
      ...(input ? { answerInput: input } : {}),
    });
    if ('reason' in next) return { accepted: false, reason: 'publication_conflict' };
    this.db
      .prepare(
        'UPDATE neo_publications SET payload_json = ? WHERE conversation_id = ? AND publication_id = ?'
      )
      .run(JSON.stringify(next.value), conversationId, publicationId);
    return {
      accepted: true,
      created: false,
      publication: this.get(conversationId, publicationId)!,
    };
  }

  correct(original: NeoPublication, correction: NeoPublicationInput): NeoPublicationChangeResult {
    return this.db.transaction((): NeoPublicationChangeResult => {
      const current = this.get(original.conversationId, original.publicationId);
      if (!current) return { accepted: false, reason: 'not_found' };
      if (current.correctedBy === correction.publicationId) {
        const existing = this.get(current.conversationId, correction.publicationId);
        return existing
          ? { accepted: true, created: false, publication: existing }
          : { accepted: false, reason: 'publication_conflict' };
      }
      if (current.correctedBy || current.corrects)
        return { accepted: false, reason: 'already_corrected' };
      const admitted = admitNeoPublication({ ...correction, corrects: current.publicationId });
      if ('reason' in admitted) return { accepted: false, reason: 'publication_conflict' };
      const appended = appendImmutable(this.db, admitted.value, JSON.stringify(admitted.value));
      if (!appended.accepted || !appended.created)
        return { accepted: false, reason: 'publication_conflict' };
      const { sequence: _sequence, createdAt: _createdAt, ...stored } = current;
      this.db
        .prepare(
          'UPDATE neo_publications SET payload_json = ? WHERE conversation_id = ? AND publication_id = ?'
        )
        .run(
          JSON.stringify({ ...stored, correctedBy: correction.publicationId }),
          current.conversationId,
          current.publicationId
        );
      if (appended.publication.triggerId) this.recordReplyOutcome(appended.publication);
      return appended;
    })();
  }

  private recordReplyOutcome(publication: NeoPublication): void {
    const { askOrigin, shortText, askSummary, awaiting } = publication;
    new NeoRoutingLogRepository(this.db).recordOutcome(
      askOrigin.messageId,
      shortText,
      Date.now(),
      { askSummary, awaiting },
      !!publication.answerInput
    );
  }

  repeatOf(input: NeoPublicationInput): NeoPublication | null {
    return repeatOnTrigger(this.db, input);
  }

  toldForAsk(
    conversationId: string,
    ask: Pick<NeoAsk, 'id' | 'originSessionId' | 'originMessageId'>
  ): NeoPublication[] {
    return (
      this.db
        .prepare(
          `SELECT ${columns} FROM neo_publications WHERE conversation_id = ?
            AND json_extract(payload_json, '$.interim') IS NULL
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
        AND json_extract(payload_json, '$.askOrigin.sessionId') = ?
        AND json_extract(payload_json, '$.askOrigin.messageId') = ?
        AND created_at >= ? LIMIT 1`)
      .get(conversationId, askOrigin.sessionId, askOrigin.messageId, since);
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
            AND json_extract(payload_json, '$.interim') IS NULL
          ORDER BY sequence DESC LIMIT ?`
        )
        .all(conversationId, limit) as Row[]
    ).map(decode);
  }

  findByProducer(sessionId: string, messageId: string): NeoPublication | null {
    const row = this.db
      .prepare(
        `SELECT ${columns} FROM neo_publications
        WHERE json_extract(payload_json, '$.producerInput.sessionId') = ?
          AND json_extract(payload_json, '$.producerInput.messageId') = ?
          AND json_extract(payload_json, '$.interim') IS NULL
          AND (json_extract(payload_json, '$.corrects') IS NULL
            OR json_extract(payload_json, '$.triggerId') IS NOT NULL)
          ORDER BY sequence LIMIT 1`
      )
      .get(sessionId, messageId) as Row | null;
    return row ? decode(row) : null;
  }
}
