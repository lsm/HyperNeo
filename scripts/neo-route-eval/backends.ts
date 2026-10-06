import { query } from '../../packages/daemon/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
import {
  isRunningUnderBun,
  resolveSDKCliPath,
} from '../../packages/daemon/src/lib/agent/sdk-cli-resolver.ts';
import { buildNeoRoutePrompt } from '../../packages/daemon/src/lib/neo/route-classifier.ts';
import type { NeoHolder } from '../../packages/daemon/src/lib/neo/router.ts';
import { AnthropicToCodexBridgeProvider } from '../../packages/daemon/src/lib/providers/anthropic-to-codex-bridge-provider.ts';
import { DeepSeekProvider } from '../../packages/daemon/src/lib/providers/deepseek-provider.ts';
import { GlmProvider } from '../../packages/daemon/src/lib/providers/glm-provider.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildContextPrompt, buildRouteRequest, INBOX_ID, readRouteAnswer } from './context.ts';
import type { EvalCase, SystemOneRequest, SystemOneResponse } from './types.ts';

export interface RouteOutcome {
  predicted: string;
  confidence?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  serverLatencyMs?: number;
  servedModel?: string;
}

export type RouteBackend = (evalCase: EvalCase) => Promise<RouteOutcome>;

function reverseCriteria(request: SystemOneRequest): SystemOneRequest {
  const questions = Object.fromEntries(
    Object.entries(request.questions).map(([name, question]) => [
      name,
      { ...question, criteria: Object.fromEntries(Object.entries(question.criteria).reverse()) },
    ])
  );
  return { ...request, questions };
}

export function systemOneBackend(
  baseUrl: string,
  model?: string,
  reverseOptions = false
): RouteBackend {
  return async (evalCase) => {
    const request = buildRouteRequest(evalCase, model);
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/systemone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(reverseOptions ? reverseCriteria(request) : request),
    });
    if (!response.ok) throw new Error(`systemone ${response.status}: ${await response.text()}`);
    const body = (await response.json()) as SystemOneResponse;
    const answer = body.answers.route;
    return {
      predicted: answer.choice,
      confidence: answer.probabilities?.[answer.choice] ?? answer.confidence,
      inputTokens: body.usage?.input_tokens,
      serverLatencyMs: body.latency_ms,
    };
  };
}

export type LlmPrompt = 'message-only' | 'context';
export type LlmProvider = 'anthropic' | 'glm' | 'glm-flash' | 'deepseek' | 'codex';

const DEEPSEEK_ROUTE_MODEL = 'deepseek-flash';
export type LlmCallShape = 'deployed' | 'lean';

const LEAN_CWD = mkdtempSync(join(tmpdir(), 'neo-route-eval-'));

export const MINIMAL_SYSTEM_PROMPT =
  'You route chat messages. Reply with only the destination id, nothing else.';

const CODEX_ROUTE_MODEL = 'gpt-5.6-luna';
const CODEX_REASONING_EFFORT = 'none';

const INBOX_HOLDER: NeoHolder = {
  concernId: INBOX_ID,
  sessionId: 'inbox',
  title: 'Inbox',
  summary: 'Self-contained one-off questions that need no continuing topic.',
};

export function messageOnlyPrompt(evalCase: EvalCase): string {
  const holders: NeoHolder[] = evalCase.topics.map((topic) => ({
    concernId: topic.id,
    sessionId: topic.id,
    title: topic.title,
    summary: topic.summary,
  }));
  return buildNeoRoutePrompt(evalCase.message, [...holders, INBOX_HOLDER]);
}

function ambientEnv(): Record<string, string | undefined> {
  const base: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(base)) {
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_') || key === 'ANTHROPIC_BASE_URL') {
      delete base[key];
    }
  }
  return base;
}

function forceNoReasoning(): void {
  const original = globalThis.fetch;
  const patched = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (/\/responses(\?|$)/.test(url) && typeof init?.body === 'string') {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      body.reasoning = { effort: CODEX_REASONING_EFFORT };
      return original(input, { ...init, body: JSON.stringify(body) });
    }
    return original(input, init);
  }) as typeof fetch;
  globalThis.fetch = patched;
}

