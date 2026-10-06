import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { neoExcerpt } from '../../storage/repositories/neo-routing-log-repository.ts';
import { isRunningUnderBun, resolveSDKCliPath } from '../agent/sdk-cli-resolver.ts';
import { withSdkTranscriptRetention } from '../agent/sdk-transcript-retention.ts';
import { Logger } from '../logger.ts';
import { getProviderService } from '../provider-service.ts';
import { KimiProvider } from '../providers/kimi-provider.js';
import { DEFAULT_NEO_ROUTE_TIMEOUT_MS } from '@hyperneo/shared';
import {
  NEO_ROUTE_BASES,
  type NeoHolder,
  type NeoRouteBasis,
  type NeoRouteDecision,
  type NeoRouteVerdict,
} from './router.ts';

const log = new Logger('neo-route-classifier');
const ASK_CHARS = 2_000;
const ANSWER_TOKENS = 512;
const ANTHROPIC_VERSION = '2023-06-01';
let leanCwd: string | undefined;

export type NeoRouteModel = { provider: string; model: string };
type RouteThinking = { type: 'enabled'; budgetTokens: number } | { type: 'disabled' } | undefined;

export interface NeoRouteHttpCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export function neoRouteHttpCall(
  baseUrl: string,
  modelId: string,
  env: Record<string, string | undefined>,
  prompt: string,
  thinking: RouteThinking
): NeoRouteHttpCall | null {
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return null;
  }
  if (host === 'anthropic.com' || host.endsWith('.anthropic.com')) return null;
  const custom = Object.fromEntries(
    (env.ANTHROPIC_CUSTOM_HEADERS ?? '').split('\n').flatMap((line) => {
      const at = line.indexOf(':');
      return at > 0 ? [[line.slice(0, at).trim(), line.slice(at + 1).trim()]] : [];
    })
  );
  const auth: Record<string, string> = env.ANTHROPIC_AUTH_TOKEN
    ? { authorization: `Bearer ${env.ANTHROPIC_AUTH_TOKEN}` }
    : env.ANTHROPIC_API_KEY
      ? { 'x-api-key': env.ANTHROPIC_API_KEY }
      : {};
  return {
    url: `${baseUrl.replace(/\/+$/, '')}/v1/messages`,
    headers: {
      ...custom,
      ...auth,
      'content-type': 'application/json',
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: {
      model: modelId,
      max_tokens: ANSWER_TOKENS + (thinking?.type === 'enabled' ? thinking.budgetTokens : 0),
      stream: true,
      messages: [{ role: 'user', content: prompt }],
      ...(thinking?.type === 'enabled'
        ? { thinking: { type: 'enabled', budget_tokens: thinking.budgetTokens } }
        : thinking
          ? { thinking: { type: 'disabled' } }
          : {}),
    },
  };
}

export function neoRouteTimeoutMs(setting: number | undefined): number {
  return typeof setting === 'number' && Number.isFinite(setting) && setting > 0
    ? setting
    : DEFAULT_NEO_ROUTE_TIMEOUT_MS;
}

export function neoRouteEndpoint(
  title: { modelId: string; baseUrl: string } | null,
  requested: string,
  env: Record<string, string | undefined>
): { modelId: string; baseUrl: string } {
  return (
    title ?? {
      modelId: env.ANTHROPIC_MODEL || requested,
      baseUrl: env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
    }
  );
}

export function readNeoRouteStream(stream: string): string {
  return stream
    .split('\n')
    .flatMap((line) => {
      if (!line.startsWith('data:')) return [];
      try {
        const event = JSON.parse(line.slice(5)) as { delta?: { type?: string; text?: string } };
        return event.delta?.type === 'text_delta' && event.delta.text ? [event.delta.text] : [];
      } catch {
        return [];
      }
    })
    .join('');
}

