/**
 * Benchmark helpers for graph tool comparison.
 *
 * Uses Claude Agent SDK directly (no daemon) with GLM provider routing
 * via environment variables. Each benchmark arm isolates its target tool
 * by setting `tools: []` to disable all built-ins.
 *
 * Must be importable from `bun test` without special loaders.
 */

import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { query } from '@anthropic-ai/claude-agent-sdk';

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export const BENCHMARK_PROMPT_UNSEDED =
	`We need to improve NeoKai's Space task/workflow runtime so stuck or idle task agents do not loop forever or spam operators.

Current behavior: when task agents appear idle, blocked, waiting, or completed, the system can emit many task/workflow events to the Space Agent. These events are noisy and do not reliably recover stuck work. Successful workflow completions can also create notification noise. Real stuck tasks can retry or wait repeatedly until a human manually intervenes.

Desired behavior:

1. Detect when a task agent is genuinely stuck rather than temporarily waiting.
   - Idle for more than a configured threshold with no useful progress.
   - Repeated idle/non-terminal states for the same task.
   - Waiting too long for tool, session, or workflow progress.
   - Workflow run exceeds a configured wall-clock timeout.

2. Track enough state to make recovery decisions.
   - Last useful message/progress timestamp.
   - Current agent/workflow/task state.
   - Pending tool or external-event activity if available.
   - Consecutive stuck/idle count.
   - Recovery attempts, retry count, and escalation history.

3. Apply recovery based on autonomy level.
   - Low autonomy: notify or ask a human before destructive action.
   - Medium autonomy: retry/nudge with backoff and caps.
   - High autonomy: automatically retry, reassign, or escalate after limits.

4. Prevent retry loops.
   - Max consecutive retries.
   - Max total retries.
   - Exponential backoff.
   - Clear terminal failure/escalation state when recovery fails.

5. Reduce event noise.
   - Do not notify operators for successful workflow completions unless required for audit/debug mode.
   - Rate-limit idle/stuck notifications.
   - Notify only for actionable or critical events.
   - Keep full internal logs/events for debugging even when notifications are suppressed.

Produce an implementation plan with:
- key files to inspect or modify,
- data flow,
- likely existing abstractions to reuse,
- new modules or types if needed,
- migration/storage implications if any,
- tests to add or update,
- risks and edge cases,
- estimated change scope.` as const;

/**
 * Text-only variant for the baseline test.  Instructs the model to respond
 * without using any tools — required because GLM's tool_use responses are
 * incompatible with the Claude Agent SDK's context-fetcher when no tools
 * are available for the SDK to execute.
 */
export const BENCHMARK_PROMPT_TEXT_ONLY = (BENCHMARK_PROMPT_UNSEDED +
	`

IMPORTANT: Respond with text only. Do NOT use any tools (no Bash, Read, Write, Glob, Grep, or any other tool). Produce your plan based on your understanding of typical agent runtime architectures.`) as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BenchmarkResult {
	caseName: string;
	wallTimeMs: number;
	totalTokens: number;
	inputTokens: number;
	outputTokens: number;
	toolCallCount: number;
	toolCalls: Array<{ name: string; count: number }>;
	responseText: string;
	responseLength: number;
	sessionId: string;
}

export interface BenchmarkOutput {
	timestamp: string;
	neokaiCommit: string;
	model: string;
	worktreePath: string;
	results: BenchmarkResult[];
}

export interface BenchmarkCaseOptions {
	name: string;
	/** Absolute path to the workspace/repo */
	cwd: string;
	prompt: string;
	/** MCP servers to attach. Baseline passes empty/undefined. */
	mcpServers?: Record<string, { command: string; args?: string[] }>;
	/**
	 * Built-in tools to make available. Use `[]` to disable all built-ins
	 * and force MCP-only usage. Omit for default tool set.
	 */
	tools?: string[];
}

// ---------------------------------------------------------------------------
// GLM provider env var helpers
// ---------------------------------------------------------------------------

const GLM_ENV_VARS = [
	'ANTHROPIC_AUTH_TOKEN',
	'ANTHROPIC_BASE_URL',
	'API_TIMEOUT_MS',
	'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
	'ANTHROPIC_DEFAULT_HAIKU_MODEL',
	'ANTHROPIC_DEFAULT_SONNET_MODEL',
	'ANTHROPIC_DEFAULT_OPUS_MODEL',
] as const;

