import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { NeoModelPreference } from '@hyperneo/shared';
import type { NeoConversationAsk } from '@hyperneo/shared/types/neo-conversation-ask';
import { NEO_FRONT } from '@hyperneo/prompts';
import { z } from 'zod';
import { neoFrontReads } from '../../storage/repositories/neo-front-read-worker.ts';
import { oneShotModelIds, readAssistantReply } from '../agent/one-shot-model.ts';
import { awaitSDKCliPath, isRunningUnderBun } from '../agent/sdk-cli-resolver.ts';
import { getProviderService } from '../provider-service.ts';
import { neoDerivedId } from './derived-id.ts';
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
  const env = await getProviderService().getIsolatedEnvForModel(model.provider, model.model);
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), 15000);
  let text = '';
  try {
    const messages = query({
      prompt: (async function* () {
        yield {
          type: 'user',
          session_id: '',
          parent_tool_use_id: null,
          uuid: ask.requestId,
          message: { role: 'user', content: ask.content },
        } as SDKUserMessage;
      })(),
      options: {
        model: oneShotModelIds(model.provider, model.model, env).model,
        env,
        systemPrompt: NEO_FRONT,
        tools: [],
        settingSources: [],
        strictMcpConfig: true,
        allowedTools: tools.map((entry) => `mcp__front__${entry.name}`),
        mcpServers: { front: createSdkMcpServer({ name: 'front', tools }) },
        permissionMode: 'dontAsk',
        maxTurns: 4,
        persistSession: false,
        thinking: { type: 'disabled' },
        abortController,
        pathToClaudeCodeExecutable: await awaitSDKCliPath(),
        executable: isRunningUnderBun() ? 'bun' : undefined,
      },
    });
    for await (const message of messages) {
      if (message.type === 'result' && message.subtype !== 'success') return null;
      if (message.type === 'assistant') {
        const reply = readAssistantReply(message);
        if ('error' in reply) return null;
        if (reply.text) text = reply.text;
      }
    }
    const reply = Reply.safeParse(JSON.parse(text));
    return reply.success && (reply.data.kind !== 'status' || grounded) ? reply.data.text : null;
  } finally {
    clearTimeout(timer);
  }
}
