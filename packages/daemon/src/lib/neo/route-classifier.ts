import { neoExcerpt } from '../../storage/repositories/neo-routing-log-repository.ts';
import { isRunningUnderBun, resolveSDKCliPath } from '../agent/sdk-cli-resolver.ts';
import { withSdkTranscriptRetention } from '../agent/sdk-transcript-retention.ts';
import { Logger } from '../logger.ts';
import { getProviderService, mergeProviderEnvVars } from '../provider-service.ts';
import { KimiProvider } from '../providers/kimi-provider.js';
import type { NeoHolder, NeoRouteAnswer } from './router.ts';

const log = new Logger('neo-route-classifier');
const ASK_CHARS = 2_000;
const CLASSIFY_TIMEOUT_MS = 4_000;

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

Reply with exactly one of these ids and nothing else: ${ids}
- If it continues a recent turn (a follow-up, "yes", "how about X now", a reference to an earlier thing), the topic of that turn; main if that turn was main.
- If it answers a WAITING ON YOU question, that topic.
- If it stands alone and clearly belongs to one topic, that topic.
- inbox (when listed) only for a self-contained one-off question unrelated to the recent turns.
- main for a new subject, when two topics are waiting and it could answer either, or when unsure.`;
}

export function readNeoRouteAnswer(raw: string, candidates: readonly NeoHolder[]): NeoRouteAnswer {
  const answer = raw
    .trim()
    .replace(/^[`"']+|[`"']+$/g, '')
    .trim();
  if (answer === 'main') return 'main';
  return candidates.find((holder) => holder.concernId === answer) ?? null;
}

async function askNeoRouteModel(
  text: string,
  candidates: readonly NeoHolder[],
  context: string,
  abortController: AbortController
): Promise<NeoRouteAnswer> {
  const providers = getProviderService();
  let restore: Awaited<ReturnType<typeof providers.applyEnvVarsToProcessForProvider>> = {};
  try {
    const provider = await providers.getDefaultProvider();
    const config = await providers.getTitleGenerationConfig(provider);
    if (!config) return null;
    restore = await providers.applyEnvVarsToProcessForProvider(provider, config.modelId);
    const env = mergeProviderEnvVars(
      (await providers.getEnvVarsForModel(config.modelId, provider)) as Record<
        string,
        string | undefined
      >
    );
    providers.restoreEnvVars(restore);
    restore = {};
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const { isSDKAssistantMessage } = await import('@hyperneo/shared/sdk/type-guards');
    const run = query({
      prompt: buildNeoRoutePrompt(text, candidates, context),
      options: {
        model: provider === 'glm' ? 'haiku' : config.modelId,
        maxTurns: 1,
        mcpServers: {},
        settingSources: [],
        tools: [],
        pathToClaudeCodeExecutable: resolveSDKCliPath(),
        executable: isRunningUnderBun() ? 'bun' : undefined,
        settings: withSdkTranscriptRetention(),
        env,
        abortController,
        thinking:
          provider === 'kimi'
            ? KimiProvider.resolveKimiTitleThinkingConfig(config.modelId)
            : { type: 'disabled' },
      },
    });
    for await (const message of run) {
      if (!isSDKAssistantMessage(message)) continue;
      const raw = (message.message.content as Array<{ type: string; text?: string }>)
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join(' ');
      if (raw.trim()) return readNeoRouteAnswer(raw, candidates);
    }
    return null;
  } catch (error) {
    log.warn('Neo route classification failed:', error);
    return null;
  } finally {
    try {
      providers.restoreEnvVars(restore);
    } catch {}
  }
}

export async function classifyNeoRoute(
  text: string,
  candidates: readonly NeoHolder[],
  context: string,
  timeoutMs = CLASSIFY_TIMEOUT_MS
): Promise<NeoRouteAnswer> {
  if (process.env.NODE_ENV === 'test') return null;
  const abortController = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      abortController.abort();
      resolve(null);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      askNeoRouteModel(text, candidates, context, abortController),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
