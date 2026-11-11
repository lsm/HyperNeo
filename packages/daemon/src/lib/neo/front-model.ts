import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { existsSync } from 'node:fs';
import type { UUID } from 'node:crypto';
import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKUserMessage,
  SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import {
  resolveAutoCompactPercent,
  THINKING_LEVEL_TOKENS,
  THINKING_LEVEL_EFFORT,
  type NeoModelPreference,
} from '@hyperneo/shared';
import type { NeoConversationAsk } from '@hyperneo/shared/types/neo-conversation-ask';
import { NEO_FRONT } from '@hyperneo/prompts';
import { z } from 'zod';
import { sdkMessageWrites } from '../../storage/repositories/sdk-message-writes.ts';
import { neoFrontReads } from '../../storage/repositories/neo-front-read-worker.ts';
import { getModelInfo } from '../model-service.ts';
import { oneShotModelIds, readAssistantReply } from '../agent/one-shot-model.ts';
import { withSdkTranscriptRetention } from '../agent/sdk-transcript-retention.ts';
import { awaitSDKCliPath, isRunningUnderBun } from '../agent/sdk-cli-resolver.ts';
import { getProviderService } from '../provider-service.ts';
import { neoDerivedId } from './derived-id.ts';
import { frontSession } from './front-session.ts';
import { Logger } from '../logger.ts';
import type { NeoService } from './service.ts';

const Read = z
  .object({
    id: z.string().min(1).max(200).optional(),
    text: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
const Reply = z
  .object({ kind: z.enum(['chat', 'status', 'defer']), text: z.string().trim().min(1).max(500) })
  .strict();
const FRONT_DEADLINE_BASE_MS = 15_000;
const FRONT_DEADLINE_PER_THINKING_TOKEN_MS = 1;

export function frontDeadlineMs(thinkingLevel: NeoModelPreference['thinkingLevel']): number {
  return (
    FRONT_DEADLINE_BASE_MS +
    (THINKING_LEVEL_TOKENS[thinkingLevel] ?? 0) * FRONT_DEADLINE_PER_THINKING_TOKEN_MS
  );
}
const STALE_RESUME_PATTERN = /No conversation found|no conversation found/;
const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
});

