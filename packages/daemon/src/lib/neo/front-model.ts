import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import type { UUID } from 'node:crypto';
import type { SDKAssistantMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  AUTO_COMPACT_PERCENT_DEFAULT,
  THINKING_LEVEL_TOKENS,
  THINKING_LEVEL_EFFORT,
  type NeoModelPreference,
} from '@hyperneo/shared';
import type { NeoConversationAsk } from '@hyperneo/shared/types/neo-conversation-ask';
import { NEO_FRONT } from '@hyperneo/prompts';
import { z } from 'zod';
import { neoFrontReads } from '../../storage/repositories/neo-front-read-worker.ts';
import { oneShotModelIds, readAssistantReply } from '../agent/one-shot-model.ts';
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
    CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(AUTO_COMPACT_PERCENT_DEFAULT),
  };
  delete env.CLAUDE_CODE_DISABLE_THINKING;
  const budget = THINKING_LEVEL_TOKENS[model.thinkingLevel];
  let phase = 'sdk_path';
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), 15000);
  let text = '';
  let structured: unknown;
  try {
    const pathToClaudeCodeExecutable = await awaitSDKCliPath();
    phase = 'sdk_query';
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
          !history.saveSDKMessage(session.id, input, 'human')
        )
          throw new Error('front_history_write_failed');
        yield input;
      })(),
      options: {
        model: oneShotModelIds(model.provider, model.model, env).model,
        env,
        systemPrompt: NEO_FRONT,
        outputFormat: { type: 'json_schema', schema: z.toJSONSchema(Reply) },
        tools: [],
        settingSources: [],
        strictMcpConfig: true,
        allowedTools: tools.map((entry) => `mcp__front__${entry.name}`),
        mcpServers: { front: createSdkMcpServer({ name: 'front', tools }) },
        permissionMode: 'dontAsk',
        maxTurns: 4,
        persistSession: true,
        ...(session.sdkSessionId ? { resume: session.sdkSessionId } : { sessionId: session.id }),
        cwd: session.workspacePath ?? undefined,
        thinking:
          budget === undefined ? { type: 'disabled' } : { type: 'enabled', budgetTokens: budget },
        effort: THINKING_LEVEL_EFFORT[model.thinkingLevel],
        abortController,
        pathToClaudeCodeExecutable,
        executable: isRunningUnderBun() ? 'bun' : undefined,
      },
    });
    for await (const message of messages) {
      if (message.type === 'system' && message.subtype === 'init')
        await service.db.updateSession(session.id, { sdkSessionId: message.session_id });
      if (message.type === 'result') {
        if (message.subtype !== 'success') throw new Error(message.subtype);
        structured = message.structured_output;
      }
      if (message.type === 'assistant') {
        assistant = message;
        const reply = readAssistantReply(message);
        if ('error' in reply) throw new Error(`front_sdk_${message.error}`);
        if (reply.text) text = reply.text;
      }
    }
    phase = 'reply_validation';
    const reply = Reply.parse(
      structured ?? JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''))
    );
    if (reply.kind === 'status' && !grounded) {
      new Logger('NeoFront').warn('Front status reply lacked a fresh grounding read');
      return null;
    }
    if (
      assistant &&
      !history.saveSDKMessage(session.id, {
        ...assistant,
        message: { ...assistant.message, content: [{ type: 'text', text: reply.text }] },
      })
    )
      throw new Error('front_history_write_failed');
    return reply.text;
  } catch (error) {
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
