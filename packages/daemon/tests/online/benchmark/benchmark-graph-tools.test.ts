/**
 * Graph Tool Benchmark — Direct SDK Integration Test
 *
 * Compares CodeGraph, code-review-graph, Graphify, and ast-grep against a plain
 * GLM baseline for task #394 ("Refactor task event source as Layer-2 anti-stuck
 * mechanism"). Uses the Claude Agent SDK directly with MCP tool servers attached.
 * No daemon required — GLM provider routing via environment variables.
 *
 * REQUIREMENTS:
 *   - GLM_API_KEY or ZHIPU_API_KEY must be set
 *   - npx, uvx, and python available in PATH
 *
 * Run:
 *   cd packages/daemon
 *   NEOKAI_BENCHMARK_RUN=1 bun test tests/online/benchmark/benchmark-graph-tools.test.ts
 *
 * Run single case:
 *   bun test -t 'CodeGraph' tests/online/benchmark/benchmark-graph-tools.test.ts
 *
 * This entire suite is `describe.skip` by default — it makes real API calls,
 * takes 10-20 minutes, and requires manual opt-in via NEOKAI_BENCHMARK_RUN=1.
 * Not included in CI.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, execSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';

import {
	BENCHMARK_PROMPT_UNSEDED,
	runBenchmarkCase,
	writeBenchmarkResults,
	makeAstGrepMcpServerScript,
	setGlmEnvVars,
	restoreEnvVars,
	type BenchmarkResult,
} from './benchmark-helpers';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const WORKTREE =
	process.env.NEOKAI_BENCHMARK_WORKTREE ||
	// Default: the repo root (5 levels up from this file's directory)
	join(import.meta.dir, '..', '..', '..', '..', '..');

const BENCHMARK_MODEL = process.env.NEOKAI_BENCHMARK_MODEL || 'glm-4.7';

const CRG_DATA_DIR = process.env.NEOKAI_BENCHMARK_CRG_DATA || '/tmp/neokai-benchmark-crg';

// SHA-256 hex digest of worktree path — fixed 64-char length, collision-resistant
const GRAPHIFY_OUT =
	process.env.NEOKAI_BENCHMARK_GRAPHIFY_OUT ||
	`/tmp/neokai-benchmark-graphify/${createHash('sha256').update(WORKTREE).digest('hex')}`;

const CRG_TOOLS =
	'get_minimal_context_tool,get_review_context_tool,get_impact_radius_tool,query_graph_tool,semantic_search_nodes_tool,list_graph_stats_tool,detect_changes_tool';

const RESULTS_PATH = '/tmp/graph-tool-benchmark-results.json';

// Defer heavy resolution until benchmark is enabled to avoid failing unrelated test runs
let COMMIT_SHA = '';
const GRAPHIFY_BIN = process.env.NEOKAI_BENCHMARK_GRAPHIFY_BIN || 'graphify';
const GRAPHIFY_BACKEND = process.env.NEOKAI_BENCHMARK_GRAPHIFY_BACKEND || 'ollama';
let graphifyPython = 'python3';
let graphifyPythonArgs: string[] = [];

function resolveConfig() {
	COMMIT_SHA = execSync('git rev-parse HEAD', { encoding: 'utf-8', cwd: WORKTREE }).trim();

	// Resolve Graphify python env (same executable used for extraction and MCP serve)
	// Always try PATH resolution first, fall back to absolute path.
	let resolvedBin = GRAPHIFY_BIN;
	try {
		resolvedBin = execFileSync('which', [GRAPHIFY_BIN], { encoding: 'utf-8' }).trim();
	} catch {
		// Not on PATH — assume it's an absolute path
	}
	try {
		const firstLine = readFileSync(resolvedBin, 'utf-8').split('\n')[0];
		// Validate: must start with #! to be a shebang script, not a binary
		if (!firstLine.startsWith('#!')) {
			console.log('  Graphify binary is not a script (no shebang), using python3 fallback');
		} else {
			const shebang = firstLine.replace(/^#!\s*/, '').trim();
			// Handle env-style shebangs: "#!/usr/bin/env python3" -> command=env, args=[python3]
			// Direct shebangs: "#!/path/to/python3" -> command=/path/to/python3, args=[]
			const parts = shebang.split(/\s+/);
			if (parts[0].endsWith('/env') && parts.length > 1) {
				graphifyPython = parts[0];
				graphifyPythonArgs = parts.slice(1);
			} else {
				graphifyPython = parts[0];
			}
		}
	} catch {
		// Fall back to python3
	}
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const results: BenchmarkResult[] = [];

