import {
  BENCHMARK_PROMPT_UNSEDED,
  runWithGlm,
  writeBenchmarkResults,
  resolveCommitSha,
  WORKTREE,
  BENCHMARK_MODEL,
} from './benchmark-helpers';

const CODEGRAPH_PROMPT =
  BENCHMARK_PROMPT_UNSEDED +
  `

---

You have access to a CodeGraph MCP server with rich graph-analysis tools.
Use them aggressively to explore the codebase. Preferred order:

1. ​codegraph_context​ — PRIMARY tool. Give it the task description; it returns
   entry points, related symbols, and key code in ONE call. Use this first.
2. ​codegraph_explore​ — When you need source for several related symbols at once.
   More efficient than multiple codegraph_node calls.
3. ​codegraph_impact​ — To understand blast radius of a proposed change.
   Pass the symbol name and desired depth (1-3).
4. ​codegraph_trace​ — To trace data flow between two symbols (from → to).
5. ​codegraph_callers​ / ​codegraph_callees​ — For call-graph navigation.
6. ​codegraph_search​ — Quick symbol lookup by name when you know what to look for.
7. ​codegraph_node​ — Get full details for a single symbol (use explore instead for groups).
8. ​codegraph_files​ — Browse indexed file structure.

Do NOT rely on a single search call. Explore the graph deeply.
`;

function buildCodeGraphIndex(): boolean {
  console.log('Building CodeGraph index...');
  const start = Date.now();
  let p: Bun.SpawnSyncResult<Buffer>;
  try {
    p = Bun.spawnSync(['npx', '-y', '@colbymchenry/codegraph', 'init', WORKTREE, '-i'], {
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch (err) {
    console.error('  CodeGraph build skipped (executable not found):', (err as Error).message);
    return false;
  }
  const elapsed = Date.now() - start;
  if (p.exitCode === 0) {
    console.log(`  CodeGraph index built in ${(elapsed / 1000).toFixed(1)}s`);
    return true;
  }
  console.error('  CodeGraph build failed:', p.stderr?.toString()?.slice(0, 500));
  return false;
}

async function main() {
  if (!buildCodeGraphIndex()) {
    console.error('CodeGraph index not available, aborting.');
    process.exit(1);
  }

  console.log('Running CodeGraph-v2 arm (enhanced prompt)');
  const start = Date.now();
  const result = await runWithGlm({
    name: 'CodeGraph-v2',
    prompt: CODEGRAPH_PROMPT,
    tools: [],
    allowedTools: ['mcp__codegraph__*'],
    mcpServers: {
      codegraph: {
        command: 'npx',
        args: ['-y', '@colbymchenry/codegraph', 'serve', '--mcp'],
      },
    },
  });
  console.log(`  Done in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  console.log(`  Tokens: ${result.totalTokens} | Tool calls: ${result.toolCallCount}`);
  console.log(`  Response: ${result.responseLength} chars`);

  const path = '/tmp/graph-tool-benchmark-codegraph-v2.json';
  writeBenchmarkResults([result], WORKTREE, path, resolveCommitSha(), BENCHMARK_MODEL);
  console.log(`  Results written to ${path}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
