import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';

const SCRIPTS_DIR = import.meta.dir;

const ARMS = [
  'run-baseline.ts',
  'run-codegraph.ts',
  'run-crg.ts',
  'run-graphify.ts',
  'run-ast-grep.ts',
];

const OUTPUT_FILES = [
  '/tmp/graph-tool-benchmark-baseline.json',
  '/tmp/graph-tool-benchmark-codegraph.json',
  '/tmp/graph-tool-benchmark-crg.json',
  '/tmp/graph-tool-benchmark-graphify.json',
  '/tmp/graph-tool-benchmark-ast-grep.json',
];

console.log('=== Graph Tool Benchmark: All Arms ===\n');

for (const file of OUTPUT_FILES) {
  if (existsSync(file)) {
    unlinkSync(file);
    console.log(`  Removed stale: ${file}`);
  }
}

let failures = 0;

for (const script of ARMS) {
  const scriptPath = join(SCRIPTS_DIR, script);
  console.log(`\n>>> ${script}`);
  try {
    execFileSync('bun', [scriptPath], {
      stdio: 'inherit',
      timeout: 900_000,
      env: { ...process.env },
    });
  } catch (err) {
    console.error(`  FAILED: ${script}`);
    failures++;
  }
}

console.log('\n\n=== Collecting Results ===');
interface BenchmarkOutput {
  timestamp: string;
  hyperneoCommit: string;
  model: string;
  results: Array<{
    caseName: string;
    wallTimeMs: number;
    totalTokens: number;
    toolCallCount: number;
    responseLength: number;
  }>;
}

const allResults: BenchmarkOutput['results'] = [];
let model = '';
let commit = '';

for (const file of OUTPUT_FILES) {
  if (!existsSync(file)) {
    console.log(`  SKIP: ${file} not found`);
    continue;
  }
  try {
    const data: BenchmarkOutput = JSON.parse(readFileSync(file, 'utf-8'));
    model = data.model;
    commit = data.hyperneoCommit;
    allResults.push(...data.results);
    console.log(`  Loaded: ${data.results[0]?.caseName ?? 'unknown'}`);
  } catch (err) {
    console.error(`  Error reading ${file}: ${(err as Error).message}`);
  }
}

if (allResults.length > 0) {
  console.log(`\n=== Benchmark Summary (model: ${model}, commit: ${commit}) ===`);
  console.log(
    'Case'.padEnd(40) + 'Wall(s)'.padStart(8) + 'Tokens'.padStart(10) + 'Tools'.padStart(8)
  );
  for (const r of allResults) {
    console.log(
      r.caseName.padEnd(40) +
        (r.wallTimeMs / 1000).toFixed(1).padStart(8) +
        String(r.totalTokens).padStart(10) +
        String(r.toolCallCount).padStart(8)
    );
  }
}

if (failures > 0) {
  console.log(`\n${failures} arm(s) failed.`);
  process.exit(1);
}
