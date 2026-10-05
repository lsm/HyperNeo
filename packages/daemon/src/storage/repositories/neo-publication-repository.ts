import type {
  NeoPublication,
  NeoPublicationAppendResult,
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

function appendImmutable(
  db: Database,
  input: NeoPublicationInput,
  payload: string
): NeoPublicationAppendResult {
  return db.transaction((): NeoPublicationAppendResult => {
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
    if (result.accepted && !result.publication.interim) {
      const { askOrigin, shortText } = result.publication;
      new NeoRoutingLogRepository(this.db).recordOutcome(
        askOrigin.messageId,
        shortText,
        Date.now()
      );
    }
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

  list(conversationId: string, after = 0, limit = 50, before?: number): NeoPublication[] | null {
    return readPage({ conversationId, after, limit, before }, this.db);
  }

  findByProducer(sessionId: string, messageId: string): NeoPublication | null {
    const rows = this.db
      .prepare(
        `SELECT ${columns} FROM neo_publications
        WHERE json_extract(payload_json, '$.producerInput.sessionId') = ?
          AND json_extract(payload_json, '$.producerInput.messageId') = ?
          AND json_extract(payload_json, '$.interim') IS NULL LIMIT 2`
      )
      .all(sessionId, messageId) as Row[];
    if (rows.length > 1) throw new Error('Ambiguous consultation publications');
    return rows[0] ? decode(rows[0]) : null;
  }
}
