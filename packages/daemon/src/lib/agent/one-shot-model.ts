import type { Options, SDKAssistantMessage, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { isSDKAssistantMessage } from '@hyperneo/shared/sdk/type-guards';
import superpipe, { type PipelineAPI } from 'superpipe';
import { KimiProvider } from '../providers/kimi-provider.ts';
import { awaitSDKCliPath, isRunningUnderBun } from './sdk-cli-resolver.ts';
import { withSdkTranscriptRetention } from './sdk-transcript-retention.ts';

type SdkQueryFunction = typeof import('@anthropic-ai/claude-agent-sdk').query;

export interface OneShotModelRequest {
  prompt: string;
  system?: string;
  provider: string;
  model: string;
  thinkingModelId: string;
  thinking?: Options['thinking'];
  env: Record<string, string | undefined>;
  separator?: string;
  abortController?: AbortController;
  cwd?: string;
  query?: SdkQueryFunction;
}

export interface OneShotRuntime {
  cliPath: string | undefined;
  executable: 'bun' | undefined;
}

export function oneShotModelIds(
  provider: string,
  providerModelId: string,
  providerEnv: Record<string, string | undefined>
): Pick<OneShotModelRequest, 'model' | 'thinkingModelId'> {
  return {
    model: provider === 'glm' ? 'haiku' : (providerEnv.ANTHROPIC_MODEL ?? providerModelId),
    thinkingModelId: providerModelId,
  };
}

async function readOneShotRuntime(): Promise<OneShotRuntime> {
  return { cliPath: await awaitSDKCliPath(), executable: isRunningUnderBun() ? 'bun' : undefined };
}

export function buildOneShotQueryOptions(
  request: OneShotModelRequest,
  runtime: OneShotRuntime
): Options {
  return {
    model: request.model,
    maxTurns: 1,
    permissionMode: 'acceptEdits',
    allowDangerouslySkipPermissions: false,
    mcpServers: {},
    settingSources: [],
    tools: [],
    pathToClaudeCodeExecutable: runtime.cliPath,
    executable: runtime.executable,
    settings: withSdkTranscriptRetention(),
    env: request.env,
    thinking:
      request.thinking ??
      (request.provider === 'kimi'
        ? KimiProvider.resolveKimiTitleThinkingConfig(request.thinkingModelId)
        : { type: 'disabled' }),
    ...(request.system
      ? {
          systemPrompt: {
            type: 'preset' as const,
            preset: 'claude_code' as const,
            append: request.system,
            excludeDynamicSections: true,
          },
        }
      : {}),
    ...(request.abortController ? { abortController: request.abortController } : {}),
    ...(request.cwd ? { cwd: request.cwd } : {}),
  };
}

async function loadSdkQuery(request: OneShotModelRequest): Promise<SdkQueryFunction> {
  return request.query ?? (await import('@anthropic-ai/claude-agent-sdk')).query;
}

function callOneShotModel(
  query: SdkQueryFunction,
  request: OneShotModelRequest,
  options: Options
): AsyncIterable<SDKMessage> {
  return query({ prompt: request.prompt, options });
}

export function readAssistantReply(
  message: SDKAssistantMessage,
  separator = ' '
): { text: string } | { error: string } {
  const content = (message.message?.content ?? []) as Array<{ type: string; text?: string }>;
  const text = content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join(separator)
    .trim();
  return message.error ? { error: text ? `${message.error}: ${text}` : message.error } : { text };
}

export async function firstAssistantText(
  messages: AsyncIterable<SDKMessage>,
  separator = ' '
): Promise<string | null> {
  for await (const message of messages) {
    if (!isSDKAssistantMessage(message)) continue;
    const reply = readAssistantReply(message, separator);
    if ('error' in reply) throw new Error(`The model answered with an error: ${reply.error}`);
    if (reply.text) return reply.text;
  }
  return null;
}

async function readFirstAssistantText(
  messages: AsyncIterable<SDKMessage>,
  request: OneShotModelRequest
): Promise<{ text: string | null }> {
  return { text: await firstAssistantText(messages, request.separator) };
}

const oneShotModel = (superpipe({})('run-one-shot-model') as PipelineAPI)
  .input('request')
  .pipe(readOneShotRuntime, undefined, 'runtime')
  .pipe(buildOneShotQueryOptions, ['request', 'runtime'], 'options')
  .pipe(loadSdkQuery, 'request', 'query')
  .pipe(callOneShotModel, ['query', 'request', 'options'], 'messages')
  .pipe(readFirstAssistantText, ['messages', 'request'], 'reply')
  .endAsync('reply') as (request: OneShotModelRequest) => Promise<{ text: string | null }>;

export async function runOneShotModel(request: OneShotModelRequest): Promise<string | null> {
  return (await oneShotModel(request)).text;
}
