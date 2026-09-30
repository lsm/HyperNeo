import type {
  NeoPublication,
  NeoPublicationAppendResult,
  NeoPublicationInput,
} from '@hyperneo/shared/types/neo-publication';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { admitNeoPublication } from '../../lib/neo/publication.ts';
import type { Database } from '../sqlite-compat.ts';

type Row = { sequence: number; payloadJson: string; createdAt: string };
const columns = 'sequence, payload_json AS payloadJson, created_at AS createdAt';
const page = z.object({
  conversationId: z.string().uuid(),
  after: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  limit: z.number().int().min(1).max(100),
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
          .prepare(`SELECT ${columns} FROM neo_publications
        WHERE conversation_id = ? AND sequence > ? ORDER BY sequence LIMIT ?`)
          .all(input.conversationId, input.after, input.limit) as Row[]
      ).map(decode),
    ['db', 'publications'],
    'publications'
  )
  .end('publications') as (input: unknown, db: Database) => NeoPublication[] | null;

export class NeoPublicationRepository {
  constructor(private readonly db: Database) {}

  append(input: unknown): NeoPublicationAppendResult {
    const result = append(input, this.db);
    return result === 'invalid_publication' ? { accepted: false, reason: result } : result;
  }

  list(conversationId: string, after = 0, limit = 50): NeoPublication[] | null {
    return readPage({ conversationId, after, limit }, this.db);
  }
}
