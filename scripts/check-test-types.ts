#!/usr/bin/env bun

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const BASELINE_PATH = join(import.meta.dir, 'test-types-baseline.json');
const ERROR_LINE = /^(.+?)\(\d+,\d+\): error TS\d+:/;

export function countTscErrors(output: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const line of output.split('\n')) {
    const match = ERROR_LINE.exec(line);
    if (match) counts[match[1]] = (counts[match[1]] ?? 0) + 1;
  }
  return counts;
}

export function compareTestTypes(
  baseline: Record<string, number>,
  counts: Record<string, number>
): { failed: boolean; lines: string[] } {
  const lines: string[] = [];
  for (const file of [...new Set([...Object.keys(baseline), ...Object.keys(counts)])].sort()) {
    const before = baseline[file] ?? 0;
    const after = counts[file] ?? 0;
    if (after > before) lines.push(`REGRESSION ${file}: ${before} -> ${after}`);
    else if (after < before)
      lines.push(
        `STALE BASELINE ${file}: ${before} -> ${after} (commit the tightened baseline with --write-baseline)`
      );
  }
  return { failed: lines.length > 0, lines };
}

function runTypecheck(): Record<string, number> {
  const result = Bun.spawnSync(
    [
      'bun',
      'node_modules/typescript7/bin/tsc',
      '-p',
      'packages/daemon/tsconfig.tests.json',
      '--noEmit',
      '--pretty',
      'false',
    ],
    { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' }
  );
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;
  const counts = countTscErrors(output);
  if (result.exitCode !== 0 && Object.keys(counts).length === 0) {
    process.stdout.write(output);
    throw new Error(`tsc exited ${result.exitCode} without reporting type errors`);
  }
  return counts;
}

function loadBaseline(): Record<string, number> {
  const parsed: unknown = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  return (parsed as { files: Record<string, number> }).files;
}

async function main(): Promise<void> {
  const counts = runTypecheck();
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  if (process.argv.includes('--write-baseline')) {
    const files: Record<string, number> = {};
    for (const file of Object.keys(counts).sort()) files[file] = counts[file];
    await Bun.write(BASELINE_PATH, `${JSON.stringify({ files }, null, 2)}\n`);
    process.stdout.write(`baseline written: ${total} test type errors\n`);
    return;
  }
  const baseline = loadBaseline();
  const { failed, lines } = compareTestTypes(baseline, counts);
  for (const line of lines) process.stdout.write(`${line}\n`);
  const baselineTotal = Object.values(baseline).reduce((sum, n) => sum + n, 0);
  process.stdout.write(`test type errors: ${total} (baseline ${baselineTotal})\n`);
  if (failed) process.exit(1);
}

if (import.meta.main) {
  await main();
}