// Tool readiness flags
let codegraphReady = false;
let crgReady = false;
let graphifyReady = false;
let astGrepBin: string | null = null;
let astGrepServerPath: string | null = null;

// ---------------------------------------------------------------------------
// Tool setup helpers
// ---------------------------------------------------------------------------

function buildCodeGraph() {
	console.log('Building CodeGraph index...');
	const start = Date.now();
	const p = Bun.spawnSync(['npx', '-y', '@colbymchenry/codegraph', 'init', WORKTREE, '-i'], {
		timeout: 120_000,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const elapsed = Date.now() - start;
	if (p.exitCode === 0) {
		codegraphReady = true;
		console.log(`  CodeGraph index built in ${(elapsed / 1000).toFixed(1)}s`);
	} else {
		console.error('  CodeGraph build failed:', p.stderr?.toString()?.slice(0, 500));
	}
}

function buildCRG() {
	console.log('Building code-review-graph...');
	const start = Date.now();
	const p = Bun.spawnSync(
		[
			'uvx',
			'--from',
			'code-review-graph',
			'code-review-graph',
			'build',
			'--repo',
			WORKTREE,
			'--data-dir',
			CRG_DATA_DIR,
		],
		{ timeout: 300_000, stdout: 'pipe', stderr: 'pipe' }
	);
	const elapsed = Date.now() - start;
	if (p.exitCode === 0) {
		crgReady = true;
		console.log(`  CRG graph built in ${(elapsed / 1000).toFixed(1)}s`);
	} else {
		console.error('  CRG build failed:', p.stderr?.toString()?.slice(0, 500));
	}
}

function setupGraphify() {
	const graphJson = join(GRAPHIFY_OUT, 'graph.json');

	// Verify cache belongs to current worktree AND commit AND backend - rebuild if stale
	if (existsSync(graphJson) && existsSync(join(GRAPHIFY_OUT, '.benchmark_worktree'))) {
		const cachedWorktree = readFileSync(join(GRAPHIFY_OUT, '.benchmark_worktree'), 'utf-8').trim();
		const cachedCommit = existsSync(join(GRAPHIFY_OUT, '.benchmark_commit'))
			? readFileSync(join(GRAPHIFY_OUT, '.benchmark_commit'), 'utf-8').trim()
			: '';
		const cachedBackend = existsSync(join(GRAPHIFY_OUT, '.benchmark_backend'))
			? readFileSync(join(GRAPHIFY_OUT, '.benchmark_backend'), 'utf-8').trim()
			: '';
		if (cachedWorktree !== WORKTREE) {
			console.log('  Graphify graph is from a different worktree, forcing rebuild...');
		} else if (cachedCommit && cachedCommit === COMMIT_SHA && cachedBackend === GRAPHIFY_BACKEND) {
			// Same worktree, commit, and backend - keep cached graph
			graphifyReady = true;
			console.log(
				'  Graphify graph already exists for this worktree@commit@backend, skipping extraction'
			);
			return;
		} else {
			console.log('  Graphify graph commit/backend mismatch, forcing rebuild...');
		}
	}

	console.log('Extracting Graphify graph...');
	const start = Date.now();
	mkdirSync(GRAPHIFY_OUT, { recursive: true });
	const p = Bun.spawnSync(
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
	const elapsed = Date.now() - start;
	if (p.exitCode === 0 && existsSync(graphJson)) {
		// Tag the cache with worktree + commit + backend for staleness detection
		writeFileSync(join(GRAPHIFY_OUT, '.benchmark_worktree'), WORKTREE);
		writeFileSync(join(GRAPHIFY_OUT, '.benchmark_commit'), COMMIT_SHA);
		writeFileSync(join(GRAPHIFY_OUT, '.benchmark_backend'), GRAPHIFY_BACKEND);
		graphifyReady = true;
		console.log(`  Graphify graph extracted in ${(elapsed / 1000).toFixed(1)}s`);
	} else {
		console.error(
			'  Graphify extraction failed (exit=' + p.exitCode + '):',
			p.stderr?.toString()?.slice(0, 500)
		);
	}
}

function setupAstGrep() {
	// Resolve ast-grep binary once — avoids per-call npx overhead
	console.log('Resolving ast-grep CLI...');
	const resolveStart = Date.now();
	try {
		// Prefer pre-installed binary on PATH
		astGrepBin = execFileSync('which', ['ast-grep'], { encoding: 'utf-8' }).trim();
	} catch {
		// Fall back to npx install
		try {
			const p = Bun.spawnSync(['npx', '-y', '-p', '@ast-grep/cli', 'ast-grep', '--version'], {
				timeout: 120_000,
				stdout: 'pipe',
				stderr: 'pipe',
				encoding: 'utf-8',
			});
			if (p.exitCode === 0) {
				// npx caches the package; find the resolved binary
				astGrepBin = execFileSync(
					'node',
					[
						'-e',
						`const p=require('child_process').spawnSync('npx',['-y','-p','@ast-grep/cli','which','ast-grep'],{encoding:'utf-8'});process.stdout.write(p.stdout.trim())`,
					],
					{ encoding: 'utf-8' }
				).trim();
				// If that didn't work, fall back to npx-based invocation
				if (!astGrepBin || !existsSync(astGrepBin)) {
					astGrepBin = null;
				}
			}
		} catch {
			// Will fall through to npx fallback below
		}
	}
	const resolveMs = Date.now() - resolveStart;
	if (astGrepBin) {
		console.log(`  ast-grep resolved to ${astGrepBin} (${(resolveMs / 1000).toFixed(1)}s)`);
	} else {
		// Last resort: use npx as the binary — still cached but has bootstrap cost
		astGrepBin = null;
		console.log(
			`  ast-grep binary not found, will use npx fallback (${(resolveMs / 1000).toFixed(1)}s)`
		);
	}

	// Generate MCP server script with unique temp path per run
	const effectiveBin = astGrepBin ?? 'npx';
	const script = makeAstGrepMcpServerScript(WORKTREE, effectiveBin);
	const uniqueId = randomUUID().slice(0, 8);
	const tmpPath = join(tmpdir(), `ast-grep-mcp-${uniqueId}.js`);
	writeFileSync(tmpPath, script);
	astGrepServerPath = tmpPath;
	console.log(`  ast-grep MCP server wrapper written to ${tmpPath}`);
}

// ---------------------------------------------------------------------------
// Helper: run case with GLM env vars
// ---------------------------------------------------------------------------

const GLM_API_KEY = process.env.GLM_API_KEY || process.env.ZHIPU_API_KEY || '';

async function runWithGlm(
	options: Omit<import('./benchmark-helpers').BenchmarkCaseOptions, 'cwd'>
): Promise<BenchmarkResult> {
	const envVars = setGlmEnvVars(GLM_API_KEY, BENCHMARK_MODEL);
	try {
		return await runBenchmarkCase({ ...options, cwd: WORKTREE });
	} finally {
		restoreEnvVars(envVars);
	}
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

// Toggle: set to true to enable benchmark (makes real API calls, 10-20 min)
const ENABLE_BENCHMARK = process.env.NEOKAI_BENCHMARK_RUN === '1';
const describeSkip = ENABLE_BENCHMARK ? describe : describe.skip;

describeSkip('Graph Tool Benchmark', () => {
	beforeAll(() => {
		// Validate credentials
		if (!process.env.GLM_API_KEY && !process.env.ZHIPU_API_KEY) {
			throw new Error('GLM_API_KEY or ZHIPU_API_KEY must be set');
		}

		resolveConfig();
		console.log(`Worktree: ${WORKTREE}`);
		console.log(`Commit: ${COMMIT_SHA}`);

		// Build tool indexes before running cases
		// Note: build helpers use Bun.spawnSync internally so they run sequentially.
		console.log('Building tool indexes...');
		buildCodeGraph();
		buildCRG();
		setupGraphify();
		setupAstGrep();
	}, 420_000);

	afterAll(() => {
		// Write results
		if (results.length > 0) {
			const path = writeBenchmarkResults(
				results,
				WORKTREE,
				RESULTS_PATH,
				COMMIT_SHA,
				BENCHMARK_MODEL
			);
			console.log(`\nResults written to ${path}`);
			// Print summary table
			console.log('\n=== Benchmark Summary ===');
			console.log(
				'Case'.padEnd(40) + 'Wall(s)'.padStart(8) + 'Tokens'.padStart(10) + 'Tools'.padStart(8)
			);
			for (const r of results) {
				console.log(
					r.caseName.padEnd(40) +
						(r.wallTimeMs / 1000).toFixed(1).padStart(8) +
						String(r.totalTokens).padStart(10) +
						String(r.toolCallCount).padStart(8)
				);
			}
		}
	}, 30_000);

	// -----------------------------------------------------------------------
	// Benchmark arms
	// -----------------------------------------------------------------------

	test('baseline: built-in Read/Grep/Glob only', async () => {
		const result = await runWithGlm({
			name: 'baseline: built-in Read/Grep/Glob only',
			prompt: BENCHMARK_PROMPT_UNSEDED,
			// Built-in file exploration tools, no MCP servers
			tools: ['Read', 'Grep', 'Glob'],
		});
		results.push(result);
		expect(result.responseText.length).toBeGreaterThan(100);
	}, 420_000);

	test('CodeGraph', async () => {
		if (!codegraphReady) return expect.unreachable('CodeGraph index not built');
		const result = await runWithGlm({
			name: 'CodeGraph',
			prompt: BENCHMARK_PROMPT_UNSEDED,
			// Only CodeGraph MCP available — no built-in tools
			tools: [],
			allowedTools: ['mcp__codegraph__*'],
			mcpServers: {
				codegraph: {
					command: 'npx',
					args: ['-y', '@colbymchenry/codegraph', 'mcp'],
				},
			},
		});
		results.push(result);
		expect(result.responseText.length).toBeGreaterThan(100);
	}, 420_000);

	test('code-review-graph', async () => {
		if (!crgReady) return expect.unreachable('CRG graph not built');
		const result = await runWithGlm({
			name: 'code-review-graph',
			prompt: BENCHMARK_PROMPT_UNSEDED,
			tools: [],
			allowedTools: ['mcp__code-review-graph__*'],
			mcpServers: {
				'code-review-graph': {
					command: 'uvx',
					args: [
						'--from',
						'code-review-graph',
						'code-review-graph',
						'serve',
						'--repo',
						WORKTREE,
						'--data-dir',
						CRG_DATA_DIR,
						'--tools',
						CRG_TOOLS,
					],
				},
			},
		});
		results.push(result);
		expect(result.responseText.length).toBeGreaterThan(100);
	}, 420_000);

	test('Graphify', async () => {
		if (!graphifyReady) return expect.unreachable('Graphify graph not extracted');
		const result = await runWithGlm({
			name: 'Graphify',
			prompt: BENCHMARK_PROMPT_UNSEDED,
			tools: [],
			allowedTools: ['mcp__graphify__*'],
			mcpServers: {
				graphify: {
					command: graphifyPython,
					args: [...graphifyPythonArgs, '-m', 'graphify.serve', join(GRAPHIFY_OUT, 'graph.json')],
				},
			},
		});
		results.push(result);
		expect(result.responseText.length).toBeGreaterThan(100);
	}, 420_000);

	test('ast-grep', async () => {
		if (!astGrepServerPath) return expect.unreachable('ast-grep setup failed (binary or wrapper)');
		if (!astGrepBin)
			console.log('  Warning: ast-grep using npx fallback, wall time may be inflated');
		const result = await runWithGlm({
			name: 'ast-grep',
			prompt: BENCHMARK_PROMPT_UNSEDED,
			tools: [],
			allowedTools: ['mcp__ast-grep__*'],
			mcpServers: {
				'ast-grep': {
					command: 'node',
					args: [astGrepServerPath],
				},
			},
		});
		results.push(result);
		expect(result.responseText.length).toBeGreaterThan(100);
	}, 420_000);
});
