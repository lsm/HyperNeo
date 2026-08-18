import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import {
  BENCHMARK_PROMPT_UNSEDED,
  runWithGlm,
  writeBenchmarkResults,
  resolveCommitSha,
  WORKTREE,
  BENCHMARK_MODEL,
  makeAstGrepMcpServerScript,
} from './benchmark-helpers';

function resolveAstGrep(): { bin: string | null; serverPath: string } {
  console.log('Resolving ast-grep CLI...');
  const resolveStart = Date.now();
  let astGrepBin: string | null = null;

  try {
    astGrepBin = execFileSync('which', ['ast-grep'], { encoding: 'utf-8' }).trim();
  } catch {
    try {
      const p = Bun.spawnSync(['npx', '-y', '-p', '@ast-grep/cli', 'ast-grep', '--version'], {
        timeout: 120_000,
        stdout: 'pipe',
        stderr: 'pipe',
        encoding: 'utf-8',
      });
      if (p.exitCode === 0) {
        astGrepBin = execFileSync(
          'node',
          [
            '-e',
            `const p=require('child_process').spawnSync('npx',['-y','-p','@ast-grep/cli','which','ast-grep'],{encoding:'utf-8'});process.stdout.write(p.stdout.trim())`,
          ],
          { encoding: 'utf-8' }
        ).trim();
        if (!astGrepBin || !existsSync(astGrepBin)) {
          astGrepBin = null;
        }
      }
    } catch {
      // Fall through
    }
  }

  const resolveMs = Date.now() - resolveStart;
  if (astGrepBin) {
    console.log(`  ast-grep resolved to ${astGrepBin} (${(resolveMs / 1000).toFixed(1)}s)`);
  } else {
    console.log(
      `  ast-grep binary not found, will use npx fallback (${(resolveMs / 1000).toFixed(1)}s)`
    );
  }

  const effectiveBin = astGrepBin ?? 'npx';
  const script = makeAstGrepMcpServerScript(WORKTREE, effectiveBin);
  const uniqueId = randomUUID().slice(0, 8);
  const tmpPath = join(tmpdir(), `ast-grep-mcp-${uniqueId}.js`);
  writeFileSync(tmpPath, script);
  console.log(`  ast-grep MCP server wrapper written to ${tmpPath}`);

  return { bin: astGrepBin, serverPath: tmpPath };
}

async function main() {
  const { bin: astGrepBin, serverPath } = resolveAstGrep();
  if (!astGrepBin) {
    console.log('  Warning: ast-grep using npx fallback, wall time may be inflated');
  }

  console.log('Running ast-grep arm');
  const start = Date.now();
  const result = await runWithGlm({
    name: 'ast-grep',
    prompt: BENCHMARK_PROMPT_UNSEDED,
    tools: [],
    allowedTools: ['mcp__ast-grep__*'],
    mcpServers: {
      'ast-grep': {
        command: 'node',
        args: [serverPath],
      },
    },
  });
  console.log(`  Done in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  console.log(`  Tokens: ${result.totalTokens} | Tool calls: ${result.toolCallCount}`);
  console.log(`  Response: ${result.responseLength} chars`);

  const path = '/tmp/graph-tool-benchmark-ast-grep.json';
  writeBenchmarkResults([result], WORKTREE, path, resolveCommitSha(), BENCHMARK_MODEL);
  console.log(`  Results written to ${path}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
