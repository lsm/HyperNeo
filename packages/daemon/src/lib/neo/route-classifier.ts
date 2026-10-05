import { isRunningUnderBun, resolveSDKCliPath } from '../agent/sdk-cli-resolver.ts';
import { withSdkTranscriptRetention } from '../agent/sdk-transcript-retention.ts';
import { Logger } from '../logger.ts';
import { getProviderService, mergeProviderEnvVars } from '../provider-service.ts';
import type { NeoHolder } from './router.ts';

const log = new Logger('neo-route-classifier');
const ASK_CHARS = 1_000;
const SUMMARY_CHARS = 240;

export function buildNeoRoutePrompt(text: string, candidates: readonly NeoHolder[]): string {
  const topics = candidates
    .map(
      (holder) =>
        `- id: ${holder.concernId}\n  title: ${holder.title.slice(0, 120)}\n  summary: ${holder.summary.slice(0, SUMMARY_CHARS) || '(none)'}`
    )
    .join('\n');
  return `Route a user's message to the topic that should answer it.

Message:
${text.slice(0, ASK_CHARS)}

Topics:
${topics}

Reply with exactly one id and nothing else:
- a topic id if the message clearly continues that topic;
- main if it starts a new continuing topic, spans several topics, or you are unsure.`;
}

export function readNeoRouteAnswer(
  raw: string,
  candidates: readonly NeoHolder[]
): NeoHolder | null {
  const answer = raw
    .trim()
    .replace(/^[`"']+|[`"']+$/g, '')
    .trim();
  return candidates.find((holder) => holder.concernId === answer) ?? null;
}

export async function classifyNeoRoute(
  text: string,
  candidates: readonly NeoHolder[]
): Promise<NeoHolder | null> {
  if (candidates.length === 0 || process.env.NODE_ENV === 'test') return null;
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
      prompt: buildNeoRoutePrompt(text, candidates),
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
        thinking: { type: 'disabled' },
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
