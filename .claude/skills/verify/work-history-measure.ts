import { writeFileSync } from 'node:fs';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { projectNeoAskEntries, neoSnapshotAskEntries, summarizeNeoAskEntry } from '../../../packages/daemon/src/lib/neo/ask-entries.ts';

const [source, destination] = process.argv.slice(2);
if (!source || !destination) throw new Error('Pass a read-only source database and evidence JSON destination.');
const db = new Database(source, { readonly: true });
try {
  const repository = new NeoAskTodoRepository(db);
  const raw = repository.snapshot(undefined, Number.MAX_SAFE_INTEGER);
  const all = neoSnapshotAskEntries(projectNeoAskEntries(raw.asks, raw.facts, []), 20).todoAsks;
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  const tally = (entries: typeof all) => ({
    asks: entries.length,
    states: Object.fromEntries(['open', 'done', 'dropped'].map(state => [state, entries.filter(entry => entry.ask.status === state).length])),
    projectedBytes: bytes(entries),
  });
  const before = all.slice(0, 50);
  const open = all.filter(entry => entry.ask.status === 'open');
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const protectedEntry = (entry: typeof all[number]) => entry.ask.status === 'open' || entry.questions.some(question => question.state === 'open') || entry.todos.some(todo => ['todo', 'doing', 'blocked', 'failed', 'closed_unverified'].includes(todo.state));
  const fields: Record<string, number> = {};
  const todoFields: Record<string, number> = {};
  for (const entry of before) {
    for (const [key, value] of Object.entries(entry)) fields[key] = (fields[key] ?? 0) + bytes(value);
    for (const todo of entry.todos) for (const [key, value] of Object.entries(todo)) todoFields[key] = (todoFields[key] ?? 0) + bytes(value);
  }
  const result = {
    measuredAt: new Date().toISOString(),
    method: 'Read-only DB, production repository and card projection with no domain pack, RPC done-todo limit 20. Bytes cover todoAsks only, not the full live RPC snapshot or worker/pack enrichment.',
    all: tally(all),
    currentTop50: tally(before),
    currentTop50Summaries: tally(before.map(summarizeNeoAskEntry)),
    open: tally(open),
    candidate24Hours: tally(all.filter(entry => protectedEntry(entry) || (entry.ask.settledAt ?? entry.ask.updatedAt) >= cutoff)),
    candidateMostRecent5: tally([...all.filter(protectedEntry), ...all.filter(entry => !protectedEntry(entry)).slice(0, 5)]),
    candidateMostRecent1: tally([...all.filter(protectedEntry), ...all.filter(entry => !protectedEntry(entry)).slice(0, 1)]),
    currentCardFields: fields,
    currentTodoFields: todoFields,
    todoStates: db.prepare('SELECT state, COUNT(*) AS count FROM neo_todos GROUP BY state').all(),
    currentSettled: before.filter(entry => entry.ask.status !== 'open').map(entry => ({ status: entry.ask.status, ageHours: (Date.now() - (entry.ask.settledAt ?? entry.ask.updatedAt)) / 3600000, projectedBytes: bytes(entry) })),
  };
  writeFileSync(destination, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally {
  db.close();
}