export function buildNeoRoutePrompt(
  text: string,
  candidates: readonly NeoHolder[],
  context: string
): string {
  const ids = ['main', ...candidates.map((holder) => holder.concernId)].join(', ');
  return `Route the user's new message in an ongoing conversation to whoever should answer it.

${context}

New message:
${neoExcerpt(text, ASK_CHARS)}

Reply with one JSON object and nothing else:
{"type":"choice","choice":"<id>","confidence":<0 to 1>,"basis":"<basis>"}
choice is one of: ${ids}
Pick choice and basis by the first rule that applies:
- continues_turn: it continues a recent turn (a follow-up, "yes", "how about X now", a reference to an earlier thing); choose that turn's topic, or main if that turn was main.
- answers_waiting: it answers a WAITING ON YOU question; choose that topic.
- matches_topic: it stands alone and clearly belongs to one topic; choose that topic.
- one_off: a self-contained one-off question unrelated to the recent turns; choose inbox (when listed).
- new_subject: it starts a new subject; choose main.
- unsure: two topics are waiting and it could answer either, or you are unsure; choose main.
confidence is how sure you are of choice.`;
}

function plainRouteId(raw: string): string {
  return raw
    .trim()
    .replace(/^[`"']+|[`"']+$/g, '')
    .trim();
}

function routeObject(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function readNeoRouteDecision(
  raw: string,
  candidates: readonly NeoHolder[]
): NeoRouteDecision | null {
  const object = routeObject(raw);
  const id = object
    ? typeof object.choice === 'string'
      ? object.choice.trim()
      : ''
    : plainRouteId(raw);
  const decision =
    id === 'main' ? 'main' : (candidates.find((holder) => holder.concernId === id) ?? null);
  if (!decision) return null;
  const confidence =
    typeof object?.confidence === 'number' && Number.isFinite(object.confidence)
      ? Math.min(1, Math.max(0, object.confidence))
      : null;
  const basis = NEO_ROUTE_BASES.find((name) => name === object?.basis) ?? null;
  return { decision, confidence, basis: basis as NeoRouteBasis | null };
}

async function askNeoRouteModel(
  text: string,
  candidates: readonly NeoHolder[],
  context: string,
  abortController: AbortController,
  choice: NeoRouteModel | undefined
): Promise<NeoRouteVerdict> {
  const providers = getProviderService();
  try {
    const provider = choice?.provider ?? (await providers.getDefaultProvider());
    const title = choice ? null : await providers.getTitleGenerationConfig(provider);
    const requested = choice?.model ?? title?.modelId;
    if (!requested) return null;
    const env = await providers.getIsolatedEnvForModel(provider, requested);
    const config = neoRouteEndpoint(title, requested, env);
    const prompt = buildNeoRoutePrompt(text, candidates, context);
    const thinking: RouteThinking =
      provider === 'kimi'
        ? KimiProvider.resolveKimiTitleThinkingConfig(config.modelId)
        : { type: 'disabled' };
    const call = neoRouteHttpCall(config.baseUrl, config.modelId, env, prompt, thinking);
    if (call) {
      const response = await fetch(call.url, {
        method: 'POST',
        headers: call.headers,
        body: JSON.stringify(call.body),
        signal: abortController.signal,
      });
      if (!response.ok) throw new Error(`route model returned ${response.status}`);
      return readNeoRouteDecision(readNeoRouteStream(await response.text()), candidates);
    }
    leanCwd ??= mkdtempSync(join(tmpdir(), 'neo-route-'));
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const { isSDKAssistantMessage } = await import('@hyperneo/shared/sdk/type-guards');
    const run = query({
      prompt,
      options: {
        cwd: leanCwd,
        model: provider === 'glm' ? 'haiku' : config.modelId,
        maxTurns: 1,
        mcpServers: {},
        settingSources: [],
        tools: [],
        pathToClaudeCodeExecutable: resolveSDKCliPath(),
        executable: isRunningUnderBun() ? 'bun' : undefined,
        settings: withSdkTranscriptRetention(),
        env: { ...env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
        abortController,
        thinking,
      },
    });
    for await (const message of run) {
      if (!isSDKAssistantMessage(message)) continue;
      const raw = (message.message.content as Array<{ type: string; text?: string }>)
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join(' ');
      if (raw.trim()) return readNeoRouteDecision(raw, candidates);
    }
    return null;
  } catch (error) {
    log.warn('Neo route classification failed:', error);
    return 'failed';
  }
}

export async function classifyNeoRoute(
  text: string,
  candidates: readonly NeoHolder[],
  context: string,
  choice?: NeoRouteModel,
  timeoutMs = DEFAULT_NEO_ROUTE_TIMEOUT_MS
): Promise<NeoRouteVerdict> {
  if (process.env.NODE_ENV === 'test') return null;
  const abortController = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      resolve('timeout');
      abortController.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      askNeoRouteModel(text, candidates, context, abortController, choice),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
