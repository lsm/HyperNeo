import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const baselinePath = 'scripts/db-main-thread-baseline.json';
const workers = new Set([
  'lib/db-query/db-query-worker.ts',
  'lib/message-search-worker.ts',
  'lib/message-search-merge-worker.ts',
  'lib/event-loop-watchdog-worker.ts',
  'lib/neo/project-mirror-worker.ts',
  'storage/db-gateway/db-gateway-worker.ts',
  'storage/repositories/google-connections-worker.ts',
  'storage/repositories/agent-memory-embed-worker.ts',
  'storage/sdk-message-body-admission-worker.ts',
  'storage/sdk-message-body-backup-worker.ts',
  'storage/sdk-status-worker.ts',
]);
const patterns = {
  prepare: /\.prepare\s*\(/g,
  transaction: /\.transaction\s*\(/g,
  exec: /\.exec\s*\(/g,
  query: /\.query\s*\(/g,
  run: /\.run\s*\(/g,
  open: /\bnew\s+(?:Database|DatabaseSync)\s*\(/g,
};
type Counts = Record<keyof typeof patterns, number>;

function parseBaseline(text: string): Counts {
  const value = JSON.parse(text);
  if (
    !value ||
    Object.keys(value).length !== Object.keys(patterns).length ||
    Object.keys(patterns).some((key) => !Number.isSafeInteger(value[key]) || value[key] < 0)
  ) {
    throw new Error('Invalid DB main-thread baseline');
  }
  return value;
}

function count(root: string): Counts {
  const counts: Counts = { prepare: 0, transaction: 0, exec: 0, query: 0, run: 0, open: 0 };
  const walk = (dir: string, prefix = '') => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = prefix + entry.name;
      if (path === 'storage/schema' || workers.has(path)) continue;
      if (entry.isDirectory()) walk(join(dir, entry.name), `${path}/`);
      else if (/\.tsx?$/.test(path)) {
        const text = readFileSync(join(dir, entry.name), 'utf8');
        for (const key of Object.keys(patterns) as Array<keyof Counts>) {
          counts[key] += [...text.matchAll(patterns[key])].length;
        }
      }
    }
  };
  walk(join(root, 'packages/daemon/src'));
  return counts;
}

const root = resolve(process.argv[2] ?? join(import.meta.dir, '..'));
const base = process.argv[3] ?? process.env.DB_RATCHET_BASE ?? 'origin/dev';
try {
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], { cwd: root });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString();
  };
  const baseline = parseBaseline(readFileSync(join(root, baselinePath), 'utf8'));
  const previous = git('ls-tree', base, '--', baselinePath).trim()
    ? parseBaseline(git('show', `${base}:${baselinePath}`))
    : null;
  const counts = count(root);
  let failed = false;
  for (const key of Object.keys(patterns) as Array<keyof Counts>) {
    console.log(`${key}: ${counts[key]} (baseline ${baseline[key]})`);
    if (previous && baseline[key] > previous[key]) {
      console.error(`baseline ${key} may only decrease (${previous[key]} -> ${baseline[key]})`);
      failed = true;
    }
    if (counts[key] > baseline[key]) {
      console.error(`${key}: ${counts[key]} > baseline ${baseline[key]}`);
      failed = true;
    }
  }
  process.exitCode = failed ? 1 : 0;
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
}