function thinkingOffProxy(targetBaseUrl: string): string {
  const target = targetBaseUrl.replace(/\/$/, '');
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const headers = new Headers(request.headers);
      headers.delete('host');
      headers.delete('content-length');
      let body: string | undefined = request.method === 'GET' ? undefined : await request.text();
      if (body && url.pathname.endsWith('/v1/messages')) {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        parsed.thinking = { type: 'disabled' };
        delete parsed.output_config;
        body = JSON.stringify(parsed);
      }
      return fetch(`${target}${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        body,
      });
    },
  });
  return `http://127.0.0.1:${server.port}`;
}

function withThinkingOff(env: Record<string, string>): Record<string, string> {
  return { ...env, ANTHROPIC_BASE_URL: thinkingOffProxy(env.ANTHROPIC_BASE_URL) };
}

async function providerEnv(provider: LlmProvider): Promise<Record<string, string | undefined>> {
  if (provider === 'glm') {
    return { ...ambientEnv(), ...new GlmProvider().buildSdkConfig('glm-5-turbo').envVars };
  }
  if (provider === 'glm-flash') {
    return {
      ...ambientEnv(),
      ...withThinkingOff(new GlmProvider().buildSdkConfig('glm-5.3-flash').envVars),
    };
  }
  if (provider === 'deepseek') {
    return {
      ...ambientEnv(),
      ...withThinkingOff(new DeepSeekProvider().buildSdkConfig('deepseek-v4-flash').envVars),
      ANTHROPIC_DEFAULT_HAIKU_MODEL: DEEPSEEK_ROUTE_MODEL,
      ANTHROPIC_DEFAULT_SONNET_MODEL: DEEPSEEK_ROUTE_MODEL,
      ANTHROPIC_DEFAULT_OPUS_MODEL: DEEPSEEK_ROUTE_MODEL,
    };
  }
  if (provider === 'codex') {
    forceNoReasoning();
    const bridge = new AnthropicToCodexBridgeProvider();
    if (!(await bridge.isAvailable())) throw new Error('Codex bridge has no credentials');
    await bridge.ensureBridgeStarted(CODEX_ROUTE_MODEL);
    return { ...ambientEnv(), ...bridge.buildSdkConfig(CODEX_ROUTE_MODEL).envVars };
  }
  return ambientEnv();
}

export function sdkLlmBackend(
  provider: LlmProvider,
  prompt: LlmPrompt,
  shape: LlmCallShape
): RouteBackend {
  const env = providerEnv(provider);
  return async (evalCase) => {
    const run = query({
      prompt: prompt === 'context' ? buildContextPrompt(evalCase) : messageOnlyPrompt(evalCase),
      options: {
        model: 'haiku',
        maxTurns: 1,
        mcpServers: {},
        settingSources: [],
        tools: [],
        ...(shape === 'lean'
          ? {
              env: { ...(await env), CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
              cwd: LEAN_CWD,
              systemPrompt: MINIMAL_SYSTEM_PROMPT,
            }
          : { env: await env }),
        pathToClaudeCodeExecutable: resolveSDKCliPath(),
        executable: isRunningUnderBun() ? 'bun' : undefined,
        thinking: { type: 'disabled' },
      },
    });
    let raw = '';
    let servedModel: string | undefined;
    let outcome: Omit<RouteOutcome, 'predicted'> = {};
    for await (const message of run) {
      if (message.type === 'assistant') {
        servedModel = message.message.model;
        raw += (message.message.content as Array<{ type: string; text?: string }>)
          .filter((block) => block.type === 'text')
          .map((block) => block.text ?? '')
          .join(' ');
      }
      if (message.type === 'result') {
        const usage = message.usage as {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
        };
        outcome = {
          inputTokens: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
          cachedInputTokens: usage.cache_read_input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
        };
      }
    }
    return { predicted: readRouteAnswer(raw, evalCase), servedModel, ...outcome };
  };
}
