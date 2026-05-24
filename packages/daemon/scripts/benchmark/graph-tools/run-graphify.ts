/**
 * Graphify benchmark arm.
 *
 * Usage:
 *   bun scripts/benchmark/graph-tools/run-graphify.ts
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import {
  BENCHMARK_PROMPT_UNSEDED,
  runWithGlm,
  writeBenchmarkResults,
  resolveCommitSha,
  WORKTREE,
  BENCHMARK_MODEL,
} from './benchmark-helpers';

const GRAPHIFY_BIN = process.env.NEOKAI_BENCHMARK_GRAPHIFY_BIN || 'graphify';
const GRAPHIFY_BACKEND = process.env.NEOKAI_BENCHMARK_GRAPHIFY_BACKEND || 'ollama';

/** Discover the Python interpreter that has graphify installed. */
function resolveGraphifyPython(): string {
  const env = process.env.NEOKAI_BENCHMARK_GRAPHIFY_PYTHON;
  if (env) return env;

  // Try reading shebang from graphify binary
  try {
    const bin = execFileSync('which', [GRAPHIFY_BIN], { encoding: 'utf-8' }).trim();
    const first = readFileSync(bin, 'utf-8').split('\n')[0];
    if (first.startsWith('#!')) {
      const shebang = first.replace(/^#!\s*/, '').trim();
      const parts = shebang.split(/\s+/);
      const python = parts[0].endsWith('/env') && parts.length > 1 ? parts[1] : parts[0];
      const r = execFileSync(python, ['-c', 'import graphify; import sys; print(sys.executable)'], {
        encoding: 'utf-8',
      });
      if (r.trim()) return r.trim();
    }
  } catch {
    // fall through
  }

  // Try python3
  try {
    const r = execFileSync(
      'python3',
      ['-c', 'import graphify; import sys; print(sys.executable)'],
      { encoding: 'utf-8' }
    );
    if (r.trim()) return r.trim();
  } catch {
    // fall through
  }

  console.error(
    'Error: Could not find a Python interpreter with graphify installed.\n' +
      'Set NEOKAI_BENCHMARK_GRAPHIFY_PYTHON to the correct python path.'
  );
  process.exit(1);
}

const GRAPHIFY_PYTHON = resolveGraphifyPython();

/** Cache dir includes worktree + backend so switching backends invalidates cache. */
const GRAPHIFY_OUT =
  process.env.NEOKAI_BENCHMARK_GRAPHIFY_OUT ||
  `/tmp/neokai-benchmark-graphify/${createHash('sha256')
    .update(WORKTREE + '\0' + GRAPHIFY_BACKEND)
    .digest('hex')}`;

function setupGraphify(): boolean {
  const commitSha = resolveCommitSha();
  const graphJson = join(GRAPHIFY_OUT, 'graphify-out', 'graph.json');
  const commitFile = join(GRAPHIFY_OUT, '.benchmark_commit');

  if (existsSync(graphJson) && existsSync(commitFile)) {
    const cachedCommit = readFileSync(commitFile, 'utf-8').trim();
    if (cachedCommit === commitSha) {
      console.log('  Graphify graph cached, skipping extraction');
      return true;
    }
    console.log('  Graphify cache stale (commit changed), rebuilding...');
  } else if (existsSync(graphJson)) {
    console.log('  Graphify graph found but no commit marker, rebuilding...');
  }

  console.log('Extracting Graphify graph...');
  const start = Date.now();
  mkdirSync(GRAPHIFY_OUT, { recursive: true });
  let p: Bun.SpawnSyncResult<Buffer>;
  try {
    p = Bun.spawnSync(
      [
        GRAPHIFY_BIN,
        'extract',
        WORKTREE,
        '--out',
        GRAPHIFY_OUT,
        '--no-cluster',
        '--backend',
        GRAPHIFY_BACKEND,
      ],
      { timeout: 300_000, stdout: 'pipe', stderr: 'pipe' }
    );
  } catch (err) {
    console.error('  Graphify extraction skipped (executable not found):', (err as Error).message);
    return false;
  }
  const elapsed = Date.now() - start;
  if (p.exitCode === 0 && existsSync(graphJson)) {
    writeFileSync(commitFile, commitSha);
    console.log(`  Graphify graph extracted in ${(elapsed / 1000).toFixed(1)}s`);
    return true;
  }
  console.error(
    '  Graphify extraction failed (exit=' + p.exitCode + '):',
    p.stderr?.toString()?.slice(0, 500)
  );
  return false;
}

async function main() {
  if (!setupGraphify()) {
    console.error('Graphify graph not available, aborting.');
    process.exit(1);
  }

  const graphJson = join(GRAPHIFY_OUT, 'graphify-out', 'graph.json');

  console.log('Running Graphify arm');
  const start = Date.now();
  const result = await runWithGlm({
    name: 'Graphify',
    prompt: BENCHMARK_PROMPT_UNSEDED,
    tools: [],
    allowedTools: ['mcp__graphify__*'],
    mcpServers: {
      graphify: {
        command: GRAPHIFY_PYTHON,
        args: ['-m', 'graphify.serve', graphJson],
      },
    },
  });
  console.log(`  Done in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  console.log(`  Tokens: ${result.totalTokens} | Tool calls: ${result.toolCallCount}`);
  console.log(`  Response: ${result.responseLength} chars`);

  const path = '/tmp/graph-tool-benchmark-graphify.json';
  writeBenchmarkResults([result], WORKTREE, path, resolveCommitSha(), BENCHMARK_MODEL);
  console.log(`  Results written to ${path}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
