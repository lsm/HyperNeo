import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { githubUrlKey, parsePrUrl } from '../../../github/parse-pr-url.ts';

export const CodingActor = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('agent'),
    id: z.string().trim().min(1),
    model: z.string().trim().min(1),
    harness: z.string().trim().min(1),
  }),
  z.object({ kind: z.literal('human'), id: z.string().trim().min(1) }),
]);
export const CodingStageFact = z.object({
  url: z.string().refine((url) => !!parsePrUrl(url)),
  head: z.string().trim().min(1),
  stage: z.enum(['review', 'qa']),
  actor: CodingActor,
  verdict: z.enum(['pass', 'fail', 'inconclusive']),
  acceptanceContract: z.string().trim().min(1),
  evidence: z.array(z.string().trim().min(1)).min(1),
});
export type CodingStageFact = z.infer<typeof CodingStageFact>;

export class CodingStageFactsRepository {
  constructor(private readonly db: Database) {}

  observeHead(url: string, head: string, observedAt: number): void {
    const key = githubUrlKey(url);
    this.db.transaction(() => {
      const previous = this.db
        .prepare('SELECT observed_at AS at, head FROM pack_coding_stage_heads WHERE url = ?')
        .get(key) as { at: number; head: string } | undefined;
      if (previous && observedAt < previous.at) return;
      if (previous && observedAt === previous.at) {
        if (previous.head !== head) {
          this.db.prepare('DELETE FROM pack_coding_stage_facts WHERE url = ?').run(key);
          this.db.prepare("UPDATE pack_coding_stage_heads SET head = '' WHERE url = ?").run(key);
        }
        return;
      }
      this.db
        .prepare('DELETE FROM pack_coding_stage_facts WHERE url = ? AND head <> ?')
        .run(key, head);
      this.db
        .prepare(`INSERT INTO pack_coding_stage_heads (url, head, observed_at) VALUES (?, ?, ?)
        ON CONFLICT(url) DO UPDATE SET head = excluded.head, observed_at = excluded.observed_at`)
        .run(key, head, observedAt);
    })();
  }

  record(input: CodingStageFact): boolean {
    const fact = CodingStageFact.parse(input);
    fact.url = githubUrlKey(fact.url);
    return (
      this.db
        .prepare(`INSERT INTO pack_coding_stage_facts (url, head, stage, fact_json)
      SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM pack_coding_stage_heads WHERE url = ? AND head = ?)
      ON CONFLICT(url, stage) DO UPDATE SET head = excluded.head, fact_json = excluded.fact_json
      WHERE json_extract(pack_coding_stage_facts.fact_json, '$.verdict') <> 'fail'`)
        .run(fact.url, fact.head, fact.stage, JSON.stringify(fact), fact.url, fact.head).changes ===
      1
    );
  }

  read(url: string): CodingStageFact[] {
    const rows = this.db
      .prepare(`SELECT fact_json AS fact FROM pack_coding_stage_facts
      WHERE url = ? ORDER BY stage`)
      .all(githubUrlKey(url)) as { fact: string }[];
    return rows.map((row) => CodingStageFact.parse(JSON.parse(row.fact)));
  }
}

const normalize = (identity: string) => identity.trim().replace(/\s+/g, ' ').toLowerCase();

function canonicalModel(identity: string): string | null {
  const name = normalize(identity)
    .replace(/^(openai|anthropic)\//, '')
    .replace(/\s+/g, '-');
  const gpt =
    /^(?:gpt|codex)-(\d+(?:\.\d+)?)(?:-(?:sol|astra|luna|terra))?(?:-\d{4}-?\d{2}(?:-?\d{2})?)?$/.exec(
      name
    );
  if (gpt) return `gpt-${gpt[1]}`;
  const claude = /^claude-(opus|sonnet|haiku)-(\d+)[.-](\d+)(?:-\d{8})?$/.exec(name);
  return claude ? `claude-${claude[1]}-${claude[2]}.${claude[3]}` : null;
}

function parseAuthor(body: string) {
  let fence: string | null = null;
  const lines = body.split(/\r?\n/).filter((line) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      return false;
    }
    return !fence && /^Author:/i.test(line.trim());
  });
  const match =
    lines.length === 1 ? /^Author: ([^<>\n]+?) via ([^<>\n]+?)$/i.exec(lines[0].trim()) : null;
  if (!match) return null;
  const model = normalize(match[1]),
    harness = normalize(match[2]);
  return model && harness && !/\bvia\b/.test(model + ' ' + harness) ? { model, harness } : null;
}

export const codingReviewerPolicy = (superpipe({})('coding.reviewer-provenance') as PipelineAPI)
  .input(['enabled', 'body', 'reviewer'])
  .pipe(parseAuthor, 'body', 'author')
  .pipe(
    (
      enabled: boolean,
      author: ReturnType<typeof parseAuthor>,
      reviewer: z.infer<typeof CodingActor>
    ) => {
      if (!enabled) return { qualifies: true, preferred: true, reason: 'disabled' };
      if (!author)
        return {
          qualifies: false,
          preferred: false,
          reason:
            'author_provenance_required: ask the author to fix missing or ambiguous Author: <model> via <harness>',
        };
      if (reviewer.kind === 'human') return { qualifies: true, preferred: true, reason: 'human' };
      const authorModel = canonicalModel(author.model),
        reviewerModel = canonicalModel(reviewer.model);
      if (!authorModel || !reviewerModel)
        return { qualifies: false, preferred: false, reason: 'model_identity_unrecognised' };
      const different = reviewerModel !== authorModel;
      return {
        qualifies: different,
        preferred: different && normalize(reviewer.harness) !== author.harness,
        reason: different ? 'different_model' : 'same_model',
      };
    },
    ['enabled', 'author', 'reviewer'],
    'policy'
  )
  .end('policy') as (
  enabled: boolean,
  body: string,
  reviewer: z.infer<typeof CodingActor>
) => { qualifies: boolean; preferred: boolean; reason: string };
