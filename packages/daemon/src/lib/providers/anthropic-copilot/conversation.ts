import { approveAll, type CopilotClient, type CopilotSession } from '@github/copilot-sdk';
import type { AnthropicMessage, AnthropicTool } from './types.js';
import {
  extractToolResultIds,
  extractToolResultContent,
  extractToolResultIsError,
} from './prompt.js';
import { mapAnthropicToolsToSdkTools, ToolBridgeRegistry } from './tool-bridge.js';
import { Logger } from '../../logger.js';

const logger = new Logger('anthropic-copilot-conversation');

const CONVERSATION_TTL_MS = 10 * 60 * 1000;

export interface ActiveConversation {
  readonly session: CopilotSession;
  readonly registry: ToolBridgeRegistry;
}

export interface ToolResult {
  toolUseId: string;
  result: string;
  isError?: boolean;
}

export class ConversationManager {
  private byToolCallId = new Map<string, ActiveConversation>();
  private cleanupTimers = new Map<ActiveConversation, ReturnType<typeof setTimeout>>();

  findContinuation(messages: AnthropicMessage[]):
    | {
        conv: ActiveConversation;
        toolResults: ToolResult[];
      }
    | undefined {
    const ids = extractToolResultIds(messages);
    if (ids.length === 0) return undefined;

    let found: ActiveConversation | undefined;
    for (const id of ids) {
      const conv = this.byToolCallId.get(id);
      if (!conv) {
        logger.debug(
          `tool_result for ${id} has no active conversation (historical or TTL-expired)`
        );
        continue;
      }
      if (!found) found = conv;
    }
    if (!found) return undefined;

    const conv = found;
    const toolResults: ToolResult[] = [];
    for (const id of ids) {
      if (this.byToolCallId.get(id) !== conv) continue;
      const result = extractToolResultContent(messages, id);
      if (result !== undefined) {
        toolResults.push({
          toolUseId: id,
          result,
          isError: extractToolResultIsError(messages, id),
        });
      }
    }
    if (toolResults.length === 0) return undefined;
    return { conv, toolResults };
  }

  async createConversation(
    client: CopilotClient,
    model: string,
    systemMessage: string | undefined,
    tools: AnthropicTool[],
    cwd: string
  ): Promise<ActiveConversation> {
    const registry = new ToolBridgeRegistry();

    let conv: ActiveConversation | undefined;
    registry.setOnPendingToolCall((toolCallId) => {
      if (!conv)
        throw new Error('[anthropic-copilot] tool call registered before conversation was created');
      this.byToolCallId.set(toolCallId, conv);
      this.scheduleCleanup(conv);
    });

    const sdkTools = mapAnthropicToolsToSdkTools(tools, registry);
    const toolNames = tools.map((t) => t.name);

    const session = await client.createSession({
      clientName: 'neokai-anthropic-copilot',
      model,
      streaming: true,
      infiniteSessions: { enabled: false },
      workingDirectory: cwd,
      tools: sdkTools,
      availableTools: toolNames,
      ...(systemMessage
        ? { systemMessage: { mode: 'replace' as const, content: systemMessage } }
        : {}),
      onPermissionRequest: approveAll,
      onUserInputRequest: () =>
        Promise.resolve({ answer: 'User input is not available in API mode.', wasFreeform: true }),
      hooks: {
        onPreToolUse: () => Promise.resolve({ permissionDecision: 'allow' as const }),
        onPostToolUse: () => {},
        onErrorOccurred: (input) => {
          const errorMsg = typeof input.error === 'string' ? input.error : String(input.error);
          logger.warn(
            `SDK error (${input.errorContext}, recoverable=${String(input.recoverable)}): ${errorMsg}`
          );
          const isQuotaError =
            errorMsg.includes('402') ||
            errorMsg.toLowerCase().includes('no quota') ||
            errorMsg.toLowerCase().includes('quota exceeded') ||
            errorMsg.toLowerCase().includes('insufficient_quota');
          if (
            !isQuotaError &&
            input.recoverable &&
            (input.errorContext === 'model_call' || input.errorContext === 'tool_execution')
          ) {
            return { errorHandling: 'retry' as const, retryCount: 2 };
          }
          return undefined;
        },
      },
    });

    conv = { session, registry };
    return conv;
  }

  acknowledgeContinuation(conv: ActiveConversation, toolUseIds: string[]): void {
    for (const id of toolUseIds) {
      this.byToolCallId.delete(id);
    }
    this.cancelCleanup(conv);
  }

  async releaseConversation(conv: ActiveConversation): Promise<void> {
    this.cancelCleanup(conv);

    for (const [id, c] of this.byToolCallId) {
      if (c === conv) this.byToolCallId.delete(id);
    }

    conv.registry.rejectAll(new Error('Conversation released'));

    await conv.session.disconnect().catch((err: unknown) => {
      logger.warn('Error disconnecting conversation session:', err);
    });
  }

  cleanupConversation(conv: ActiveConversation): void {
    this.cancelCleanup(conv);
    for (const [id, c] of this.byToolCallId) {
      if (c === conv) this.byToolCallId.delete(id);
    }
    conv.registry.rejectAll(new Error('Conversation complete'));
  }

  async shutdown(): Promise<void> {
    const convs = new Set<ActiveConversation>([
      ...this.byToolCallId.values(),
      ...this.cleanupTimers.keys(),
    ]);
    await Promise.allSettled([...convs].map((c) => this.releaseConversation(c)));
  }

  private scheduleCleanup(conv: ActiveConversation): void {
    this.cancelCleanup(conv);
    const timer = setTimeout(() => {
      this.cleanupTimers.delete(conv);
      logger.warn('Conversation TTL expired — releasing stale session');
      this.releaseConversation(conv).catch(() => {});
    }, CONVERSATION_TTL_MS);
    timer.unref();
    this.cleanupTimers.set(conv, timer);
  }

  private cancelCleanup(conv: ActiveConversation): void {
    const timer = this.cleanupTimers.get(conv);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.cleanupTimers.delete(conv);
    }
  }
}
