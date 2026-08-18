import type { Tool, ToolInvocation } from '@github/copilot-sdk';
import type { ServerResponse } from 'node:http';
import type { AnthropicTool } from './types.js';
import { AnthropicStreamWriter } from './sse.js';

const TOOL_RESULT_TIMEOUT_MS = 5 * 60 * 1000;

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

  private onToolUseEmitted: ((toolCallIds: string[]) => void) | null = null;

  private onPendingToolCall: ((toolCallId: string) => void) | null = null;

  private pendingEmissions: Array<{
    toolCallId: string;
    toolName: string;
    toolInput: unknown;
  }> = [];
  private flushScheduled = false;

  setActiveResponse(writer: AnthropicStreamWriter, res: ServerResponse): void {
    this.activeWriter = writer;
    this.activeRes = res;
  }

  clearActiveResponse(): void {
    this.activeWriter = null;
    this.activeRes = null;
  }

  setOnToolUseEmitted(cb: (toolCallIds: string[]) => void): void {
    this.onToolUseEmitted = cb;
  }

  setOnPendingToolCall(cb: (toolCallId: string) => void): void {
    this.onPendingToolCall = cb;
  }

  async emitToolUseAndWait(
    toolCallId: string,
    toolName: string,
    toolInput: unknown
  ): Promise<{ text: string; isError: boolean }> {
    this.pendingEmissions.push({ toolCallId, toolName, toolInput });

    if (!this.flushScheduled) {
      this.flushScheduled = true;
      queueMicrotask(() => {
        this.flushEmissions();
      });
    }

    return new Promise<{ text: string; isError: boolean }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(toolCallId);
        reject(new Error(`Tool call "${toolName}" (${toolCallId}) timed out waiting for result`));
      }, TOOL_RESULT_TIMEOUT_MS);
      timer.unref();

      this.pending.set(toolCallId, { resolve, reject, timer });
      this.onPendingToolCall?.(toolCallId);
    });
  }

  private flushEmissions(): void {
    this.flushScheduled = false;
    const emissions = this.pendingEmissions.splice(0);
    if (emissions.length === 0) return;

    const writer = this.activeWriter;
    const res = this.activeRes;

    if (!writer || !res) {
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

    this.clearActiveResponse();

    for (const { toolCallId, toolName, toolInput } of emissions) {
      writer.writeToolUseBlock(res, toolCallId, toolName, toolInput);
    }
    writer.sendToolUseEpilogue(res);

    this.onToolUseEmitted?.(emissions.map((e) => e.toolCallId));
  }

  resolveToolResult(toolCallId: string, result: string, isError = false): boolean {
    const pending = this.pending.get(toolCallId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pending.delete(toolCallId);
    pending.resolve({ text: result, isError });
    return true;
  }

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

  hasPending(): boolean {
    return this.pending.size > 0;
  }

  pendingIds(): string[] {
    return [...this.pending.keys()];
  }
}

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
