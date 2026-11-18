import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { countPipelineRoutes, readRepositorySources, type PipelineCounts } from './system-map.ts';

const baselinePath = 'scripts/pipeline-ratchet-baseline.json';
const keys = ['missing', 'misnamed', 'dynamic', 'unreadable'] as const;
const update = process.argv.includes('--update');
const [rootArg, baseArg] = process.argv.slice(2).filter((arg) => arg !== '--update');
const root = resolve(rootArg ?? join(import.meta.dir, '..'));
const base = baseArg ?? process.env.DB_RATCHET_BASE ?? 'origin/dev';

function parseBaseline(text: string): PipelineCounts {
  const value: unknown = JSON.parse(text);
  if (
    !value ||
    typeof value !== 'object' ||
    Object.keys(value).length !== keys.length ||
    keys.some(
      (key) =>
        !Object.hasOwn(value, key) ||
        !Number.isSafeInteger(Reflect.get(value, key)) ||
        Reflect.get(value, key) < 0
    )
  ) {
    throw new Error('Invalid pipeline ratchet baseline');
  }
  return value as PipelineCounts;
}

try {
  const baseline = parseBaseline(readFileSync(join(root, baselinePath), 'utf8'));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], { cwd: root });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString();
  };
  const previous = git('ls-tree', base, '--', baselinePath).trim()
    ? parseBaseline(git('show', `${base}:${baselinePath}`))
    : null;
  const sources = readRepositorySources(root, true);
  const current = countPipelineRoutes(sources);
  let failed = false;
  for (const key of keys) {
    console.log(`${key}: ${current[key]} (baseline ${baseline[key]})`);
    if (previous && baseline[key] > previous[key]) {
      console.error(`${key}: baseline may only decrease (${previous[key]} -> ${baseline[key]})`);
      failed = true;
    }
    if (current[key] > baseline[key]) {
      console.error(`${key}: ${current[key]} > baseline ${baseline[key]}`);
      failed = true;
    } else if (current[key] < baseline[key] && !update) {
      console.error(
        `${key}: lower the baseline to ${current[key]} with bun run check:pipeline-ratchet --update`
      );
      failed = true;
    }
  }
  if (update && !failed) {
    writeFileSync(join(root, baselinePath), `${JSON.stringify(current, null, 2)}\n`);
  }
  process.exitCode = failed ? 1 : 0;
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
}
