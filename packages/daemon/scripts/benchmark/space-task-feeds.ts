import { Database } from 'bun:sqlite';
import { LiveQueryEngine } from '../../src/storage/live-query';
import { setupLiveQueryHandlers } from '../../src/lib/rpc-handlers/live-query-handlers';
import { createSessionCounters } from '../../src/storage/schema/session-counters';
import type { TableChangeScope } from '../../src/storage/reactive-database';

const FEEDS = [
  { name: 'spaceTaskMessages.byTask.compact', shown: 'task thread' },
  { name: 'spaceTaskActivity.byTask', shown: 'task thread' },
  { name: 'spaceTaskActiveTurn.byTask', shown: 'task thread' },
  { name: 'taskMilestones.byTask', shown: 'Timeline tab' },
];
const WRITES = Number(process.env.BENCH_WRITES ?? 5);
const SETTLE_MS = 400;
const TASK_SIZES = [3_000, 12_000, Infinity];

type Listener = (data: { tables: string[]; scope?: TableChangeScope }) => void;

function stubReactive() {
  let listener: Listener | null = null;
  const versions: Record<string, number> = {};
  return {
    on: (_event: 'change', cb: Listener) => {
      listener = cb;
    },
    off: () => {
      listener = null;
    },
    getTableVersion: (table: string) => versions[table] ?? 0,
    fire: (tables: string[], scope?: TableChangeScope) => {
      for (const table of tables) versions[table] = (versions[table] ?? 0) + 1;
      listener?.({ tables, scope });
    },
  };
}

function stubHub() {
  const handlers = new Map<string, (data: unknown, context: unknown) => unknown>();
  const router = {
    sendToClientDetailed: () => ({ ok: true, current: 0, limit: 0 }),
    sendToClient: () => {},
    releaseClientSubscription: () => {},
    addClientSubscription: () => {},
    checkSubscriptionCapacity: () => ({ ok: true, current: 0, limit: 1000 }),
  };
  return {
    handlers,
    onRequest: (method: string, handler: (data: unknown, context: unknown) => unknown) =>
      handlers.set(method, handler),
    getRouter: () => router,
    onClientDisconnect: () => {},
  };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const median = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
};

function pickTasks(db: Database): Array<{ taskId: string; messages: number }> {
  if (process.env.BENCH_TASK_ID) {
    const row = db
      .query('SELECT COUNT(*) AS c FROM sdk_messages WHERE task_id = ?')
      .get(process.env.BENCH_TASK_ID) as { c: number };
    return [{ taskId: process.env.BENCH_TASK_ID, messages: row.c }];
  }
  const tasks = db
    .query(
      'SELECT task_id AS taskId, COUNT(*) AS messages FROM sdk_messages WHERE task_id IS NOT NULL GROUP BY task_id ORDER BY messages DESC'
    )
    .all() as Array<{ taskId: string; messages: number }>;
  const picked = TASK_SIZES.map(
    (size) => tasks.find((task) => task.messages <= size) ?? null
  ).filter((task): task is { taskId: string; messages: number } => task !== null);
  return [...new Map(picked.map((task) => [task.taskId, task])).values()].sort(
    (a, b) => a.messages - b.messages
  );
}

async function main() {
  const dbPath = process.env.BENCH_DB_PATH ?? process.argv[2];
  if (!dbPath) {
    console.error('usage: bun packages/daemon/scripts/benchmark/space-task-feeds.ts <db-copy>');
    console.error('subscribes the Space task feeds and replays scoped message writes; use a copy');
    process.exit(1);
  }
  const db = new Database(dbPath);
  createSessionCounters(db as never);
  const reactive = stubReactive();
  const engine = new LiveQueryEngine(db as never, reactive as never);
  const hub = stubHub();
  setupLiveQueryHandlers(hub as never, engine, db as never);

  const internals = engine as unknown as {
    queries: Map<string, unknown>;
    evaluateQuery: (key: string) => void;
  };
  const labels = new Map<string, string>();
  const samples = new Map<string, number[]>();
  const evaluate = internals.evaluateQuery.bind(engine);
  internals.evaluateQuery = (key: string) => {
    const start = performance.now();
    evaluate(key);
    const label = labels.get(key);
    if (label) samples.get(label)?.push(performance.now() - start);
  };

  const subscribe = hub.handlers.get('liveQuery.subscribe')!;
  const unsubscribe = hub.handlers.get('liveQuery.unsubscribe')!;
  const context = { clientId: 'bench-client', sessionId: undefined };

  console.log(`db: ${dbPath}`);
  console.log(`${WRITES} scoped sdk_messages writes per task, ${SETTLE_MS}ms settle each\n`);
  for (const task of pickTasks(db)) {
    labels.clear();
    for (const feed of FEEDS) {
      const before = new Set(internals.queries.keys());
      await subscribe(
        { queryName: feed.name, params: [task.taskId], subscriptionId: `bench-${feed.name}` },
        context
      );
      for (const key of internals.queries.keys()) if (!before.has(key)) labels.set(key, feed.name);
      samples.set(feed.name, []);
    }
    for (let write = 0; write < WRITES; write++) {
      reactive.fire(['sdk_messages'], { taskId: task.taskId });
      await wait(SETTLE_MS);
    }
    console.log(`task ${task.taskId} (${task.messages} messages)`);
    let mounted = 0;
    for (const feed of FEEDS) {
      const runs = samples.get(feed.name) ?? [];
      const ms = median(runs);
      if (feed.shown !== 'not mounted') mounted += ms;
      console.log(
        `  ${feed.name.padEnd(34)} ${ms.toFixed(1).padStart(8)} ms median of ${runs.length}, first ${(runs[0] ?? 0).toFixed(1)} ms  (${feed.shown})`
      );
    }
    console.log(
      `  ${'per write, feeds on screen'.padEnd(34)} ${mounted.toFixed(1).padStart(8)} ms\n`
    );
    for (const feed of FEEDS) {
      await unsubscribe({ subscriptionId: `bench-${feed.name}` }, context);
    }
  }
  engine.dispose();
  db.close();
}

await main();
