/**
 * Benchmark helpers for graph tool comparison.
 *
 * Uses Claude Agent SDK directly (no daemon) with GLM provider routing
 * via environment variables. MCP-only arms use `tools: []` to disable
 * all built-ins; the baseline arm uses built-in Read/Grep/Glob only.
 */

import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execSync, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { query } from '@anthropic-ai/claude-agent-sdk';

// ---------------------------------------------------------------------------
// Shared config
// ---------------------------------------------------------------------------

/** Resolve the repo root (5 levels up from this file). */
export const WORKTREE =
  process.env.NEOKAI_BENCHMARK_WORKTREE || join(import.meta.dir, '..', '..', '..', '..', '..');

/** GLM model to benchmark. Default: glm-5.1. */
export const BENCHMARK_MODEL = process.env.NEOKAI_BENCHMARK_MODEL || 'glm-5.1';

/** Get git commit SHA. */
export function resolveCommitSha(): string {
  return execSync('git rev-parse HEAD', { encoding: 'utf-8', cwd: WORKTREE }).trim();
}

/** GLM API key from env. */
export function getGlmApiKey(): string {
  const key = process.env.GLM_API_KEY || process.env.ZHIPU_API_KEY || '';
  if (!key) {
    console.error('Error: GLM_API_KEY or ZHIPU_API_KEY must be set');
    process.exit(1);
  }
  return key;
}

/** Run a benchmark case with GLM env vars set/restored. */
export async function runWithGlm(
  options: Omit<BenchmarkCaseOptions, 'cwd'>
): Promise<BenchmarkResult> {
  const apiKey = getGlmApiKey();
  const envVars = setGlmEnvVars(apiKey, BENCHMARK_MODEL);
  try {
    return await runBenchmarkCase({ ...options, cwd: WORKTREE });
  } finally {
    restoreEnvVars(envVars);
  }
}

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
  /**
   * Tool name patterns to auto-approve (e.g. ["mcp__codegraph__*"]).
   * Required for MCP tools — without this, the model sees them but
   * cannot call them, even with bypassPermissions.
   */
  allowedTools?: string[];
}

// ---------------------------------------------------------------------------
// GLM provider env var helpers
// ---------------------------------------------------------------------------

