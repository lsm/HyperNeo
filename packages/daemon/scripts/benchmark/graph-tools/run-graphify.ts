/**
 * Graphify benchmark arm.
 *
 * Usage:
 *   bun scripts/benchmark/graph-tools/run-graphify.ts
 */

import { existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import {
  BENCHMARK_PROMPT_UNSEDED,
  runWithGlm,
  writeBenchmarkResults,
  resolveCommitSha,
  WORKTREE,
  BENCHMARK_MODEL,
} from './benchmark-helpers';

const GRAPHIFY_OUT =
  process.env.NEOKAI_BENCHMARK_GRAPHIFY_OUT ||
  `/tmp/neokai-benchmark-graphify/${createHash('sha256').update(WORKTREE).digest('hex')}`;
const GRAPHIFY_BIN = process.env.NEOKAI_BENCHMARK_GRAPHIFY_BIN || 'graphify';
const GRAPHIFY_BACKEND = process.env.NEOKAI_BENCHMARK_GRAPHIFY_BACKEND || 'ollama';

function resolveGraphifyPython(): { python: string; args: string[] } {
  let resolvedBin = GRAPHIFY_BIN;
  try {
    resolvedBin = execFileSync('which', [GRAPHIFY_BIN], { encoding: 'utf-8' }).trim();
  } catch {
    // Not on PATH
  }
  try {
    const firstLine = readFileSync(resolvedBin, 'utf-8').split('\n')[0];
    if (!firstLine.startsWith('#!')) {
      console.log('  Graphify binary is not a script (no shebang), using python3 fallback');
      return { python: 'python3', args: [] };
    }
    const shebang = firstLine.replace(/^#!\s*/, '').trim();
    const parts = shebang.split(/\s+/);
    if (parts[0].endsWith('/env') && parts.length > 1) {
      return { python: parts[0], args: parts.slice(1) };
    }
    return { python: parts[0], args: [] };
  } catch {
    return { python: 'python3', args: [] };
  }
}

function setupGraphify(): boolean {
  const commitSha = resolveCommitSha();
  const graphJson = join(GRAPHIFY_OUT, 'graph.json');

  // Check cache
  if (existsSync(graphJson) && existsSync(join(GRAPHIFY_OUT, '.benchmark_worktree'))) {
    const cachedWorktree = readFileSync(join(GRAPHIFY_OUT, '.benchmark_worktree'), 'utf-8').trim();
    const cachedCommit = existsSync(join(GRAPHIFY_OUT, '.benchmark_commit'))
      ? readFileSync(join(GRAPHIFY_OUT, '.benchmark_commit'), 'utf-8').trim()
      : '';
    const cachedBackend = existsSync(join(GRAPHIFY_OUT, '.benchmark_backend'))
      ? readFileSync(join(GRAPHIFY_OUT, '.benchmark_backend'), 'utf-8').trim()
      : '';
    if (
      cachedWorktree === WORKTREE &&
      cachedCommit === commitSha &&
      cachedBackend === GRAPHIFY_BACKEND
    ) {
      console.log('  Graphify graph cached, skipping extraction');
      return true;
    }
    console.log('  Graphify cache stale, rebuilding...');
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
    writeFileSync(join(GRAPHIFY_OUT, '.benchmark_worktree'), WORKTREE);
    writeFileSync(join(GRAPHIFY_OUT, '.benchmark_commit'), commitSha);
    writeFileSync(join(GRAPHIFY_OUT, '.benchmark_backend'), GRAPHIFY_BACKEND);
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

  const { python, args: pythonArgs } = resolveGraphifyPython();

  console.log('Running Graphify arm');
  const start = Date.now();
  const result = await runWithGlm({
    name: 'Graphify',
    prompt: BENCHMARK_PROMPT_UNSEDED,
    tools: [],
    allowedTools: ['mcp__graphify__*'],
    mcpServers: {
      graphify: {
        command: python,
        args: [...pythonArgs, '-m', 'graphify.serve', join(GRAPHIFY_OUT, 'graph.json')],
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
