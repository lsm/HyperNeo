import type { Database } from '../sqlite-compat.ts';
import { NeoRepository } from './neo-repository.ts';

export function readCardHandoffReferences(
  db: Database,
  source: { kind: 'question' | 'publication'; id: string }
): unknown {
  if (source.kind === 'question') {
    const row = db
      .prepare(
        'SELECT q.artifacts_json AS artifacts FROM neo_questions q JOIN neo_asks a ON a.id = q.ask_id WHERE q.id = ?'
      )
      .get(source.id) as { artifacts: string | null } | null;
    try {
      return row?.artifacts ? JSON.parse(row.artifacts) : null;
    } catch {
      return null;
    }
  }
  const conversation = new NeoRepository(db).readConversationId();
  if (!conversation) return null;
  const row = db
    .prepare(
      'SELECT payload_json AS payload FROM neo_publications WHERE conversation_id = ? AND publication_id = ?'
    )
    .get(conversation, source.id) as { payload: string } | null;
  try {
    return row ? JSON.parse(row.payload).artifacts : null;
  } catch {
    return null;
  }
}
