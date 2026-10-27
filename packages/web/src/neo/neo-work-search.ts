import type { NeoAskEntry } from '@hyperneo/shared/types/neo-ask';
import superpipe, { type PipelineAPI } from 'superpipe';

const CJK = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}]+/gu;
const WEIGHTS = [3, 2, 1, 0.5];

function terms(text: string): string[] {
  const normalized = text.normalize('NFKC').toLowerCase();
  const tokens: string[] = normalized.replace(CJK, ' ').match(/[\p{L}\p{N}]+/gu) ?? [];
  for (const run of normalized.matchAll(CJK)) {
    const chars = Array.from(run[0]);
    tokens.push(...chars, ...chars.slice(1).map((char, index) => chars[index] + char));
  }
  return tokens;
}

export function createNeoWorkSearch(entries: readonly NeoAskEntry[]) {
  const corpus = entries.map((entry) =>
    [
      [entry.ask.title, entry.ask.request].join(' '),
      entry.todos.map((todo) => todo.title).join(' '),
      [
        entry.state,
        ...entry.todos.flatMap((todo) => [todo.status, todo.nextAction ?? '']),
        ...entry.questions.map((question) => question.text),
      ].join(' '),
      [
        entry.ask.outcome ?? '',
        ...entry.todos.flatMap((todo) => [todo.report ?? '', todo.evidence ?? '']),
      ].join(' '),
    ].map((text) => {
      const tokens = terms(text),
        counts = new Map<string, number>();
      for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
      return { length: tokens.length, counts };
    })
  );
  const averages = WEIGHTS.map(
    (_, field) => corpus.reduce((sum, doc) => sum + doc[field].length, 0) / (entries.length || 1)
  );
  const frequencies = new Map<string, number>();
  for (const doc of corpus)
    for (const token of new Set(doc.flatMap((field) => [...field.counts.keys()])))
      frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  return (superpipe({})('neo.work.search') as PipelineAPI)
    .input(['query'])
    .pipe((query: string) => [...new Set(terms(query))], 'query', 'terms')
    .pipe(
      (query: string[]) =>
        corpus
          .map((doc, index) => {
            let score = 0;
            for (const token of query) {
              const frequency = doc.reduce(
                (sum, field, i) =>
                  sum +
                  (WEIGHTS[i] * (field.counts.get(token) ?? 0)) /
                    (0.25 + (0.75 * field.length) / (averages[i] || 1)),
                0
              );
              if (!frequency) continue;
              const df = frequencies.get(token)!;
              score +=
                (Math.log(1 + (entries.length - df + 0.5) / (df + 0.5)) * frequency * 2.2) /
                (frequency + 1.2);
            }
            return { index, score };
          })
          .filter((hit) => hit.score > 0)
          .sort((a, b) => b.score - a.score || a.index - b.index)
          .map((hit) => entries[hit.index]),
      'terms',
      'matches'
    )
    .end('matches') as (query: string) => NeoAskEntry[];
}
