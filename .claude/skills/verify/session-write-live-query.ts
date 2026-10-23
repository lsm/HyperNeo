import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const port = process.env.VERIFY_PORT;
const run = process.argv[2];
if (!port || !run) {
  console.error('usage: VERIFY_PORT=<port> bun session-write-live-query.ts <run-dir>');
  process.exit(2);
}

type Row = { id: string; title?: string; status?: string };
type Delta = { subscriptionId: string; added?: Row[]; updated?: Row[]; removed?: Row[] };

const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

const replies = new Map<string, (message: { data?: unknown; error?: unknown }) => void>();
const deltas: Array<{ at: number; delta: Delta }> = [];
let snapshot: Row[] | null = null;
ws.onmessage = (event) => {
  const message = JSON.parse(String(event.data));
  const reply = replies.get(message.requestId ?? message.id);
  if (reply && message.type !== 'EVENT') reply(message);
  if (message.method === 'liveQuery.snapshot' && message.data.subscriptionId === 'verify-sessions')
    snapshot = message.data.rows;
  if (message.method === 'liveQuery.delta' && message.data.subscriptionId === 'verify-sessions')
    deltas.push({ at: performance.now(), delta: message.data });
};

function rpc(method: string, data: unknown): Promise<unknown> {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 30_000);
    replies.set(id, (message) => {
      clearTimeout(timer);
      replies.delete(id);
      if (message.error) reject(new Error(`${method}: ${JSON.stringify(message.error)}`));
      else resolve(message.data);
    });
    ws.send(
      JSON.stringify({
        id,
        type: 'REQ',
        sessionId: 'global',
        method,
        data,
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      })
    );
  });
}

async function waitFor(
  label: string,
  start: number,
  match: (delta: Delta) => boolean
): Promise<number> {
  while (performance.now() - start < 10_000) {
    const hit = deltas.find(({ at, delta }) => at >= start && match(delta));
    if (hit) return Math.round(hit.at - start);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`no live-query delta for ${label}`);
}

const checks: Record<string, unknown> = {};
try {
  await rpc('liveQuery.subscribe', {
    queryName: 'sessions.list',
    params: [0],
    subscriptionId: 'verify-sessions',
  });
  checks.snapshotRows = (snapshot as Row[] | null)?.length ?? null;

  const workspacePath = mkdtempSync(join(tmpdir(), 'hn-session-write-'));
  const creating = performance.now();
  const created = (await rpc('session.create', { workspacePath, worktreeMode: 'direct' })) as {
    sessionId: string;
  };
  const sessionId = created.sessionId;
  checks.sessionId = sessionId;
  checks.createdDeltaMs = await waitFor('create', creating, (delta) =>
    (delta.added ?? []).some((row) => row.id === sessionId)
  );

  const title = `Renamed ${Date.now()}`;
  const updating = performance.now();
  await rpc('session.update', { sessionId, title });
  checks.updateReplyMs = Math.round(performance.now() - updating);
  checks.updatedDeltaMs = await waitFor('update', updating, (delta) =>
    (delta.updated ?? []).some((row) => row.id === sessionId && row.title === title)
  );
  const read = (await rpc('session.get', { sessionId })) as { session?: Row };
  checks.readBackTitle = read.session?.title;
  if (read.session?.title !== title) throw new Error('session.get did not return the new title');

  const archiving = performance.now();
  await rpc('session.archive', { sessionId, confirmed: true });
  checks.archivedDeltaMs = await waitFor('archive', archiving, (delta) =>
    (delta.removed ?? []).some((row) => row.id === sessionId)
  );
  checks.result = 'pass';
} catch (error) {
  checks.result = 'fail';
  checks.error = error instanceof Error ? error.message : String(error);
} finally {
  ws.close();
  mkdirSync(join(run, 'evidence'), { recursive: true });
  writeFileSync(
    join(run, 'evidence', 'session-write-live-query.json'),
    JSON.stringify({ checks, deltas }, null, 1)
  );
  console.log(JSON.stringify(checks, null, 1));
}
process.exit(checks.result === 'pass' ? 0 : 1);
