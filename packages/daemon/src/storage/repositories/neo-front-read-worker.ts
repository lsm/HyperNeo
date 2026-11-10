import { z } from 'zod';
import { defineDbOp } from '../db-gateway/db-op.ts';
import { buildFtsQuery } from '../message-search.ts';

const Kind = z.enum(['projects', 'asks', 'cards', 'todos']);
const Text = z.string().trim().min(1).max(200);
const Input = z.union([
  z.object({}).strict(),
  z.object({ cursor: z.string().min(1).max(2000) }).strict(),
  z.object({ id: z.string().min(1).max(200) }).strict(),
  z.object({ text: Text }).strict(),
]);
const Request = z.object({ conversationId: z.string().uuid(), kind: Kind, input: Input }).strict();
const Cursor = z
  .object({
    conversationId: z.string().uuid(),
    kind: Kind,
    text: Text.nullable(),
    updated: z.number().finite(),
    id: z.string().min(1).max(200),
  })
  .strict();

type RecordView = {
  id: string;
  name?: string;
  title?: string;
  label?: string;
  state?: string;
  status?: string | null;
  blocker?: string | null;
  text?: string;
  options?: string[] | null;
};
type Page = { items: RecordView[]; total: number; nextCursor: string | null };
type Result = RecordView | Page | null;
type Row = { id: string; updated: number; summary: string; detail: string };

const sources = {
  projects: `SELECT id, updated_at AS updated, title AS searchable, 1 AS active,
    json_object('id',id,'name',substr(title,1,160)) AS summary,
    json_object('id',id,'name',title,'status',NULLIF(summary,'')) AS detail
    FROM neo_concerns WHERE id NOT IN (SELECT source_id FROM neo_project_merges)`,
  asks: `SELECT id, updated_at AS updated, title AS searchable, status='open' AS active,
    json_object('id',id,'title',substr(title,1,160),'state',status) AS summary,
    json_object('id',id,'title',title,'state',status,'status',outcome) AS detail FROM neo_asks`,
  cards: `SELECT id, COALESCE(answered_at,created_at) AS updated, text AS searchable,
    state='open' AS active,
    json_object('id',id,'label',substr(text,1,100),'state',state) AS summary,
    json_object('id',id,'label',substr(text,1,100),'state',state,'text',text,
      'options',CASE WHEN kind='yesno' THEN json_array(COALESCE(yes_label,'Yes'),COALESCE(no_label,'No'))
        ELSE json(options) END) AS detail FROM neo_questions`,
  todos: `SELECT id, updated_at AS updated, title AS searchable,
    state NOT IN ('done','removed') AS active,
    json_object('id',id,'title',substr(title,1,160),'state',state) AS summary,
    json_object('id',id,'title',title,'state',state,'blocker',blocked_reason) AS detail FROM neo_todos`,
};

const searchSources = { asks: 'ask', cards: 'question', todos: 'todo' } as const;

export const neoFrontReads = defineDbOp<z.input<typeof Request>, Result>({
  name: 'neo.front.read',
  mode: 'read',
  run(db, request) {
    const { conversationId, kind, input } = Request.parse(request);
    const scope = db
      .prepare(`SELECT 1 FROM neo_conversation WHERE id=? AND EXISTS
      (SELECT 1 FROM neo_session_bindings WHERE kind='neo' AND concern_id IS NULL)`)
      .get(conversationId);
    if (!scope) throw new Error('Front conversation unavailable');
    const cursor =
      'cursor' in input
        ? Cursor.parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')))
        : null;
    if (cursor && (cursor.kind !== kind || cursor.conversationId !== conversationId))
      throw new Error('Cursor belongs to another front read');
    const text = 'text' in input ? input.text : (cursor?.text ?? null);
    const id = 'id' in input ? input.id : null;
    const bindings: (string | number | null)[] = [];
    const where = [id !== null || text !== null ? '1' : 'active'];
    if (id !== null) {
      where.push('id=?');
      bindings.push(id);
    }
    if (text !== null) {
      const fts = buildFtsQuery(text);
      if (kind !== 'projects' && fts) {
        where.push(`id IN (SELECT c.entity_id FROM neo_card_search_fts
          JOIN neo_card_search_content c ON c.id=neo_card_search_fts.rowid
          WHERE neo_card_search_fts MATCH ? AND c.source=?)`);
        bindings.push(`title : (${fts})`, searchSources[kind]);
      } else {
        for (const term of text.toLocaleLowerCase().split(/\s+/u)) {
          where.push('instr(lower(searchable),?)>0');
          bindings.push(term);
        }
      }
    }
    const matched = `WITH records AS (${sources[kind]}) SELECT * FROM records WHERE ${where.join(' AND ')}`;
    const { total } = db.prepare(`SELECT count(*) AS total FROM (${matched})`).get(...bindings) as {
      total: number;
    };
    const rows = db
      .prepare(`SELECT * FROM (${matched})
      ${cursor ? 'WHERE (updated,id) < (?,?)' : ''} ORDER BY updated DESC,id DESC LIMIT 10`)
      .all(...bindings, ...(cursor ? [cursor.updated, cursor.id] : [])) as Row[];
    if (id !== null || (text !== null && total === 1 && !cursor))
      return rows[0] ? (JSON.parse(rows[0].detail) as RecordView) : null;
    const last = rows.at(-1);
    const more =
      last &&
      !!db
        .prepare(`SELECT 1 FROM (${matched}) WHERE (updated,id)<(?,?) LIMIT 1`)
        .get(...bindings, last.updated, last.id);
    return {
      items: rows.map((row) => JSON.parse(row.summary) as RecordView),
      total,
      nextCursor: more
        ? Buffer.from(
            JSON.stringify({ conversationId, kind, text, updated: last.updated, id: last.id })
          ).toString('base64url')
        : null,
    };
  },
});