/** Set GLM routing env vars. Returns originals for restoration. */
export function setGlmEnvVars(apiKey: string, model: string): Map<string, string | undefined> {
	const originals = new Map<string, string | undefined>();
	for (const key of GLM_ENV_VARS) {
		originals.set(key, process.env[key]);
	}

	process.env.ANTHROPIC_AUTH_TOKEN = apiKey;
	process.env.ANTHROPIC_BASE_URL = 'https://open.bigmodel.cn/api/anthropic';
	process.env.API_TIMEOUT_MS = '3000000';
	process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
	process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
	process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
	process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;

	return originals;
}

/** Restore env vars from a previous setGlmEnvVars call. */
export function restoreEnvVars(originals: Map<string, string | undefined>): void {
	for (const [key, value] of originals.entries()) {
		if (value !== undefined) {
			process.env[key] = value;
		} else {
			delete process.env[key];
		}
	}
}

// ---------------------------------------------------------------------------
// SDK message parsing
// ---------------------------------------------------------------------------

/** Count tool_use blocks across all SDK messages. */
export function extractToolCalls(messages: Array<Record<string, unknown>>): Map<string, number> {
	const counts = new Map<string, number>();
	for (const msg of messages) {
		if ((msg as { type?: string }).type !== 'assistant') continue;
		const content = (msg as { message?: { content?: unknown[] } }).message?.content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			const b = block as { type?: string; name?: string };
			if (b.type === 'tool_use' && b.name) {
				counts.set(b.name, (counts.get(b.name) || 0) + 1);
			}
		}
	}
	return counts;
}

/** Extract concatenated assistant text from SDK messages. */
export function extractResponseText(messages: Array<Record<string, unknown>>): string {
	const parts: string[] = [];
	for (const msg of messages) {
		if ((msg as { type?: string }).type !== 'assistant') continue;
		const content = (msg as { message?: { content?: unknown[] } }).message?.content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			const b = block as { type?: string; text?: string };
			if (b.type === 'text' && b.text) {
				parts.push(b.text);
			}
		}
	}
	return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Run a single benchmark case using the Claude Agent SDK directly.
 *
 * Caller must set GLM env vars before calling and restore after.
 * Uses `query()` from the SDK with the provided MCP servers and tool config.
 */
