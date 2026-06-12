/**
 * ACP Query Adapter
 *
 * Bridges ACP protocol notifications to NeoKai's internal Query interface.
 * Implements AsyncGenerator<SDKMessage, void> plus interrupt(), close(),
 * sessionId getter, and setMcpServers().
 *
 * Accumulates streaming chunks into complete assistant messages before
 * yielding them to the consumer.
 */

import type {
  SDKControlGetContextUsageResponse,
  SDKMessage,
  McpSetServersResult,
  RewindFilesResult,
} from '@neokai/shared/sdk';
import type { AcpConfigOption, AcpContentBlock } from '@neokai/shared';
import { AcpClient } from './acp-client';
import { AcpMessageTranslator } from './acp-message-translator';
import type { QueryLike } from '../agent/query-like';

export class AcpQueryAdapter implements QueryLike {
  private client: AcpClient;
  private prompt: AcpContentBlock[];
  private translator: AcpMessageTranslator;
  private interrupted = false;
  private closed = false;

  constructor(client: AcpClient, prompt: AcpContentBlock[]) {
    this.client = client;
    this.prompt = prompt;
    const sessionId = client.getSessionId();
    if (!sessionId) {
      throw new Error('AcpClient has no active session');
    }
    this.translator = new AcpMessageTranslator(sessionId);
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage, void> {
    if (this.closed) {
      return;
    }

    try {
      for await (const notification of this.client.sendPrompt(this.prompt)) {
        if (this.interrupted) {
          break;
        }

        const messages = this.translator.processUpdate(notification.update);
        for (const msg of messages) {
          yield msg;
        }
      }

      // Flush any remaining accumulated chunks
      const flushMessages = this.translator.flush();
      for (const msg of flushMessages) {
        yield msg;
      }

      // Emit result message using the ACP stop reason if available
      const stopReason = this.client.getLastPromptStopReason() ?? 'end_turn';
      const isError = stopReason !== 'end_turn';
      yield this.translator.translateResult(stopReason, isError);
    } catch (err) {
      const errorReason = this.interrupted ? 'cancelled' : 'end_turn';
      yield this.translator.translateResult(errorReason, !this.interrupted);
      if (!this.interrupted) {
        throw err;
      }
    }
  }

  /**
   * Interrupt the current query turn.
   */
  async interrupt(): Promise<void> {
    if (this.closed || this.interrupted) return;
    this.interrupted = true;
    this.client.cancel();
  }

  /**
   * Close the underlying ACP client and transport.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.client.close();
  }

  /**
   * Get the ACP session ID.
   */
  get sessionId(): string {
    const id = this.client.getSessionId();
    if (!id) {
      throw new Error('AcpClient has no active session');
    }
    return id;
  }

  /**
   * Set MCP servers dynamically. No-op for PR 2 — dynamic MCP
   * updates will be implemented in PR 6.
   */
  setMcpServers(): Promise<McpSetServersResult> {
    return Promise.resolve({ added: [], removed: [], errors: {} });
  }

  async setModel(modelId: string): Promise<void> {
    const option = findConfigOption(this.client.getConfigOptions(), 'model');
    if (!option) {
      throw new Error('ACP session has no model config option');
    }
    await this.client.setConfigOption(option.id, modelId);
  }

  async setMaxThinkingTokens(tokens: number | null): Promise<void> {
    const option = findConfigOption(this.client.getConfigOptions(), 'thought_level');
    if (!option) {
      throw new Error('ACP session has no thought_level config option');
    }
    await this.client.setConfigOption(option.id, String(tokens ?? 'none'));
  }

  async getContextUsage(): Promise<SDKControlGetContextUsageResponse> {
    const usage = this.translator.getContextUsage();
    const totalTokens = usage?.used ?? 0;
    const maxTokens = usage?.size ?? 0;

    return {
      categories: [],
      totalTokens,
      maxTokens,
      rawMaxTokens: maxTokens,
      percentage: maxTokens > 0 ? (totalTokens / maxTokens) * 100 : 0,
      gridRows: [],
      model: 'acp',
      memoryFiles: [],
      mcpTools: [],
      agents: [],
      isAutoCompactEnabled: false,
      apiUsage: null,
    };
  }

  rewindFiles(_userMessageId: string, _options?: { dryRun?: boolean }): Promise<RewindFilesResult> {
    return Promise.resolve({
      canRewind: false,
      error: 'ACP sessions do not support file rewind yet.',
    });
  }
}

function findConfigOption(
  options: AcpConfigOption[],
  category: string
): AcpConfigOption | undefined {
  return options.find((option) => option.category === category);
}
