import { buildFtsQuery, buildShortSearchPattern } from './message-search.ts';

export type NeoCardSearchField = 'title' | 'meta' | 'body';

export interface NeoCardSearchHit {
  askId: string;
  todoId: string | null;
  questionId: string | null;
  field: NeoCardSearchField;
  score: number;
  snippet: string;
}

export interface NeoCardSearchPage {
  results: NeoCardSearchHit[];
  nextCursor: string | null;
}

const TITLE_WEIGHT = 4.0;
const META_WEIGHT = 2.0;
const BODY_WEIGHT = 1.0;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const SNIPPET_TOKENS = 36;

interface HitRow {
  source: 'ask' | 'todo' | 'question';
  ask_id: string;
  entity_id: string;
  score: number;
  title_match: number;
  meta_match: number;
  body_match: number;
  title_snippet: string;
  meta_snippet: string;
  body_snippet: string;
}

function toHit(row: HitRow): NeoCardSearchHit {
  const fields: [NeoCardSearchField, number, string][] = [
    ['title', row.title_match, row.title_snippet],
    ['meta', row.meta_match, row.meta_snippet],
    ['body', row.body_match, row.body_snippet],
  ];
  const matched = fields.find(([, matched]) => matched > 0);
  const [, , snippet] = matched ?? fields[fields.length - 1];
  return {
    askId: row.ask_id,
    todoId: row.source === 'todo' ? row.entity_id : null,
    questionId: row.source === 'question' ? row.entity_id : null,
    field: matched?.[0] ?? 'body',
    score: row.score,
    snippet,
  };
}

export function searchNeoCards(
  read: (sql: string, bindings: readonly (string | number)[]) => unknown[],
  query: string,
  cursor?: string,
  limit?: number
): NeoCardSearchPage {
  const bounded = Math.min(Math.max(limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(Number.parseInt(cursor ?? '0', 10) || 0, 0);
  const ftsQuery = buildFtsQuery(query);
  const short = !ftsQuery && buildShortSearchPattern(query);
  if (!ftsQuery && !short) return { results: [], nextCursor: null };
  const rows = read(
    short
      ? `SELECT c.source, c.ask_id, c.entity_id, 0 AS score,
        c.title LIKE ?1 ESCAPE '\\' AS title_match,
        c.meta LIKE ?1 ESCAPE '\\' AS meta_match,
        c.body LIKE ?1 ESCAPE '\\' AS body_match,
        substr(c.title, max(1, instr(lower(c.title), lower(?2)) - 40), 160) AS title_snippet,
        substr(c.meta, max(1, instr(lower(c.meta), lower(?2)) - 40), 160) AS meta_snippet,
        substr(c.body, max(1, instr(lower(c.body), lower(?2)) - 40), 160) AS body_snippet
      FROM neo_card_search_content c
      WHERE c.title LIKE ?1 ESCAPE '\\' OR c.meta LIKE ?1 ESCAPE '\\' OR c.body LIKE ?1 ESCAPE '\\'
      ORDER BY c.updated_at DESC, c.id LIMIT ?3 OFFSET ?4`
      : `SELECT c.source AS source, c.ask_id AS ask_id, c.entity_id AS entity_id,
        bm25(neo_card_search_fts, ${TITLE_WEIGHT}, ${META_WEIGHT}, ${BODY_WEIGHT}) AS score,
        highlight(neo_card_search_fts, 0, char(1), char(2)) IS NOT c.title AS title_match,
        highlight(neo_card_search_fts, 1, char(1), char(2)) IS NOT c.meta AS meta_match,
        highlight(neo_card_search_fts, 2, char(1), char(2)) IS NOT c.body AS body_match,
        snippet(neo_card_search_fts, 0, '', '', '…', ${SNIPPET_TOKENS}) AS title_snippet,
        snippet(neo_card_search_fts, 1, '', '', '…', ${SNIPPET_TOKENS}) AS meta_snippet,
        snippet(neo_card_search_fts, 2, '', '', '…', ${SNIPPET_TOKENS}) AS body_snippet
      FROM neo_card_search_fts
      JOIN neo_card_search_content c ON c.id = neo_card_search_fts.rowid
      WHERE neo_card_search_fts MATCH ?
      ORDER BY score, c.id
      LIMIT ? OFFSET ?`,
    short ? [short, query.trim(), bounded + 1, offset] : [ftsQuery, bounded + 1, offset]
  ) as HitRow[];
  const page = rows.slice(0, bounded).map(toHit);
  return {
    results: page,
    nextCursor: rows.length > bounded ? String(offset + bounded) : null,
  };
}
