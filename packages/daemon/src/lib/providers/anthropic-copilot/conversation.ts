/**
 * ConversationManager — tracks active Copilot sessions that are suspended
 * waiting for tool results.
 *
 * ## Why this exists
 *
 * The Anthropic API is stateless: every HTTP request carries the full message
 * history.  Tool use requires two requests:
 *
 *   Request 1: user prompt → model decides to call a tool
 *              → SSE: tool_use block, stop_reason: "tool_use"
 *   Request 2: tool_result in messages → model continues
 *              → SSE: more text, stop_reason: "end_turn"
 *
 * Between these requests the Copilot session must remain alive (its tool
 * handler Promise is still pending).  ConversationManager stores active
 * sessions keyed by their pending tool_call_id so Request 2 can find the
 * right session and resume it.
 *
 * ## Session reuse scope
 *
 * Only tool-use continuations reuse sessions.  Plain text responses use a
 * fresh session per request (session-per-request model avoids cross-session
 * contamination when a HyperNeo chat session makes many independent calls).
 */

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

/** Inactive conversations are released after this many ms with no activity. */
const CONVERSATION_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ActiveConversation {
  readonly session: CopilotSession;
  readonly registry: ToolBridgeRegistry;
}

export interface ToolResult {
  toolUseId: string;
  result: string;
  /** When `true` the tool call failed; passed to the Copilot SDK as `resultType: 'failure'`. */
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// ConversationManager
// ---------------------------------------------------------------------------

export class ConversationManager {
  /** Maps pending tool_call_id → the conversation that is waiting for it. */
  private byToolCallId = new Map<string, ActiveConversation>();
  /** TTL timers keyed by conversation (using object identity). */
  private cleanupTimers = new Map<ActiveConversation, ReturnType<typeof setTimeout>>();

  // ---------------------------------------------------------------------------
  // Look-up
  // ---------------------------------------------------------------------------

  /**
   * If the messages array ends with `tool_result` blocks that match a pending
   * tool call, return the active conversation and the tool results to deliver.
   * Returns `undefined` when this is a brand-new conversation.
   */
  findContinuation(messages: AnthropicMessage[]):
    | {
        conv: ActiveConversation;
        toolResults: ToolResult[];
      }
    | undefined {
    const ids = extractToolResultIds(messages);
    if (ids.length === 0) return undefined;

    // First pass: find the conversation that owns the first known tool call ID.
    // The Anthropic protocol sends the full message history on every request, so
    // historical (already-resolved) tool_result IDs are expected to be absent from
    // byToolCallId — log at debug level to avoid noise in multi-turn conversations.
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

    // Second pass: collect only the tool results registered to that conversation.
    // For parallel tool calls (multiple tools in one turn) all IDs belong to the
    // same session; this guard prevents cross-session pollution in edge cases.
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
    // If no tool results could be matched (malformed messages), treat as new conversation.
    if (toolResults.length === 0) return undefined;
    return { conv, toolResults };
  }

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  /**
   * Create a new conversation: instantiate a fresh Copilot session with the
   * incoming Anthropic tool definitions registered as SDK external tools.
   */
  async createConversation(
    client: CopilotClient,
    model: string,
    systemMessage: string | undefined,
    tools: AnthropicTool[],
    cwd: string
  ): Promise<ActiveConversation> {
    const registry = new ToolBridgeRegistry();

    // Declare conv with `let` BEFORE registering the callback so the closure
    // captures the mutable binding (not a TDZ const reference).  conv is
    // assigned after createSession() returns — tool handlers are only called
    // after session.send() which happens after createConversation() completes,
    // so `conv` is always initialized by the time the callback fires.
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
      // No disk persistence for bridged sessions — state is managed here.
      infiniteSessions: { enabled: false },
      workingDirectory: cwd,
      tools: sdkTools,
      // Restrict the model to only the caller-registered tools so it cannot
      // use Copilot's built-in bash/file tools autonomously.
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
          // Do not retry quota/payment errors — they will not resolve with retries.
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

  // ---------------------------------------------------------------------------
  // Acknowledge continuation (cleanup before resumeSessionStreaming)
  // ---------------------------------------------------------------------------

  /**
   * Remove routing entries and cancel the TTL timer for a conversation that is
   * about to be resumed.  Must be called BEFORE `resumeSessionStreaming()` so
   * that (a) duplicate routing is prevented and (b) the TTL does not fire while
   * the tool result is being processed.
   *
   * Actual Promise resolution is left to `resumeSessionStreaming` (which calls
   * `registry.resolveToolResult()` AFTER setting up event listeners).
   */
  acknowledgeContinuation(conv: ActiveConversation, toolUseIds: string[]): void {
    for (const id of toolUseIds) {
      this.byToolCallId.delete(id);
    }
    // Cancel any TTL cleanup — the conversation is still active.
    this.cancelCleanup(conv);
  }

  // ---------------------------------------------------------------------------
  // Release
  // ---------------------------------------------------------------------------

  /**
   * Release a completed conversation: disconnect the session, reject any
   * still-pending tool calls, and remove all routing entries.
   */
  async releaseConversation(conv: ActiveConversation): Promise<void> {
    this.cancelCleanup(conv);

    // Remove all tool_call_id entries for this conversation.
    for (const [id, c] of this.byToolCallId) {
      if (c === conv) this.byToolCallId.delete(id);
    }

    conv.registry.rejectAll(new Error('Conversation released'));

    await conv.session.disconnect().catch((err: unknown) => {
      logger.warn('Error disconnecting conversation session:', err);
    });
  }

  /**
   * Clean up a conversation whose session was already disconnected by `streamSession`.
   *
   * Use this after `resumeSessionStreaming` / `runSessionStreaming` returns
   * `{ kind: 'completed' }` — the session has already been disconnected inside
   * `streamSession`, so calling `session.disconnect()` again is unnecessary.
   * Removes routing entries and rejects any leftover pending tool calls.
   */
  cleanupConversation(conv: ActiveConversation): void {
    this.cancelCleanup(conv);
    for (const [id, c] of this.byToolCallId) {
      if (c === conv) this.byToolCallId.delete(id);
    }
    conv.registry.rejectAll(new Error('Conversation complete'));
  }

  // ---------------------------------------------------------------------------
  // Shutdown
  // ---------------------------------------------------------------------------

  /**
   * Release all active conversations.  Call before daemon shutdown to ensure
   * suspended tool-handler Promises are rejected and TTL timers are cleared so
   * the event loop can exit cleanly.
   */
  async shutdown(): Promise<void> {
    const convs = new Set<ActiveConversation>([
      ...this.byToolCallId.values(),
      ...this.cleanupTimers.keys(),
    ]);
    await Promise.allSettled([...convs].map((c) => this.releaseConversation(c)));
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private scheduleCleanup(conv: ActiveConversation): void {
    this.cancelCleanup(conv);
    const timer = setTimeout(() => {
      this.cleanupTimers.delete(conv);
      logger.warn('Conversation TTL expired — releasing stale session');
      this.releaseConversation(conv).catch(() => {});
    }, CONVERSATION_TTL_MS);
    // Allow the process to exit naturally even if this timer is still pending.
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
