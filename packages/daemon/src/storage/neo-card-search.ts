import { buildFtsQuery } from './message-search.ts';
import type { Database } from './sqlite-compat.ts';

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
const SNIPPET_TOKENS = 12;

interface HitRow {
  source: 'ask' | 'todo' | 'question';
  ask_id: string;
  entity_id: string;
  score: number;
  title_highlight: string;
  meta_highlight: string;
  body_highlight: string;
  title_snippet: string;
  meta_snippet: string;
  body_snippet: string;
}

function toHit(row: HitRow): NeoCardSearchHit {
  const fields: [NeoCardSearchField, string, string][] = [
    ['title', row.title_highlight, row.title_snippet],
    ['meta', row.meta_highlight, row.meta_snippet],
    ['body', row.body_highlight, row.body_snippet],
  ];
  const matched = fields.find(([, highlight]) => highlight?.includes('['));
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
  db: Database,
  query: string,
  cursor?: string,
  limit?: number
): NeoCardSearchPage {
  const bounded = Math.min(Math.max(limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(Number.parseInt(cursor ?? '0', 10) || 0, 0);
  const ftsQuery = buildFtsQuery(query);
  if (!ftsQuery) return { results: [], nextCursor: null };
  const rows = db
    .prepare(
      `SELECT c.source AS source, c.ask_id AS ask_id, c.entity_id AS entity_id,
        bm25(neo_card_search_fts, ${TITLE_WEIGHT}, ${META_WEIGHT}, ${BODY_WEIGHT}) AS score,
        highlight(neo_card_search_fts, 0, '[', ']') AS title_highlight,
        highlight(neo_card_search_fts, 1, '[', ']') AS meta_highlight,
        highlight(neo_card_search_fts, 2, '[', ']') AS body_highlight,
        snippet(neo_card_search_fts, 0, '', '', '…', ${SNIPPET_TOKENS}) AS title_snippet,
        snippet(neo_card_search_fts, 1, '', '', '…', ${SNIPPET_TOKENS}) AS meta_snippet,
        snippet(neo_card_search_fts, 2, '', '', '…', ${SNIPPET_TOKENS}) AS body_snippet
      FROM neo_card_search_fts
      JOIN neo_card_search_content c ON c.id = neo_card_search_fts.rowid
      WHERE neo_card_search_fts MATCH ?
      ORDER BY score, c.id
      LIMIT ? OFFSET ?`
    )
    .all(ftsQuery, bounded + 1, offset) as HitRow[];
  const page = rows.slice(0, bounded).map(toHit);
  return {
    results: page,
    nextCursor: rows.length > bounded ? String(offset + bounded) : null,
  };
}
