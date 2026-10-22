import type { NeoConversationWake } from '@hyperneo/shared/types/neo-wake';
import { z } from 'zod';
import type { Database } from '../sqlite-compat.ts';
import { sdkMessageBodyAt } from './sdk-message-body-read.ts';

export const NeoConversationWakeSchema: z.ZodType<NeoConversationWake> = z.object({
  scheduleId: z.string(),
  sourceKind: z.string(),
  sourceId: z.string(),
  title: z.string(),
  firedAt: z.number(),
  settledAt: z.number().nullable(),
  summary: z.string().nullable(),
  additions: z.array(
    z.object({
      kind: z.enum(['ask', 'todo', 'question', 'publication', 'journal']),
      id: z.string(),
      label: z.string(),
    })
  ),
});
const FROM = `FROM session_schedule_wakes o CROSS JOIN sdk_messages m INDEXED BY idx_sdk_messages_session_uuid
  ON m.session_id = o.session_id AND m.sdk_uuid = o.message_id
  WHERE o.session_id = 'neo:' || ? AND m.message_type = 'user'
`;
export const NEO_WAKE_SELECT = `SELECT
  strftime('%Y-%m-%dT%H:%M:%fZ', o.fired_at / 1000.0, 'unixepoch') AS at,
  'wake' AS role, m.seq AS sequence, o.message_id AS id ${FROM}`;

export class NeoConversationWakeRepository {
  constructor(private readonly db: Database) {}

  latest(conversationId: string, limit: number): NeoConversationWake[] {
    return (
      this.db
        .prepare(`${NEO_WAKE_SELECT} ORDER BY at DESC, sequence DESC LIMIT ?`)
        .all(conversationId, limit) as { id: string }[]
    )
      .reverse()
      .map((row) => this.get(conversationId, row.id)!);
  }

  get(conversationId: string, messageId: string): NeoConversationWake | null {
    const input = this.db
      .prepare(`SELECT o.fired_at AS firedAt, m.consumed_seq AS consumed,
      o.metadata_json AS metadata ${FROM} AND o.message_id = ?`)
      .get(conversationId, messageId) as {
      firedAt: number;
      consumed: number | null;
      metadata: string;
    } | null;
    if (!input) return null;
    const source = JSON.parse(input.metadata) as Pick<
      NeoConversationWake,
      'scheduleId' | 'sourceKind' | 'sourceId'
    > & { legacyInputs?: string[] };
    const goal = this.db
      .prepare('SELECT title FROM space_goals WHERE id = ? AND owner_session_id = ?')
      .get(source.sourceKind === 'goal' ? source.sourceId : null, `neo:${conversationId}`) as {
      title: string;
    } | null;
    const schedule = this.db
      .prepare('SELECT note FROM session_schedules WHERE id = ?')
      .get(source.scheduleId) as { note: string | null } | null;
    const end = this.db
      .prepare(`WITH terminal AS MATERIALIZED (
        SELECT r.timestamp, r.consumed_seq, ${sdkMessageBodyAt('r.seq')} AS body
        FROM sdk_messages r WHERE r.session_id = ?1 AND r.message_type = 'result'
          AND r.consumed_seq >= ?2 AND r.is_terminal = 1 AND r.parent_tool_use_id IS NULL
          AND COALESCE(r.internal_compaction_turn, 0) = 0
          AND NOT (COALESCE(r.recovery_intercepted, 0) = 1 AND COALESCE(r.recovery_billing_terminal, 0) = 0)
        ORDER BY r.consumed_seq ASC, r.seq ASC LIMIT 1)
      SELECT timestamp, json_extract(body, '$.result') AS summary FROM terminal
      WHERE (json_extract(body, '$.neoAskOrigin.sessionId') = ?1
        AND json_extract(body, '$.neoAskOrigin.messageId') = ?3)
      OR (json_extract(body, '$.neoInputOrigin.sessionId') = ?1
        AND json_extract(body, '$.neoInputOrigin.messageId') = ?3)
      OR (json_extract(body, '$.neoInputOrigin') IS NULL
        AND consumed_seq < COALESCE((SELECT MIN(m.consumed_seq) FROM sdk_messages m
          WHERE m.session_id = ?1 AND m.consumed_seq > ?2 AND m.message_type = 'user'
            AND m.parent_tool_use_id IS NULL AND COALESCE(m.send_status, 'consumed') = 'consumed'
            AND COALESCE(m.is_replay, 0) = 0 AND COALESCE(m.internal_compaction_turn, 0) = 0
            AND COALESCE(m.first_block_type, 'text') <> 'tool_result'
            AND NOT EXISTS (SELECT 1 FROM json_each(?4) i WHERE i.value = m.sdk_uuid)), 9223372036854775807))`)
      .get(
        `neo:${conversationId}`,
        input.consumed,
        messageId,
        JSON.stringify(source.legacyInputs ?? [])
      ) as {
      timestamp: string;
      summary: unknown;
    } | null;
    const additions = this.db
      .prepare(`WITH asks AS (
        SELECT id, title FROM neo_asks WHERE session_id = ?1 AND origin_message_id = ?2)
      SELECT 'ask' AS kind, id, title AS label FROM asks
      UNION ALL SELECT 'todo', t.id, t.title FROM neo_todos t JOIN asks a ON a.id = t.ask_id
      UNION ALL SELECT 'question', q.id, q.text FROM neo_questions q JOIN asks a ON a.id = q.ask_id
      UNION ALL SELECT 'publication', publication_id, json_extract(payload_json, '$.shortText')
        FROM neo_publications WHERE conversation_id = ?3 AND (
          (json_extract(payload_json, '$.producerInput.sessionId') = ?1 AND json_extract(payload_json, '$.producerInput.messageId') = ?2)
          OR (json_extract(payload_json, '$.askOrigin.sessionId') = ?1 AND json_extract(payload_json, '$.askOrigin.messageId') = ?2))
      UNION ALL SELECT 'journal', j.id, j.effect FROM goal_journal j
        JOIN space_goals g ON g.id = j.goal_id
        WHERE j.goal_id = ?4 AND j.run_id = ?2 AND g.owner_session_id = ?1`)
      .all(
        `neo:${conversationId}`,
        messageId,
        conversationId,
        source.sourceKind === 'goal' ? source.sourceId : null
      ) as NeoConversationWake['additions'];
    return {
      scheduleId: source.scheduleId,
      sourceKind: source.sourceKind,
      sourceId: source.sourceId,
      title: goal?.title ?? schedule?.note ?? 'Scheduled check-in',
      firedAt: input.firedAt,
      settledAt: end ? Date.parse(end.timestamp) : null,
      summary:
        typeof end?.summary === 'string'
          ? end.summary.trim().split('\n').at(-1)?.trim() || null
          : null,
      additions,
    };
  }
}
