import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { CaseKind, EvalResult } from './types.ts';

const HERE = dirname(new URL(import.meta.url).pathname);
const RESULTS = join(HERE, 'results');
const CLASSIFIER_TIMEOUT_MS = 4_000;

const PRICES_PER_MTOK: Array<{ prefix: string; input: number; cached: number; output: number }> = [
  { prefix: 'llm-haiku', input: 1, cached: 0.1, output: 5 },
  { prefix: 'llm-glm-flash', input: 0.1191, cached: 0.0343, output: 0.417 },
  { prefix: 'llm-glm', input: 0.7447, cached: 0.1787, output: 3.2765 },
  { prefix: 'llm-luna', input: 0.2, cached: 0.02, output: 1.2 },
  { prefix: 'llm-deepseek', input: 0.15, cached: 0.003, output: 0.6 },
];

const KINDS: CaseKind[] = [
  'follow_up',
  'second_last',
  'waiting_yes',
  'two_waiting',
  'one_off',
  'new_subject',
  'thanks',
  'long_dictated',
  'mixed_language',
  'real',
];

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function pct(hits: number, total: number): string {
  return total === 0 ? '–' : `${Math.round((hits / total) * 100)}%`;
}

function correct(result: EvalResult, timeout: boolean): boolean {
  const predicted = timeout && result.latencyMs > CLASSIFIER_TIMEOUT_MS ? 'main' : result.predicted;
  return result.expected.includes(predicted);
}

function costPerThousand(name: string, results: EvalResult[]): string {
  const candidate = name.split('-').slice(1).join('-');
  const price = PRICES_PER_MTOK.find((entry) => candidate.startsWith(entry.prefix));
  if (!price) return '$0 (local)';
  const total = results.reduce(
    (sum, result) =>
      sum +
      ((result.inputTokens ?? 0) * price.input +
        (result.cachedInputTokens ?? 0) * price.cached +
        (result.outputTokens ?? 0) * price.output) /
        1_000_000,
    0
  );
  return `$${((total / results.length) * 1_000).toFixed(2)}`;
}

const files = readdirSync(RESULTS).filter((file) => file.endsWith('.jsonl'));
const runs = files.map((file) => ({
  name: basename(file, '.jsonl'),
  results: readFileSync(join(RESULTS, file), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as EvalResult),
}));

const summary = [
  '| run | all | synthetic | real | follow-ups → inbox | p50 ms | p95 ms | acc. with 4 s timeout | cost / 1k | errors |',
  '|---|---|---|---|---|---|---|---|---|---|',
];
const byKind = [`| run | ${KINDS.join(' | ')} |`, `|---|${KINDS.map(() => '---').join('|')}|`];
for (const { name, results } of runs) {
  const synthetic = results.filter((result) => result.source === 'synthetic');
  const real = results.filter((result) => result.source === 'real');
  const followUps = results.filter((result) => result.followUp);
  const toInbox = followUps.filter(
    (result) => result.predicted === 'inbox' && !result.expected.includes('inbox')
  ).length;
  const latencies = results.map((result) => result.latencyMs);
  summary.push(
    `| ${name} | ${pct(results.filter((r) => correct(r, false)).length, results.length)} | ${pct(synthetic.filter((r) => correct(r, false)).length, synthetic.length)} | ${pct(real.filter((r) => correct(r, false)).length, real.length)} | ${toInbox}/${followUps.length} | ${percentile(latencies, 50)} | ${percentile(latencies, 95)} | ${pct(results.filter((r) => correct(r, true)).length, results.length)} | ${costPerThousand(name, results)} | ${results.filter((r) => r.error).length} |`
  );
  byKind.push(
    `| ${name} | ${KINDS.map((kind) => {
      const ofKind = results.filter((result) => result.kind === kind);
      return pct(ofKind.filter((r) => correct(r, false)).length, ofKind.length);
    }).join(' | ')} |`
  );
}

console.log(summary.join('\n'));
console.log('');
console.log(byKind.join('\n'));
