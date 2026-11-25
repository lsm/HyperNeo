import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const baselinePath = 'scripts/get-database-baseline.json';
const pattern = /\bgetDatabase\s*\(/g;

function parseBaseline(text: string): number {
  const value = JSON.parse(text);
  if (
    !value ||
    Object.keys(value).length !== 1 ||
    !Number.isSafeInteger(value.getDatabase) ||
    value.getDatabase < 0
  ) {
    throw new Error('Invalid getDatabase baseline');
  }
  return value.getDatabase;
}

function count(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += count(path);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      total += [...readFileSync(path, 'utf8').matchAll(pattern)].length;
    }
  }
  return total;
}

const update = process.argv.includes('--update');
const [rootArg, baseArg] = process.argv.slice(2).filter((arg) => arg !== '--update');
const root = resolve(rootArg ?? join(import.meta.dir, '..'));
const base = baseArg ?? process.env.DB_RATCHET_BASE ?? 'origin/dev';
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
  const current = count(join(root, 'packages/daemon/src'));
  console.log(`getDatabase: ${current} (baseline ${baseline})`);
  const errors: string[] = [];
  if (previous !== null && baseline > previous) {
    errors.push(`baseline may only decrease (${previous} -> ${baseline})`);
  }
  if (current > baseline) errors.push(`getDatabase: ${current} > baseline ${baseline}`);
  else if (current < baseline && update) {
    writeFileSync(
      join(root, baselinePath),
      `${JSON.stringify({ getDatabase: current }, null, 2)}\n`
    );
    console.log(`baseline lowered to ${current}`);
  } else if (current < baseline) {
    errors.push(
      `lower the baseline to ${current}: run bun run check:get-database --update and commit ${baselinePath}`
    );
  }
  for (const error of errors) console.error(error);
  process.exitCode = errors.length ? 1 : 0;
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
}