const GLM_ENV_VARS = [
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
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

  // Clear ANTHROPIC_API_KEY to prevent SDK from using wrong credential source
  delete process.env.ANTHROPIC_API_KEY;
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

/** Extract text from the final assistant message only (excludes interim narration). */
export function extractResponseText(messages: Array<Record<string, unknown>>): string {
  // Find the last assistant message — that's the final answer
  let lastAssistantContent: unknown[] | null = null;
  for (const msg of messages) {
    if ((msg as { type?: string }).type !== 'assistant') continue;
    const content = (msg as { message?: { content?: unknown[] } }).message?.content;
    if (Array.isArray(content)) {
      lastAssistantContent = content;
    }
  }
  if (!lastAssistantContent) return '';
  const parts: string[] = [];
  for (const block of lastAssistantContent) {
    const b = block as { type?: string; text?: string };
    if (b.type === 'text' && b.text) {
      parts.push(b.text);
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
  const { name, cwd, prompt, mcpServers, tools, allowedTools } = options;

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
    maxTurns: 40,
  };
  if (tools !== undefined) {
    sdkOptions.tools = tools;
  }
  if (allowedTools && allowedTools.length > 0) {
    sdkOptions.allowedTools = allowedTools;
  }
  const agentQuery = query({
    prompt,
    options: sdkOptions as Parameters<typeof query>[0]['options'],
  });

  const sdkMessages: Array<Record<string, unknown>> = [];
  let resultUsage:
    | { input_tokens: number; output_tokens: number; [key: string]: unknown }
    | undefined;
  let sessionId = '';
  let resultText = '';
  let gotResult = false;

  for await (const msg of agentQuery) {
    sdkMessages.push(msg as Record<string, unknown>);

    if ((msg as { type?: string }).type === 'result') {
      const result = msg as {
        subtype?: string;
        usage?: { input_tokens: number; output_tokens: number; [key: string]: unknown };
        session_id?: string;
        result?: string;
      };
      // Accept max_turns (model was actively working) - record partial data.
      // Reject other errors (auth, execution failures).
      if (
        result.subtype !== undefined &&
        result.subtype !== 'success' &&
        result.subtype !== 'error_max_turns'
      ) {
        throw new Error(
          `Benchmark case "${name}" ended with non-success subtype: ${result.subtype}. ` +
            'Run is contaminated and cannot be used for comparison.'
        );
      }
      if (result.subtype === 'error_max_turns') {
        console.warn(`  Warning: "${name}" hit max turns, recording partial data.`);
      }
      resultUsage = result.usage;
      sessionId = result.session_id ?? '';
      resultText = result.result ?? '';
      gotResult = true;
      break;
    }
  }

  // Fail fast if stream ended without a result message (interrupted/incomplete run)
  if (!gotResult) {
    throw new Error(
      `Benchmark case "${name}" ended without a result message — ` +
        'SDK stream terminated early. Run cannot be used for comparison.'
    );
  }

  const wallTimeMs = Date.now() - startMs;

  const toolCallMap = extractToolCalls(sdkMessages);
  const streamedText = extractResponseText(sdkMessages);
  // Use streamed text if available, fall back to result message text
  const responseText = streamedText || resultText;

  const toolCalls = Array.from(toolCallMap.entries()).map(([toolName, count]) => ({
    name: toolName,
    count,
  }));

  return {
    caseName: name,
    wallTimeMs,
    totalTokens: (resultUsage?.input_tokens ?? 0) + (resultUsage?.output_tokens ?? 0),
    inputTokens: resultUsage?.input_tokens ?? 0,
    outputTokens: resultUsage?.output_tokens ?? 0,
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
 * Generate a stdio MCP server script wrapping ast-grep CLI.
 *
 * @param workspacePath   Repo root to search
 * @param astGrepBin      Absolute path to pre-resolved ast-grep binary,
 *                        or 'npx' to fall back to per-call npx invocation
 */
export function makeAstGrepMcpServerScript(workspacePath: string, astGrepBin: string): string {
  // When astGrepBin is 'npx', use npx-based invocation with the full package prefix
  const useNpx = astGrepBin === 'npx';
  const binExpr = JSON.stringify(astGrepBin);
  const npxRunPrefix = useNpx ? `['npx', '-y', '-p', '@ast-grep/cli', 'ast-grep']` : `[${binExpr}]`;
  const npxScanPrefix = npxRunPrefix;
  return `
const { spawnSync } = require('child_process');
const rl = require('readline').createInterface({ input: process.stdin, terminal: false });
const WORKSPACE = ${JSON.stringify(workspacePath)};
const USE_NPX = ${useNpx};
const BIN = ${binExpr};
const SPAWN_OPTS = { timeout: 60000, maxBuffer: 10 * 1024 * 1024, encoding: 'utf-8' };
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params = {} } = msg;
  if (method === 'initialize') {
    write({ jsonrpc: '2.0', id, result: {
      protocolVersion: params.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'ast-grep-wrapper', version: '1.1.0' }
    }});
  } else if (method === 'notifications/initialized') {
    // fire-and-forget
  } else if (method === 'tools/list') {
    write({ jsonrpc: '2.0', id, result: { tools: [
      {
        name: 'ast_grep_search',
        description: 'Run ast-grep structural pattern search. Uses AST-aware matching — $VAR matches any expression, $$$ARGS matches multiple. Returns JSON matches.',
        inputSchema: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'AST pattern (e.g. "console.log($ARG)", "async function $NAME() { $$$BODY }")' },
            lang: { type: 'string', description: 'Language (ts, tsx, js, py, etc.). Default: ts' },
          },
          required: ['pattern'],
        },
      },
      {
        name: 'ast_grep_scan',
        description: 'Run ast-grep structural scan with a YAML rule. Supports relational queries (inside, has, precedes, follows) and composite logic (all, any, not). More powerful than ast_grep_search for complex structural queries.',
        inputSchema: {
          type: 'object',
          properties: {
            rule: { type: 'string', description: 'YAML rule string. Required fields: id, language, rule. Example: "id: async-await\\nlanguage: javascript\\nrule:\\n  kind: function_declaration\\n  has:\\n    pattern: await $EXPR\\n    stopBy: end"' },
            lang: { type: 'string', description: 'Language override (optional — rule usually specifies it). Default: ts' },
          },
          required: ['rule'],
        },
      },
      {
        name: 'ast_grep_search_multiple',
        description: 'Run multiple ast-grep pattern searches and combine results. Pass comma-separated patterns.',
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
      } else if (toolName === 'ast_grep_scan') {
        result = runAstGrepScan(args.rule);
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
function astGrepCmd(subArgs) {
  if (USE_NPX) return ['npx', '-y', '-p', '@ast-grep/cli', 'ast-grep', ...subArgs];
  return [BIN, ...subArgs];
}
function runAstGrep(pattern, lang) {
  const cmd = astGrepCmd(['run', '--pattern', pattern, '--lang', lang, '--json', WORKSPACE]);
  const r = spawnSync(cmd[0], cmd.slice(1), SPAWN_OPTS);
  if (r.status === 1) return '(no matches)';
  if (r.status !== 0) throw new Error(r.stderr || 'ast-grep exited with code ' + r.status);
  return r.stdout || '(no output)';
}
function runAstGrepScan(rule) {
  const cmd = astGrepCmd(['scan', '--inline-rules', rule, '--json', WORKSPACE]);
  const r = spawnSync(cmd[0], cmd.slice(1), SPAWN_OPTS);
  // ast-grep scan: exit 0 = no matches or only warning matches, exit 1 = error-severity rule matched
  // Either way, return stdout (contains JSON matches or empty array) — only fail on crash (exit 2+)
  if (r.status !== 0 && r.status !== 1) throw new Error(r.stderr || 'ast-grep scan exited with code ' + r.status);
  return r.stdout || '(no output)';
}
function write(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
`.trim();
}