export async function runNeoFrontModel(
  service: NeoService,
  ask: NeoConversationAsk,
  model: NeoModelPreference
): Promise<string | null> {
  const session = await frontSession(service, ask, model);
  const history = service.db.getSDKMessageRepo();
  let assistant: SDKAssistantMessage | undefined;
  let reads = 0;
  let grounded = false;
  const lookups = (['projects', 'asks', 'cards', 'todos'] as const).map((kind) =>
    tool(
      `${kind}_read`,
      `front.${kind}.read: one fresh lookup per call. Use id, text or {}. Defer if the result is incomplete.`,
      Read.shape,
      async (input) => {
        if (++reads > 1 || (input.id && input.text)) {
          grounded = false;
          return { ...result('Read limit reached; defer.'), isError: true };
        }
        const value = await service.db.gateway.run(neoFrontReads, {
          conversationId: ask.conversationId,
          kind,
          input: input.id ? { id: input.id } : input.text ? { text: input.text } : {},
        });
        grounded =
          reads === 1 &&
          value !== null &&
          (!('items' in value) || value.items.length > 0 || (value.totalExact && !input.text));
        return result(
          value && 'items' in value
            ? { items: value.items, total: value.total, totalExact: value.totalExact }
            : value
        );
      }
    )
  );
  const send = tool(
    'neo_send',
    'front.neo.send: leave a note for root Neo tied to this input. The original human message already reaches Neo.',
    { text: z.string().trim().min(1).max(500) },
    async ({ text }) =>
      result({
        delivered: await service.wakeNeo(
          neoDerivedId(`front-note:${ask.conversationId}:${ask.requestId}`),
          `Front note for human input ${ask.requestId}: ${text}`
        ),
      })
  );
  const tools = [...lookups, send];
  const env: NodeJS.ProcessEnv = {
    ...(await getProviderService().getIsolatedEnvForModel(model.provider, model.model)),
  };
  delete env.CLAUDE_CODE_DISABLE_THINKING;
  delete env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  const compactPercent = resolveAutoCompactPercent(model.autoCompactPercent);
  env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = String(compactPercent);
  const contextWindow = (
    await getModelInfo(model.model, 'global', model.provider).catch(() => null)
  )?.contextWindow;
  const autoCompactWindow =
    contextWindow === undefined || contextWindow <= 0
      ? undefined
      : Math.floor((contextWindow * compactPercent) / 100);
  const budget = THINKING_LEVEL_TOKENS[model.thinkingLevel];
  const deadlineMs = frontDeadlineMs(model.thinkingLevel);
  const cwd = existsSync(session.workspacePath ?? '')
    ? (session.workspacePath ?? undefined)
    : undefined;
  let phase = 'sdk_path';
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), deadlineMs);
  let text = '';
  let structured: unknown;
  let terminal: SDKResultMessage | undefined;
  const runQuery = (resumeId: string | undefined, executablePath: string | undefined) => {
    const messages = query({
      prompt: (async function* () {
        const input: SDKUserMessage = {
          type: 'user',
          session_id: session.sdkSessionId ?? session.id,
          parent_tool_use_id: null,
          uuid: neoDerivedId(`front-input:${ask.requestId}`) as UUID,
          message: { role: 'user', content: ask.content },
        };
        if (
          !history.getMessageByUuid(session.id, input.uuid!) &&
          !(await service.db.gateway.call(
            sdkMessageWrites,
            'saveSDKMessage',
            session.id,
            input,
            'human'
          ))
        )
          throw new Error('front_history_write_failed');
        yield input;
      })(),
      options: {
        model: oneShotModelIds(model.provider, model.model, env).model,
        env,
        systemPrompt: NEO_FRONT,
        outputFormat: { type: 'json_schema', schema: z.toJSONSchema(Reply, { target: 'draft-7' }) },
        tools: [],
        settingSources: [],
        strictMcpConfig: true,
        allowedTools: tools.map((entry) => `mcp__front__${entry.name}`),
        mcpServers: { front: createSdkMcpServer({ name: 'front', tools }) },
        permissionMode: 'dontAsk',
        settings: withSdkTranscriptRetention(
          autoCompactWindow === undefined
            ? undefined
            : { autoCompactEnabled: true, autoCompactWindow }
        ),
        maxTurns: 4,
        persistSession: true,
        ...(resumeId ? { resume: resumeId } : { sessionId: session.id }),
        cwd,
        thinking:
          budget === undefined ? { type: 'disabled' } : { type: 'enabled', budgetTokens: budget },
        effort: THINKING_LEVEL_EFFORT[model.thinkingLevel],
        abortController,
        pathToClaudeCodeExecutable: executablePath,
        executable: isRunningUnderBun() ? 'bun' : undefined,
      },
    });
    return messages;
  };
  try {
    const pathToClaudeCodeExecutable = await awaitSDKCliPath();
    phase = 'sdk_query';
    let resumeId = session.sdkSessionId;
    const drain = async (messages: AsyncIterable<SDKMessage>) => {
      for await (const message of messages) {
        if (message.type === 'system' && message.subtype === 'init')
          await service.db.updateSession(session.id, { sdkSessionId: message.session_id });
        if (message.type === 'result') {
          terminal = message;
          if (message.subtype !== 'success' || message.is_error)
            throw new Error(`front_sdk_${message.subtype}`);
          structured = message.structured_output;
        }
        if (message.type === 'assistant') {
          assistant = message;
          const reply = readAssistantReply(message);
          if ('error' in reply) throw new Error(`front_sdk_${message.error}`);
          if (reply.text) text = reply.text;
        }
      }
    };
    try {
      await drain(runQuery(resumeId, pathToClaudeCodeExecutable));
    } catch (error) {
      if (!resumeId || !STALE_RESUME_PATTERN.test(error instanceof Error ? error.message : ''))
        throw error;
      phase = 'stale_resume';
      new Logger('NeoFront').warn('Convo SDK conversation was missing; starting a fresh one');
      await service.db.updateSession(session.id, { sdkSessionId: undefined });
      resumeId = undefined;
      terminal = undefined;
      assistant = undefined;
      text = '';
      structured = undefined;
      await drain(runQuery(undefined, pathToClaudeCodeExecutable));
    }
    phase = 'reply_validation';
    const reply = Reply.parse(
      structured ?? JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''))
    );
    if (reply.kind === 'status' && !grounded) throw new Error('front_status_not_grounded');
    if (
      assistant &&
      !(await service.db.gateway.call(sdkMessageWrites, 'saveSDKMessage', session.id, {
        ...assistant,
        message: { ...assistant.message, content: [{ type: 'text', text: reply.text }] },
      }))
    )
      throw new Error('front_history_write_failed');
    if (
      terminal &&
      !(await service.db.gateway.call(sdkMessageWrites, 'saveSDKMessage', session.id, terminal))
    )
      throw new Error('front_history_write_failed');
    return reply.text;
  } catch (error) {
    const failure: SDKResultMessage = {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      uuid: neoDerivedId(`front-failure:${ask.requestId}`) as UUID,
      session_id: session.sdkSessionId ?? session.id,
      duration_ms: 0,
      duration_api_ms: 0,
      num_turns: 1,
      stop_reason: 'error',
      total_cost_usd: 0,
      modelUsage: {},
      permission_denials: [],
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        output_tokens_details: { thinking_tokens: 0 },
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
        inference_geo: '',
        iterations: [],
        server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
        service_tier: 'standard',
        speed: 'standard',
        fallback_credit: null,
      },
      errors: [
        `Convo could not reply (${abortController.signal.aborted ? 'deadline_exceeded' : phase}). See daemon logs.`,
      ],
    };
    await service.db.gateway.call(sdkMessageWrites, 'saveSDKMessage', session.id, failure);
    new Logger('NeoFront').warn('Front query failed', {
      phase: abortController.signal.aborted ? 'deadline_exceeded' : phase,
      provider: model.provider,
      model: model.model,
      errorType: error instanceof Error ? error.name : 'unknown',
    });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