export async function runBenchmarkCase(options: BenchmarkCaseOptions): Promise<BenchmarkResult> {
	const { name, cwd, prompt, mcpServers, tools } = options;

	const startMs = Date.now();
	// Build SDK options — only include `tools` when explicitly set.
	// Omitting `tools` uses SDK defaults; passing `[]` disables all built-ins.
	const sdkOptions: Record<string, unknown> = {
		model: 'default',
		cwd,
		permissionMode: 'bypassPermissions',
		allowDangerouslySkipPermissions: true,
		settingSources: [],
		mcpServers: mcpServers ?? {},
		strictMcpConfig: true,
		maxTurns: 20,
	};
	if (tools !== undefined) {
		sdkOptions.tools = tools;
	}
	const agentQuery = query({
		prompt,
		options: sdkOptions as Parameters<typeof query>[0]['options'],
	});

	const sdkMessages: Array<Record<string, unknown>> = [];
	let resultUsage: { inputTokens: number; outputTokens: number } | undefined;
	let sessionId = '';

	for await (const msg of agentQuery) {
		sdkMessages.push(msg as Record<string, unknown>);

		if ((msg as { type?: string }).type === 'result') {
			const result = msg as {
				usage?: { inputTokens: number; outputTokens: number };
				session_id?: string;
			};
			resultUsage = result.usage;
			sessionId = result.session_id ?? '';
			break;
		}
	}

	const wallTimeMs = Date.now() - startMs;

	const toolCallMap = extractToolCalls(sdkMessages);
	const responseText = extractResponseText(sdkMessages);

	const toolCalls = Array.from(toolCallMap.entries()).map(([toolName, count]) => ({
		name: toolName,
		count,
	}));

	return {
		caseName: name,
		wallTimeMs,
		totalTokens: (resultUsage?.inputTokens ?? 0) + (resultUsage?.outputTokens ?? 0),
		inputTokens: resultUsage?.inputTokens ?? 0,
		outputTokens: resultUsage?.outputTokens ?? 0,
		toolCallCount: toolCalls.reduce((sum, t) => sum + t.count, 0),
		toolCalls,
		responseText,
		responseLength: responseText.length,
		sessionId,
	};
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export function writeBenchmarkResults(
	results: BenchmarkResult[],
	worktreePath: string,
	outputPath?: string,
	commitSha?: string,
	model?: string
): string {
	const output: BenchmarkOutput = {
		timestamp: new Date().toISOString(),
		neokaiCommit: commitSha ?? 'unknown',
		model: model ?? process.env.NEOKAI_BENCHMARK_MODEL ?? 'glm-4.7',
		worktreePath,
		results,
	};
	const path = outputPath ?? '/tmp/graph-tool-benchmark-results.json';
	writeFileSync(path, JSON.stringify(output, null, 2));
	return path;
}

// ---------------------------------------------------------------------------
// ast-grep MCP server wrapper (stdio JSON-RPC)
// ---------------------------------------------------------------------------

/**
 * Generate a minimal stdio MCP server script that wraps `ast-grep run`.
 * Follows the pattern from anthropic-to-copilot-bridge-provider.test.ts.
 */
export function makeAstGrepMcpServerScript(workspacePath: string): string {
	return `
const { spawnSync } = require('child_process');
const rl = require('readline').createInterface({ input: process.stdin, terminal: false });
const WORKSPACE = ${JSON.stringify(workspacePath)};
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params = {} } = msg;
  if (method === 'initialize') {
    write({ jsonrpc: '2.0', id, result: {
      protocolVersion: params.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'ast-grep-wrapper', version: '1.0.0' }
    }});
  } else if (method === 'notifications/initialized') {
    // fire-and-forget, no response
  } else if (method === 'tools/list') {
    write({ jsonrpc: '2.0', id, result: { tools: [
      {
        name: 'ast_grep_search',
        description: 'Run ast-grep structural search over the workspace. Returns JSON matches. Use --pattern for AST patterns or literal string search.',
        inputSchema: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Search pattern (AST pattern or string literal)' },
            lang: { type: 'string', description: 'Language (ts, tsx, js, py, etc.). Default: ts' },
          },
          required: ['pattern'],
        },
      },
      {
        name: 'ast_grep_search_multiple',
        description: 'Run multiple ast-grep searches and combine results. Pass comma-separated patterns.',
        inputSchema: {
          type: 'object',
          properties: {
            patterns: { type: 'string', description: 'Comma-separated search patterns' },
            lang: { type: 'string', description: 'Language. Default: ts' },
          },
          required: ['patterns'],
        },
      },
    ]}});
  } else if (method === 'tools/call') {
    const toolName = params.name;
    const args = params.arguments || {};
    try {
      let result;
      if (toolName === 'ast_grep_search') {
        result = runAstGrep(args.pattern, args.lang || 'ts');
      } else if (toolName === 'ast_grep_search_multiple') {
        const patterns = (args.patterns || '').split(',').map(s => s.trim()).filter(Boolean);
        const parts = patterns.map(p => ({ pattern: p, output: runAstGrep(p, args.lang || 'ts') }));
        result = JSON.stringify(parts);
      } else {
        write({ jsonrpc: '2.0', id, result: {
          content: [{ type: 'text', text: 'Unknown tool: ' + toolName }], isError: true
        }});
        return;
      }
      write({ jsonrpc: '2.0', id, result: {
        content: [{ type: 'text', text: result }], isError: false
      }});
    } catch (err) {
      write({ jsonrpc: '2.0', id, result: {
        content: [{ type: 'text', text: 'Error: ' + (err.message || String(err)) }], isError: true
      }});
    }
  } else if (id !== undefined) {
    write({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' }});
  }
});
function runAstGrep(pattern, lang) {
  const r = spawnSync('npx', ['-y', '-p', '@ast-grep/cli', 'ast-grep', 'run',
    '--pattern', pattern, '--lang', lang, '--json', WORKSPACE],
    { timeout: 60000, maxBuffer: 10 * 1024 * 1024, encoding: 'utf-8' });
  // ast-grep uses exit code 1 for "no matches found" — treat as empty result, not error
  if (r.status === 1) return '(no matches)';
  if (r.status !== 0) throw new Error(r.stderr || 'ast-grep exited with code ' + r.status);
  return r.stdout || '(no output)';
}
function write(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
`.trim();
}
