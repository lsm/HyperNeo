import { query } from '../../packages/daemon/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
import {
  isRunningUnderBun,
  resolveSDKCliPath,
} from '../../packages/daemon/src/lib/agent/sdk-cli-resolver.ts';
import { AnthropicToCodexBridgeProvider } from '../../packages/daemon/src/lib/providers/anthropic-to-codex-bridge-provider.ts';
import { DeepSeekProvider } from '../../packages/daemon/src/lib/providers/deepseek-provider.ts';
import { GlmProvider } from '../../packages/daemon/src/lib/providers/glm-provider.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildNeoRoutePrompt,
  neoRouteHttpCall,
  readNeoRouteStream,
} from '../../packages/daemon/src/lib/neo/route-classifier.ts';
import {
  NEO_INBOX_ID,
  NEO_INBOX_SUMMARY,
  type NeoHolder,
  renderNeoRouteContext,
} from '../../packages/daemon/src/lib/neo/router.ts';
import type { NeoRoute } from '../../packages/daemon/src/storage/repositories/neo-routing-log-repository.ts';
import { buildContextPrompt, buildRouteRequest, INBOX_ID, readRouteAnswer } from './context.ts';
import type { EvalCase, EvalTurn, SystemOneRequest, SystemOneResponse } from './types.ts';

export interface RouteOutcome {
  predicted: string;
  confidence?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  serverLatencyMs?: number;
  servedModel?: string;
  thinkingBlocks?: number;
  rawAnswer?: string;
  unparsed?: boolean;
  stopReason?: string;
  basis?: string;
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
const GLM_NATIVE_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const GLM_ALWAYS_THINKING = new Set(['glm-5.3-flash']);

export function glmNativeBackend(model: string, prompt: LlmPrompt): RouteBackend {
  const apiKey = process.env.GLM_API_KEY || process.env.ZHIPU_API_KEY;
  if (!apiKey) throw new Error('GLM_API_KEY is not set');
  return async (evalCase) => {
    const response = await fetch(GLM_NATIVE_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: GLM_ALWAYS_THINKING.has(model) ? 1024 : 32,
        ...(GLM_ALWAYS_THINKING.has(model)
          ? { thinking: { type: 'enabled' }, reasoning_effort: 'low' }
          : { thinking: { type: 'disabled' } }),
        messages: [
          { role: 'system', content: MINIMAL_SYSTEM_PROMPT },
          {
            role: 'user',
            content:
              prompt === 'context' ? buildContextPrompt(evalCase) : messageOnlyPrompt(evalCase),
          },
        ],
      }),
    });
    if (!response.ok) throw new Error(`glm ${response.status}: ${await response.text()}`);
    const body = (await response.json()) as {
      model?: string;
      choices: Array<{
        finish_reason?: string;
        message: { content?: string; reasoning_content?: string };
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
      };
    };
    const choice = body.choices[0];
    const message = choice?.message ?? {};
    if (choice?.finish_reason === 'length' && !message.content?.trim()) {
      throw new Error(`glm ${model} hit max_tokens before answering`);
    }
    const cached = body.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    return {
      predicted: readRouteAnswer(message.content ?? '', evalCase),
      servedModel: body.model,
      thinkingBlocks: message.reasoning_content ? 1 : 0,
      rawAnswer: (message.content ?? '').trim().slice(0, 200),
      inputTokens: (body.usage?.prompt_tokens ?? 0) - cached,
      cachedInputTokens: cached,
      outputTokens: body.usage?.completion_tokens ?? 0,
    };
  };
}

function toNeoRoute(turn: EvalTurn, index: number, awaiting: string | null): NeoRoute {
  return {
    id: index,
    messageId: `turn-${index}`,
    conversationId: 'eval',
    askedAt: Date.parse(turn.at),
    ask: turn.ask,
    destination: turn.topic === 'main' ? 'main' : 'holder',
    targetSessionId: turn.topic === 'main' ? null : turn.topic,
    concernId: turn.topic === 'main' ? null : turn.topic,
    signal: 'eval',
    confidence: null,
    outcome: turn.answer,
    outcomeAt: Date.parse(turn.at),
    askSummary: null,
    awaiting,
  };
}

export function productionRoutePrompt(evalCase: EvalCase): {
  prompt: string;
  options: NeoHolder[];
} {
  const holders: NeoHolder[] = evalCase.topics.map((topic) => ({
    concernId: topic.id,
    sessionId: topic.id,
    title: topic.title,
    summary: topic.summary,
  }));
  const waiting = new Map(evalCase.topics.map((topic) => [topic.id, topic.waiting ?? null]));
  const routes = evalCase.turns.map((turn, index) =>
    toNeoRoute(turn, index, waiting.get(turn.topic) ?? null)
  );
  const recent = [...routes].reverse();
  const latest = [...new Set(recent.map((route) => route.concernId ?? 'main'))].map(
    (topic) => recent.find((route) => (route.concernId ?? 'main') === topic) as NeoRoute
  );
  const context = renderNeoRouteContext(holders, holders, recent, latest, true);
  const options = [
    ...holders,
    { concernId: NEO_INBOX_ID, sessionId: '', title: 'Inbox', summary: NEO_INBOX_SUMMARY },
  ];
  return { prompt: buildNeoRoutePrompt(evalCase.message, options, context), options };
}

