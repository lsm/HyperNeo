import type {
  SDKControlGetContextUsageResponse,
  SDKControlInterruptResponse,
  SDKMessage,
  McpSetServersResult,
  RewindFilesResult,
} from '@hyperneo/shared/sdk';
import type { AcpConfigOption, AcpContentBlock } from '@hyperneo/shared';
import { AcpClient } from './acp-client.ts';
import { AcpMessageTranslator } from './acp-message-translator.ts';
import type { QueryLike } from '../agent/query-like.ts';

export class AcpQueryAdapter implements QueryLike {
  private client: AcpClient;
  private prompt: AcpContentBlock[];
  private translator: AcpMessageTranslator;
  private interrupted = false;
  private closed = false;

  constructor(
    client: AcpClient,
    prompt: AcpContentBlock[],
    private readonly options: {
      contextWindow?: number;
      initialUsageEstimate?: number;
      onContextUsageUpdate?: (used: number) => void;
      onConfigOptionsUpdate?: (configOptions: AcpConfigOption[]) => void;
      onSubmitted?: () => void;
      onAccepted?: () => void;
    } = {}
  ) {
    this.client = client;
    this.prompt = prompt;
    const sessionId = client.getSessionId();
    if (!sessionId) {
      throw new Error('AcpClient has no active session');
    }
    const promptTokenEstimate = estimatePromptTokens(prompt);
    this.translator = new AcpMessageTranslator(
      sessionId,
      options.contextWindow,
      (options.initialUsageEstimate ?? 0) + promptTokenEstimate,
      promptTokenEstimate
    );
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage, void> {
    if (this.closed) {
      return;
    }

    try {
      for await (const notification of this.client.sendPrompt(this.prompt, {
        onSubmitted: this.options.onSubmitted,
        onAccepted: this.options.onAccepted,
      })) {
        if (this.interrupted) {
          break;
        }

        if (notification.update.sessionUpdate === 'config_option_update') {
          this.client.updateConfigOptions(notification.update.configOptions);
          this.options.onConfigOptionsUpdate?.(notification.update.configOptions);
        }

        const messages = this.translator.processUpdate(notification.update);
        for (const msg of messages) {
          yield msg;
        }
      }

      const flushMessages = this.flushPendingMessages();
      for (const msg of flushMessages) {
        yield msg;
      }

      this.notifyContextUsage();

      const stopReason = this.client.getLastPromptStopReason() ?? 'end_turn';
      const isError = stopReason !== 'end_turn';
      yield this.translator.translateResult(stopReason, isError);
    } catch (err) {
      for (const msg of this.translator.flushToolResults()) {
        yield msg;
      }
      const errorReason = this.interrupted ? 'cancelled' : 'end_turn';
      yield this.translator.translateResult(errorReason, !this.interrupted);
      if (!this.interrupted) {
        throw err;
      }
    }
  }

  async interrupt(): Promise<SDKControlInterruptResponse | undefined> {
    if (this.closed || this.interrupted) return undefined;
    this.interrupted = true;
    this.client.cancel();
    return undefined;
  }

  flushPendingMessages(): SDKMessage[] {
    return [...this.translator.flush(), ...this.translator.flushToolResults()];
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.client.close();
  }

  get sessionId(): string {
    const id = this.client.getSessionId();
    if (!id) {
      throw new Error('AcpClient has no active session');
    }
    return id;
  }

  setMcpServers(): Promise<McpSetServersResult> {
    return Promise.resolve({ added: [], removed: [], errors: {} });
  }

  async setModel(modelId: string): Promise<void> {
    const option = findConfigOption(this.client.getConfigOptions(), 'model');
    if (!option) {
      throw new Error('ACP session has no model config option');
    }
    const configOptions = await this.client.setConfigOption(option.id, modelId);
    this.options.onConfigOptionsUpdate?.(configOptions);
  }

  async setMaxThinkingTokens(tokens: number | null): Promise<void> {
    const option = findConfigOption(this.client.getConfigOptions(), 'thought_level');
    if (!option) {
      throw new Error('ACP session has no thought_level config option');
    }
    const value = selectThoughtLevelValue(option, tokens);
    const configOptions = await this.client.setConfigOption(option.id, value);
    this.options.onConfigOptionsUpdate?.(configOptions);
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

  private notifyContextUsage(): void {
    const usage = this.translator.getContextUsage();
    if (usage) {
      this.options.onContextUsageUpdate?.(usage.used);
    }
  }
}

function estimatePromptTokens(prompt: AcpContentBlock[]): number {
  return Math.ceil(JSON.stringify(prompt).length / 4);
}

function findConfigOption(
  options: AcpConfigOption[],
  category: string
): AcpConfigOption | undefined {
  return options.find((option) => option.category === category);
}

function selectThoughtLevelValue(option: AcpConfigOption, tokens: number | null): string {
  const choices = flattenConfigChoices(option);
  if (choices.length === 0) return option.currentValue;

  if (!tokens || tokens <= 0) {
    return choices.find(isOffThoughtChoice)?.value ?? choices[0].value;
  }

  const exact = choices.find((choice) => parseThoughtTokenValue(choice) === tokens);
  if (exact) return exact.value;

  const enabledChoices = choices.filter((choice) => !isOffThoughtChoice(choice));
  if (enabledChoices.length === 0) return option.currentValue;

  const sorted = [...enabledChoices].sort(
    (a, b) => (parseThoughtTokenValue(a) ?? 0) - (parseThoughtTokenValue(b) ?? 0)
  );
  const sizedChoices = sorted.filter((choice) => parseThoughtTokenValue(choice) !== undefined);
  if (sizedChoices.length > 0) {
    return (
      sizedChoices.find((choice) => (parseThoughtTokenValue(choice) ?? 0) >= tokens)?.value ??
      sizedChoices.at(-1)!.value
    );
  }

  if (enabledChoices.length === 1) return enabledChoices[0].value;
  if (enabledChoices.length === 2) return enabledChoices[tokens >= 8000 ? 1 : 0].value;

  const index = tokens >= 24000 ? enabledChoices.length - 1 : tokens >= 16000 ? 1 : 0;
  return enabledChoices[Math.min(index, enabledChoices.length - 1)].value;
}

function isOffThoughtChoice(choice: { name: string; value: string }): boolean {
  const text = `${choice.value} ${choice.name}`.toLowerCase();
  return /\b(off|none|disabled|disable|false|0)\b/.test(text);
}

function parseThoughtTokenValue(choice: { name: string; value: string }): number | undefined {
  const text = `${choice.value} ${choice.name}`.toLowerCase();
  const match = text.match(/(?:think)?(\d+)k\b/);
  if (match) return Number(match[1]) * 1000;
  return undefined;
}

function flattenConfigChoices(option: AcpConfigOption): Array<{ name: string; value: string }> {
  return option.options.flatMap((entry) => ('options' in entry ? entry.options : [entry]));
}
