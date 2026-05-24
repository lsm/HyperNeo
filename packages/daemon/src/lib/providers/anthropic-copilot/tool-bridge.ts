/**
 * Tool-use bridge — maps Anthropic tool definitions to Copilot SDK Tool objects
 * and bridges tool_use / tool_result across two separate HTTP requests.
 *
 * ## Protocol mapping
 *
 * Anthropic tool-use protocol (client-side):
 *   Request 1: { tools: [toolA], messages: [...] }
 *     ← Response 1 (SSE): content_block { type:"tool_use", id, name, input }
 *                          stop_reason: "tool_use"
 *   Request 2: { messages: [..., tool_use, { type:"tool_result", tool_use_id: id }] }
 *     ← Response 2 (SSE): continued stream → stop_reason: "end_turn"
 *
 * Copilot SDK tool protocol (embedded in streaming session):
 *   session.send(prompt)
 *     → tool handler called: (args, invocation) => Promise<result>
 *       [handler suspends — waits for tool_result]
 *     → handler resumed with result → model continues streaming
 *
 * The bridge connects these two: the tool handler emits a tool_use SSE block,
 * ends the HTTP response, then suspends.  When Request 2 arrives its
 * tool_result is routed here via resolveToolResult(), resuming the handler.
 */

import type { Tool, ToolInvocation } from '@github/copilot-sdk';
import type { ServerResponse } from 'node:http';
import type { AnthropicTool } from './types.js';
import { AnthropicStreamWriter } from './sse.js';

/** How long (ms) a suspended tool handler waits for a tool_result before timing out. */
const TOOL_RESULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// ToolBridgeRegistry
// ---------------------------------------------------------------------------

/**
 * Manages the active SSE response and pending tool-handler Promises for one
 * Copilot session.
 *
 * Lifecycle:
 * 1. Created when a session is created (with tools).
 * 2. `setActiveResponse()` is called at the start of each streaming request.
 * 3. When the Copilot model calls a tool, the tool handler calls
 *    `emitToolUseAndWait()` which writes the SSE tool_use block and suspends.
 * 4. The next HTTP request calls `resolveToolResult()` to resume the handler.
 * 5. `rejectAll()` is called on error or session release to clean up.
 */
