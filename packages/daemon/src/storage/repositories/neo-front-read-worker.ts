import { z } from 'zod';
import { defineDbOp } from '../db-gateway/db-op.ts';

const Kind = z.enum(['projects', 'asks', 'cards', 'todos']);
const Text = z.string().trim().max(200);
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
    id: z.string().min(1).max(200),
    created: z.number().finite(),
    seen: z.number().int().min(0),
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
type Page = {
  items: RecordView[];
  total: number;
  totalExact: boolean;
  nextCursor: string | null;
  forwardOnly: true;
};
type Result = RecordView | Page | null;
type Row = {
  id: string;
  created: number;
  searchable: string;
  visible: number;
  active: number;
  summary: string;
  detail: string;
};

const sources = {
  projects: `SELECT id, created_at AS created, title AS searchable, 1 AS active,
    id NOT IN (SELECT source_id FROM neo_project_merges) AS visible,
    json_object('id',id,'name',substr(title,1,160)) AS summary,
    json_object('id',id,'name',title,'status',NULLIF(summary,'')) AS detail
    FROM neo_concerns`,
  asks: `SELECT id, created_at AS created, title AS searchable, 1 AS visible, status='open' AS active,
    json_object('id',id,'title',substr(title,1,160),'state',status) AS summary,
    json_object('id',id,'title',title,'state',status,'status',outcome) AS detail FROM neo_asks`,
  cards: `SELECT id, created_at AS created, text AS searchable, 1 AS visible, state='open' AS active,
    json_object('id',id,'label',substr(text,1,100),'state',state) AS summary,
    json_object('id',id,'label',substr(text,1,100),'state',state,'text',text,
      'options',CASE WHEN kind='yesno' THEN json_array(COALESCE(yes_label,'Yes'),COALESCE(no_label,'No'))
        ELSE json(options) END) AS detail FROM neo_questions`,
  todos: `SELECT id, created_at AS created, title AS searchable, 1 AS visible,
    state NOT IN ('done','removed') AS active,
    json_object('id',id,'title',substr(title,1,160),'state',state) AS summary,
    json_object('id',id,'title',title,'state',state,'blocker',blocked_reason,
      'report',substr(report,1,4000),'evidence',evidence,'updatedAt',updated_at) AS detail FROM neo_todos`,
};

const searchSources = { asks: 'ask', cards: 'question', todos: 'todo' } as const;

export const neoFrontReads = defineDbOp<z.input<typeof Request>, Result>({
  name: 'neo.front.read',
  mode: 'read',
  run(db, request) {
    const { conversationId, kind, input } = Request.parse(request);
    const scope = db
      .prepare('SELECT 1 FROM neo_conversation WHERE singleton=1 AND id=?')
      .get(conversationId);
    if (!scope) throw new Error('Front conversation unavailable');
    const cursor =
      'cursor' in input
        ? Cursor.parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')))
        : null;
    if (cursor && (cursor.kind !== kind || cursor.conversationId !== conversationId))
      throw new Error('Cursor belongs to another front read');
    const text = 'text' in input ? input.text : (cursor?.text ?? null);
    const terms = text?.match(/[\p{L}\p{N}]+/gu) ?? [];
    if (text !== null && !terms.length)
      return { items: [], total: 0, totalExact: true, nextCursor: null, forwardOnly: true };
    const records = `WITH records AS (${sources[kind]}) SELECT * FROM records`;
    if ('id' in input) {
      const row = db.prepare(`${records} WHERE id=?`).get(input.id) as Row | null;
      return row?.visible ? (JSON.parse(row.detail) as RecordView) : null;
    }
    const rows = db
      .prepare(`${records}
      ${cursor ? 'WHERE (created,id) < (?,?)' : ''} ORDER BY created DESC,id DESC LIMIT 11`)
      .all(...(cursor ? [cursor.created, cursor.id] : [])) as Row[];
    const more = rows.length > 10;
    if (more) rows.pop();
    const short = terms
      .filter((term) => [...term].length < 3)
      .map((term) => term.toLocaleLowerCase());
    const fts = terms
      .filter((term) => [...term].length >= 3)
      .map((term) => `"${term}"*`)
      .join(' ');
    const match = fts
      ? db.prepare(
          kind === 'projects'
            ? `SELECT 1 FROM neo_front_project_fts WHERE neo_front_project_fts MATCH ?
          AND rowid=(SELECT rowid FROM neo_concerns WHERE id=?) LIMIT 1`
            : `SELECT 1 FROM neo_card_search_fts WHERE neo_card_search_fts MATCH ?
          AND rowid=(SELECT id FROM neo_card_search_content WHERE source=? AND entity_id=?) LIMIT 1`
        )
      : null;
    const matched = rows.filter((row) => {
      if (!row.visible || (text === null && !row.active)) return false;
      if (!short.every((term) => row.searchable.toLocaleLowerCase().includes(term))) return false;
      return (
        !match ||
        !!match.get(
          kind === 'projects' ? fts : `title : (${fts})`,
          ...(kind === 'projects' ? [] : [searchSources[kind]]),
          row.id
        )
      );
    });
    const total = (cursor?.seen ?? 0) + matched.length;
    const last = rows.at(-1);
    return {
      items: matched.map((row) => JSON.parse(row.summary) as RecordView),
      total,
      totalExact: !cursor && !more,
      forwardOnly: true,
      nextCursor:
        more && last
          ? Buffer.from(
              JSON.stringify({
                conversationId,
                kind,
                text,
                created: last.created,
                id: last.id,
                seen: total,
              })
            ).toString('base64url')
          : null,
    };
  },
});