export function readRouteReply(
  raw: string,
  ids: readonly string[]
): { id: string | null; confidence?: number; basis?: string } {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  let object: Record<string, unknown> | null = null;
  if (start >= 0 && end > start) {
    try {
      object = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
      object = null;
    }
  }
  const candidate = object
    ? String(object.choice ?? '').trim()
    : raw
        .trim()
        .replace(/^[`"']+|[`"']+$/g, '')
        .trim();
  return {
    id: candidate === 'main' || ids.includes(candidate) ? candidate : null,
    ...(typeof object?.confidence === 'number' ? { confidence: object.confidence } : {}),
    ...(typeof object?.basis === 'string' ? { basis: object.basis } : {}),
  };
}

export function productionDirectBackend(
  baseUrl: string,
  model: string,
  apiKeyEnv: string
): RouteBackend {
  const apiKey = process.env[apiKeyEnv];
  if (!apiKey) throw new Error(`${apiKeyEnv} is not set`);
  return async (evalCase) => {
    const { prompt, options } = productionRoutePrompt(evalCase);
    const call = neoRouteHttpCall(baseUrl, model, { ANTHROPIC_AUTH_TOKEN: apiKey }, prompt, {
      type: 'disabled',
    });
    if (!call) throw new Error(`${baseUrl} is not a direct-call host`);
    const response = await fetch(call.url, {
      method: 'POST',
      headers: call.headers,
      body: JSON.stringify(call.body),
    });
    if (!response.ok) throw new Error(`${model} ${response.status}: ${await response.text()}`);
    const stream = await response.text();
    const events = stream
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .flatMap((line) => {
        try {
          return [JSON.parse(line.slice(5)) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
    const thinkingBlocks = events.filter(
      (event) =>
        event.type === 'content_block_start' &&
        (event.content_block as { type?: string } | undefined)?.type === 'thinking'
    ).length;
    const delta = events.find((event) => event.type === 'message_delta') as
      | {
          delta?: { stop_reason?: string };
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
          };
        }
      | undefined;
    const start = events.find((event) => event.type === 'message_start') as
      | { message?: { usage?: { input_tokens?: number; cache_read_input_tokens?: number } } }
      | undefined;
    const raw = readNeoRouteStream(stream);
    const reply = readRouteReply(
      raw,
      options.map((option) => option.concernId)
    );
    return {
      predicted: reply.id ?? 'main',
      confidence: reply.confidence,
      basis: reply.basis,
      servedModel: model,
      thinkingBlocks,
      rawAnswer: raw.trim().slice(0, 200),
      unparsed: reply.id === null,
      stopReason: delta?.delta?.stop_reason,
      inputTokens: delta?.usage?.input_tokens || start?.message?.usage?.input_tokens,
      cachedInputTokens:
        delta?.usage?.cache_read_input_tokens ??
        start?.message?.usage?.cache_read_input_tokens ??
        0,
      outputTokens: delta?.usage?.output_tokens,
    };
  };
}

export type LlmProvider = 'anthropic' | 'glm' | 'glm-flash' | 'deepseek' | 'codex';

const DEEPSEEK_ROUTE_MODEL = 'deepseek-flash';
export type LlmCallShape = 'deployed' | 'lean';

const LEAN_CWD = mkdtempSync(join(tmpdir(), 'neo-route-eval-'));

export const MINIMAL_SYSTEM_PROMPT =
  'You route chat messages. Reply with only the destination id, nothing else.';

const CODEX_ROUTE_MODEL = 'gpt-5.6-luna';
const CODEX_REASONING_EFFORT = 'none';

const LEGACY_ASK_CHARS = 1_000;
const LEGACY_SUMMARY_CHARS = 240;

const LEGACY_INBOX_TOPIC = {
  id: INBOX_ID,
  title: 'Inbox',
  summary: 'Self-contained one-off questions that need no continuing topic.',
};

export function messageOnlyPrompt(evalCase: EvalCase): string {
  const topics = [...evalCase.topics, LEGACY_INBOX_TOPIC]
    .map(
      (topic) =>
        `- id: ${topic.id}\n  title: ${topic.title.slice(0, 120)}\n  summary: ${topic.summary.slice(0, LEGACY_SUMMARY_CHARS) || '(none)'}`
    )
    .join('\n');
  return `Route a user's message to the topic that should answer it.

Message:
${evalCase.message.slice(0, LEGACY_ASK_CHARS)}

Topics:
${topics}

Reply with exactly one id and nothing else:
- a topic id if the message clearly continues that topic;
- inbox (when listed) if it is a self-contained one-off question that needs no continuing topic;
- main if it starts a new continuing topic, spans several topics, or you are unsure.`;
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
    return {
      ...ambientEnv(),
      ...withThinkingOff(new GlmProvider().buildSdkConfig('glm-5-turbo').envVars),
    };
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
    let thinkingBlocks = 0;
    let outcome: Omit<RouteOutcome, 'predicted'> = {};
    for await (const message of run) {
      if (message.type === 'assistant') {
        servedModel = message.message.model;
        const blocks = message.message.content as Array<{ type: string; text?: string }>;
        thinkingBlocks += blocks.filter((block) => block.type === 'thinking').length;
        raw += blocks
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
    return {
      predicted: readRouteAnswer(raw, evalCase),
      servedModel,
      thinkingBlocks,
      rawAnswer: raw.trim().slice(0, 200),
      ...outcome,
    };
  };
}