export class ToolBridgeRegistry {
  private pending = new Map<
    string,
    {
      resolve: (result: { text: string; isError: boolean }) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  private activeWriter: AnthropicStreamWriter | null = null;
  private activeRes: ServerResponse | null = null;

  /** Callback invoked when all tool_use blocks for one turn have been emitted. */
  private onToolUseEmitted: ((toolCallIds: string[]) => void) | null = null;

  /** Callback invoked when a pending tool call ID is registered. */
  private onPendingToolCall: ((toolCallId: string) => void) | null = null;

  /**
   * Buffer for tool calls waiting to be flushed to the SSE response.
   *
   * When the Copilot model emits parallel tool calls, all tool handlers fire
   * concurrently.  Each call to `emitToolUseAndWait` pushes an entry here
   * and schedules a single microtask flush via `queueMicrotask`.  The flush
   * writes all buffered `tool_use` blocks to the same HTTP response and ends
   * it once — correctly supporting N parallel tool calls in one turn.
   */
  private pendingEmissions: Array<{
    toolCallId: string;
    toolName: string;
    toolInput: unknown;
  }> = [];
  private flushScheduled = false;

  // ---------------------------------------------------------------------------
  // Response management
  // ---------------------------------------------------------------------------

  /** Set the active SSE writer + response for the current HTTP request. */
  setActiveResponse(writer: AnthropicStreamWriter, res: ServerResponse): void {
    this.activeWriter = writer;
    this.activeRes = res;
  }

  /** Clear the active response (called after tool_use SSE is emitted). */
  clearActiveResponse(): void {
    this.activeWriter = null;
    this.activeRes = null;
  }

  // ---------------------------------------------------------------------------
  // Callbacks used by the streaming loop
  // ---------------------------------------------------------------------------

  /** Register a callback to be notified when all tool_use blocks for one turn have been emitted. */
  setOnToolUseEmitted(cb: (toolCallIds: string[]) => void): void {
    this.onToolUseEmitted = cb;
  }

  /** Register a callback to be notified when a pending tool call ID is stored. */
  setOnPendingToolCall(cb: (toolCallId: string) => void): void {
    this.onPendingToolCall = cb;
  }

  // ---------------------------------------------------------------------------
  // Tool handler core
  // ---------------------------------------------------------------------------

  /**
   * Called from a Copilot SDK tool handler.
   *
   * Buffers the tool call and schedules a microtask flush.  If the Copilot
   * model emits parallel tool calls, all handlers call this method
   * concurrently before any microtask runs, so the flush will collect all
   * of them and emit every `tool_use` block in a single HTTP response.
   *
   * After the flush, this method suspends until `resolveToolResult()` is
   * called with the matching ID by the next HTTP request.
   */
  async emitToolUseAndWait(
    toolCallId: string,
    toolName: string,
    toolInput: unknown
  ): Promise<{ text: string; isError: boolean }> {
    // Buffer this tool call — parallel tool handlers all push here before
    // the microtask flush runs.
    this.pendingEmissions.push({ toolCallId, toolName, toolInput });

    // Schedule a single microtask to flush all buffered emissions.
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      queueMicrotask(() => {
        this.flushEmissions();
      });
    }

    // Suspend until the tool_result arrives from the next HTTP request.
    return new Promise<{ text: string; isError: boolean }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(toolCallId);
        reject(new Error(`Tool call "${toolName}" (${toolCallId}) timed out waiting for result`));
      }, TOOL_RESULT_TIMEOUT_MS);
      // Allow the process to exit naturally if nothing else is pending.
      timer.unref();

      this.pending.set(toolCallId, { resolve, reject, timer });
      // Notify ConversationManager so it can route the next request here.
      this.onPendingToolCall?.(toolCallId);
    });
  }

  /**
   * Flush all buffered tool-use emissions to the active SSE response.
   *
   * Writes every buffered `tool_use` block to the response and ends it once.
   * Called via `queueMicrotask` so all concurrent `emitToolUseAndWait` calls
   * in the same turn have had a chance to push their data before this runs.
   */
  private flushEmissions(): void {
    this.flushScheduled = false;
    const emissions = this.pendingEmissions.splice(0);
    if (emissions.length === 0) return;

    const writer = this.activeWriter;
    const res = this.activeRes;

    if (!writer || !res) {
      // The response was already closed (e.g. client disconnected, session
      // aborted, or setActiveResponse was never called) before the flush ran.
      // Reject each buffered tool handler immediately so it does not silently
      // hang for the full TTL.
      for (const { toolCallId, toolName } of emissions) {
        const pending = this.pending.get(toolCallId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(toolCallId);
          pending.reject(
            new Error(
              `ToolBridgeRegistry: no active SSE response when tool "${toolName}" was called. ` +
                'This is a bug — setActiveResponse() must be called before session.send().'
            )
          );
        }
      }
      return;
    }

    // Clear first so any further activity (e.g. req 'close') cannot double-write.
    this.clearActiveResponse();

    // Write all tool_use blocks to the same response, then end it once.
    for (const { toolCallId, toolName, toolInput } of emissions) {
      writer.writeToolUseBlock(res, toolCallId, toolName, toolInput);
    }
    writer.sendToolUseEpilogue(res);

    // Notify the streaming loop with ALL emitted tool call IDs for this turn.
    this.onToolUseEmitted?.(emissions.map((e) => e.toolCallId));
  }

  // ---------------------------------------------------------------------------
  // Tool result routing
  // ---------------------------------------------------------------------------

  /**
   * Route a tool_result from the client to the suspended tool handler.
   *
   * @returns `true` if there was a matching pending handler, `false` otherwise.
   */
  resolveToolResult(toolCallId: string, result: string, isError = false): boolean {
    const pending = this.pending.get(toolCallId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pending.delete(toolCallId);
    pending.resolve({ text: result, isError });
    return true;
  }

  /**
   * Reject all pending tool handlers (called on session error or release).
   *
   * Also clears the pending emissions buffer and cancels the scheduled
   * microtask flush, preventing stale SSE writes to a closed response.
   */
  rejectAll(err: Error): void {
    this.pendingEmissions = [];
    this.flushScheduled = false;
    this.clearActiveResponse();
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  /** `true` when there are tool handlers suspended waiting for results. */
  hasPending(): boolean {
    return this.pending.size > 0;
  }

  /** IDs of all currently pending tool calls. */
  pendingIds(): string[] {
    return [...this.pending.keys()];
  }
}

// ---------------------------------------------------------------------------
// mapAnthropicToolsToSdkTools
// ---------------------------------------------------------------------------

/**
 * Convert Anthropic tool definitions into Copilot SDK `Tool` objects.
 *
 * Each tool handler uses the registry to emit a `tool_use` SSE block and
 * suspend until the API caller provides the corresponding `tool_result`.
 *
 * `overridesBuiltInTool: true` is set on all tools so that Copilot CLI
 * built-in tools with the same name (e.g. "bash") are overridden rather than
 * causing a registration error.  For tool names that do not clash with a
 * built-in the flag is harmless.
 */
export function mapAnthropicToolsToSdkTools(
  tools: AnthropicTool[],
  registry: ToolBridgeRegistry
): Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? `Tool: ${tool.name}`,
    parameters: tool.input_schema,
    overridesBuiltInTool: true,
    handler: async (args: unknown, invocation: ToolInvocation) => {
      const { text, isError } = await registry.emitToolUseAndWait(
        invocation.toolCallId,
        tool.name,
        args
      );
      return {
        textResultForLlm: text,
        resultType: isError ? ('failure' as const) : ('success' as const),
      };
    },
  }));
}
