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

const GRAPHIFY_BIN = process.env.HYPERNEO_BENCHMARK_GRAPHIFY_BIN || 'graphify';
const GRAPHIFY_BACKEND = process.env.HYPERNEO_BENCHMARK_GRAPHIFY_BACKEND || 'ollama';

function checkGraphifyServe(python: string): boolean {
  try {
    execFileSync(python, ['-c', 'import graphify.serve'], { encoding: 'utf-8' });
    return true;
  } catch {
    return false;
  }
}

function resolveGraphifyPython(): string {
  const env = process.env.HYPERNEO_BENCHMARK_GRAPHIFY_PYTHON;
  if (env) {
    if (!checkGraphifyServe(env)) {
      console.error(
        `Error: HYPERNEO_BENCHMARK_GRAPHIFY_PYTHON (${env}) does not have graphify.serve. ` +
          'Install with: pip install "graphifyy[mcp]"'
      );
      process.exit(1);
    }
    return env;
  }

  const candidates: string[] = [];

  try {
    const bin = execFileSync('which', [GRAPHIFY_BIN], { encoding: 'utf-8' }).trim();
    const first = readFileSync(bin, 'utf-8').split('\n')[0];
    if (first.startsWith('#!')) {
      const shebang = first.replace(/^#!\s*/, '').trim();
      const parts = shebang.split(/\s+/);
      const python = parts[0].endsWith('/env') && parts.length > 1 ? parts[1] : parts[0];
      try {
        const r = execFileSync(python, ['-c', 'import sys; print(sys.executable)'], {
          encoding: 'utf-8',
        });
        if (r.trim()) candidates.push(r.trim());
      } catch {
        candidates.push(python);
      }
    }
  } catch {
    // fall through
  }

  candidates.push('python3');

  for (const python of candidates) {
    if (checkGraphifyServe(python)) return python;
  }

  console.error(
    'Error: Could not find a Python interpreter with graphify.serve.\n' +
      'Install the MCP extra: pip install "graphifyy[mcp]"\n' +
      'Or set HYPERNEO_BENCHMARK_GRAPHIFY_PYTHON to the correct python path.'
  );
  process.exit(1);
}

const GRAPHIFY_PYTHON = resolveGraphifyPython();

const GRAPHIFY_OUT =
  process.env.HYPERNEO_BENCHMARK_GRAPHIFY_OUT ||
  `/tmp/hyperneo-benchmark-graphify/${createHash('sha256')
    .update(WORKTREE + '\0' + GRAPHIFY_BACKEND)
    .digest('hex')}`;

function getGraphifyVersion(): string {
  try {
    return execFileSync(GRAPHIFY_BIN, ['--version'], { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

function isWorktreeDirty(): boolean {
  try {
    const status = execFileSync('git', ['status', '--porcelain'], {
      encoding: 'utf-8',
      cwd: WORKTREE,
    }).trim();
    return status.length > 0;
  } catch {
    return false;
  }
}

function setupGraphify(): boolean {
  const commitSha = resolveCommitSha();
  const graphJson = join(GRAPHIFY_OUT, 'graphify-out', 'graph.json');
  const markerFile = join(GRAPHIFY_OUT, '.benchmark_marker');
  const marker = JSON.stringify({
    commit: commitSha,
    dirty: isWorktreeDirty(),
    graphifyVersion: getGraphifyVersion(),
    backend: GRAPHIFY_BACKEND,
  });

  if (existsSync(graphJson) && existsSync(markerFile)) {
    try {
      const cached = JSON.parse(readFileSync(markerFile, 'utf-8'));
      if (
        cached.commit === commitSha &&
        cached.dirty === false &&
        cached.graphifyVersion === getGraphifyVersion() &&
        cached.backend === GRAPHIFY_BACKEND
      ) {
        console.log('  Graphify graph cached, skipping extraction');
        return true;
      }
      if (cached.commit !== commitSha) {
        console.log('  Graphify cache stale (commit changed), rebuilding...');
      } else if (cached.dirty !== false) {
        console.log('  Graphify cache stale (dirty worktree), rebuilding...');
      } else if (cached.graphifyVersion !== getGraphifyVersion()) {
        console.log('  Graphify cache stale (graphify version changed), rebuilding...');
      } else {
        console.log('  Graphify cache stale (backend changed), rebuilding...');
      }
    } catch {
      console.log('  Graphify cache marker corrupt, rebuilding...');
    }
  } else if (existsSync(graphJson)) {
    console.log('  Graphify graph found but no marker, rebuilding...');
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
    writeFileSync(markerFile, marker);
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
