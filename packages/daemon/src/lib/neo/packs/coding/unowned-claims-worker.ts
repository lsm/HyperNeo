import type { Database } from '../../../../storage/sqlite-compat.ts';
import { codingPrKey } from './pr-key.ts';
import type { CodingUnownedPr } from './pr-unowned.ts';

export function readCodingUnownedClaims(db: Database, rows: readonly CodingUnownedPr[]) {
  if (!rows.length) return new Set<string>();
  const owned = db
    .prepare(`SELECT 'https://github.com/' || lower(repo) || '/pull/' || number AS url
    FROM pack_coding_pr_ledger l WHERE owner IS NOT NULL AND EXISTS
      (SELECT 1 FROM json_each(?) p WHERE lower(json_extract(p.value, '$.repo')) = lower(l.repo)
       AND json_extract(p.value, '$.number') = l.number)`)
    .all(JSON.stringify(rows)) as { url: string }[];
  const linked = db
    .prepare(`WITH active AS (
    SELECT t.check_json FROM neo_todos t JOIN neo_asks a ON a.id = t.ask_id
    WHERE a.status = 'open' AND t.state IN ('todo', 'doing', 'blocked')
      AND json_extract(t.check_json, '$.pack') = 'coding')
    SELECT urls.value AS url FROM active, json_each(active.check_json, '$.params.urls') urls
    WHERE urls.type = 'text'
    UNION SELECT json_extract(check_json, '$.params.url') AS url FROM active
    WHERE json_type(check_json, '$.params.url') = 'text'`)
    .all() as { url: string }[];
  return new Set([...owned, ...linked].flatMap(({ url }) => codingPrKey(url) ?? []));
}
