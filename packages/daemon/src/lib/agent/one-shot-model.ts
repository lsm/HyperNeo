import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { isSDKAssistantMessage } from '@hyperneo/shared/sdk/type-guards';
import superpipe, { type PipelineAPI } from 'superpipe';
import { KimiProvider } from '../providers/kimi-provider.ts';
import { isRunningUnderBun, resolveSDKCliPath } from './sdk-cli-resolver.ts';
import { withSdkTranscriptRetention } from './sdk-transcript-retention.ts';

type SdkQueryFunction = typeof import('@anthropic-ai/claude-agent-sdk').query;

export interface OneShotModelRequest {
  prompt: string;
  provider: string;
  model: string;
  thinkingModelId: string;
  env: Record<string, string | undefined>;
  separator?: string;
  abortController?: AbortController;
  query?: SdkQueryFunction;
}

export interface OneShotRuntime {
  cliPath: string | undefined;
  executable: 'bun' | undefined;
}

function readOneShotRuntime(): OneShotRuntime {
  return { cliPath: resolveSDKCliPath(), executable: isRunningUnderBun() ? 'bun' : undefined };
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
      request.provider === 'kimi'
        ? KimiProvider.resolveKimiTitleThinkingConfig(request.thinkingModelId)
        : { type: 'disabled' },
    ...(request.abortController ? { abortController: request.abortController } : {}),
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

export async function firstAssistantText(
  messages: AsyncIterable<SDKMessage>,
  separator = ' '
): Promise<string | null> {
  for await (const message of messages) {
    if (!isSDKAssistantMessage(message)) continue;
    const blocks = message.message.content.filter(
      (block: { type: string }) => block.type === 'text'
    ) as Array<{ text?: string }>;
    const text = blocks
      .map((block) => block.text ?? '')
      .join(separator)
      .trim();
    if (text) return text;
  }
  return null;
}

function readFirstAssistantText(
  messages: AsyncIterable<SDKMessage>,
  request: OneShotModelRequest
): Promise<string | null> {
  return firstAssistantText(messages, request.separator);
}

export const runOneShotModel = (superpipe({})('run-one-shot-model') as PipelineAPI)
  .input('request')
  .pipe(readOneShotRuntime, undefined, 'runtime')
  .pipe(buildOneShotQueryOptions, ['request', 'runtime'], 'options')
  .pipe(loadSdkQuery, 'request', 'query')
  .pipe(callOneShotModel, ['query', 'request', 'options'], 'messages')
  .pipe(readFirstAssistantText, ['messages', 'request'], 'text')
  .endAsync('text') as (request: OneShotModelRequest) => Promise<string | null>;
