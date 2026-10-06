import { Database } from 'bun:sqlite';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import type { EvalCase, EvalTopic, EvalTurn } from './types.ts';

const HERE = dirname(new URL(import.meta.url).pathname);

interface RealLabel {
  requestId: string;
  expected: string[];
  followUp: boolean;
}

interface AskPayload {
  requestId: string;
  content: Array<{ type: string; text?: string }>;
}

interface PublicationPayload {
  askOrigin?: { messageId?: string };
  shortText?: string;
  fullText?: string;
}

const { values } = parseArgs({
  options: {
    db: { type: 'string' },
    labels: { type: 'string', default: join(HERE, 'real-labels.json') },
  },
});

if (!values.db) throw new Error('--db must point at a copy of daemon.db, never the live file');
const db = new Database(values.db, { readonly: true });
const labels = new Map(
  (JSON.parse(readFileSync(values.labels ?? '', 'utf8')) as RealLabel[]).map((label) => [
    label.requestId,
    label,
  ])
);

const answers = new Map<string, string>();
for (const row of db
  .query<{ payload_json: string }, []>(
    'SELECT payload_json FROM neo_publications ORDER BY sequence'
  )
  .all()) {
  const payload = JSON.parse(row.payload_json) as PublicationPayload;
  const messageId = payload.askOrigin?.messageId;
  if (messageId && !answers.has(messageId)) {
    answers.set(messageId, payload.shortText ?? payload.fullText ?? '');
  }
}

const topics: EvalTopic[] = db
  .query<{ id: string; title: string; summary: string }, []>(
    "SELECT id, title, summary FROM neo_concerns WHERE id != 'inbox' ORDER BY created_at"
  )
  .all()
  .map((row) => ({ id: row.id, title: row.title, summary: row.summary ?? '' }));

const asks = db
  .query<{ payload_json: string; created_at: string | number }, []>(
    'SELECT payload_json, created_at FROM neo_conversation_asks ORDER BY sequence'
  )
  .all()
  .map((row) => {
    const payload = JSON.parse(row.payload_json) as AskPayload;
    return {
      requestId: payload.requestId,
      text: payload.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join(' '),
      at: new Date(row.created_at).toISOString(),
    };
  });

const cases: EvalCase[] = [];
const history: EvalTurn[] = [];
for (const ask of asks) {
  const label = labels.get(ask.requestId);
  if (label) {
    const caseTopics = topics.map((topic) => {
      const last = [...history].reverse().find((entry) => entry.topic === topic.id);
      return last ? { ...topic, latest: { ask: last.ask, answer: last.answer } } : topic;
    });
    cases.push({
      id: `real-${String(cases.length + 1).padStart(2, '0')}`,
      source: 'real',
      kind: 'real',
      now: ask.at,
      topics: caseTopics,
      turns: [...history],
      message: ask.text,
      expected: label.expected,
      followUp: label.followUp,
    });
  }
  history.push({
    topic: label?.expected[0] ?? 'main',
    ask: ask.text,
    answer: answers.get(ask.requestId) ?? '',
    at: ask.at,
  });
}

const out = join(HERE, 'cases', 'real.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(cases, null, 2)}\n`);
console.log(`wrote ${cases.length} real cases to ${out}`);
