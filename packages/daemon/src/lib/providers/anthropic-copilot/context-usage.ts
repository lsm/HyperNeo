import { extractSystemText } from './prompt.js';
import { estimateTokens } from './sse.js';
import type { AnthropicRequest, AnthropicTool } from './types.js';

export interface CopilotUsageInfoData {
  conversationTokens?: number;
  currentTokens: number;
  isInitial?: boolean;
  messagesLength: number;
  systemTokens?: number;
  tokenLimit: number;
  toolDefinitionsTokens?: number;
}

export interface BridgeContextUsageSnapshot {
  model: string;
  systemTokens: number;
  toolDefinitionsTokens: number;
  conversationTokens: number;
  totalTokens: number;
  currentTokens: number;
  promptTokenLimit: number;
  limit: number;
  freeSpaceTokens: number;
  bufferTokens: number;
  messagesLength: number;
  updatedAt: number;
}

export interface BridgeCountTokensResponse {
  input_tokens: number;
  context: BridgeContextUsageSnapshot;
}

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_BUFFER_EXHAUSTION_THRESHOLD = 0.95;
const MAX_DEFAULT_OUTPUT_TOKENS = 32_000;
const MAX_OPUS_1M_OUTPUT_TOKENS = 64_000;

function positiveInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.round(value));
}

function getBufferExhaustionThreshold(): number {
  const raw = process.env.COPILOT_BUFFER_EXHAUSTION_THRESHOLD;
  if (!raw) return DEFAULT_BUFFER_EXHAUSTION_THRESHOLD;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : DEFAULT_BUFFER_EXHAUSTION_THRESHOLD;
}

function outputTokenReserve(model: string, outputTokenLimit = 0): number {
  const maxOutputTokens =
    model === 'claude-opus-4.6-1m' ? MAX_OPUS_1M_OUTPUT_TOKENS : MAX_DEFAULT_OUTPUT_TOKENS;
  return Math.min(maxOutputTokens, Math.max(0, outputTokenLimit));
}

export function computeCopilotBufferTokens(
  model: string,
  promptTokenLimit: number,
  outputTokenLimit = 0
): number {
  const outputReserve = outputTokenReserve(model, outputTokenLimit);
  const exhaustionReserve = Math.floor(
    promptTokenLimit * Math.max(0, 1 - getBufferExhaustionThreshold())
  );
  return outputReserve + exhaustionReserve;
}

export function snapshotFromUsageInfo(
  model: string,
  data: CopilotUsageInfoData,
  outputTokenLimit = 0
): BridgeContextUsageSnapshot {
  const systemTokens = positiveInt(data.systemTokens) ?? 0;
  const toolDefinitionsTokens = positiveInt(data.toolDefinitionsTokens) ?? 0;
  const currentTokens = positiveInt(data.currentTokens) ?? 0;
  const conversationTokens =
    positiveInt(data.conversationTokens) ??
    Math.max(0, currentTokens - systemTokens - toolDefinitionsTokens);
  const promptTokenLimit = positiveInt(data.tokenLimit) ?? DEFAULT_CONTEXT_WINDOW;
  const bufferTokens = computeCopilotBufferTokens(model, promptTokenLimit, outputTokenLimit);
  const limit = promptTokenLimit + outputTokenReserve(model, outputTokenLimit);
  const totalTokens =
    currentTokens > 0 ? currentTokens : systemTokens + toolDefinitionsTokens + conversationTokens;
  const freeSpaceTokens = Math.max(
    0,
    limit - systemTokens - toolDefinitionsTokens - conversationTokens - bufferTokens
  );

  return {
    model,
    systemTokens,
    toolDefinitionsTokens,
    conversationTokens,
    totalTokens,
    currentTokens: totalTokens,
    promptTokenLimit,
    limit,
    freeSpaceTokens,
    bufferTokens,
    messagesLength: positiveInt(data.messagesLength) ?? 0,
    updatedAt: Date.now(),
  };
}

function toolText(tools: AnthropicTool[] | undefined): string {
  if (!tools || tools.length === 0) return '';
  return JSON.stringify(
    tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      input_schema: tool.input_schema ?? {},
    }))
  );
}

export function estimateRequestUsage(body: AnthropicRequest): BridgeContextUsageSnapshot {
  const systemText = extractSystemText(body.system) ?? '';
  const systemTokens = estimateTokens(systemText.length);
  const toolDefinitionsTokens = estimateTokens(toolText(body.tools).length);
  const conversationTokens = estimateTokens(JSON.stringify(body.messages).length);
  const promptTokenLimit = DEFAULT_CONTEXT_WINDOW;
  const outputTokenLimit = positiveInt(body.max_tokens) ?? 0;
  const bufferTokens = computeCopilotBufferTokens(body.model, promptTokenLimit, outputTokenLimit);
  const limit = promptTokenLimit + outputTokenReserve(body.model, outputTokenLimit);
  const totalTokens = systemTokens + toolDefinitionsTokens + conversationTokens;

  return {
    model: body.model,
    systemTokens,
    toolDefinitionsTokens,
    conversationTokens,
    totalTokens,
    currentTokens: totalTokens,
    promptTokenLimit,
    limit,
    freeSpaceTokens: Math.max(
      0,
      limit - systemTokens - toolDefinitionsTokens - conversationTokens - bufferTokens
    ),
    bufferTokens,
    messagesLength: body.messages.length,
    updatedAt: Date.now(),
  };
}

export class ContextUsageStore {
  private readonly bySession = new WeakMap<object, BridgeContextUsageSnapshot>();
  private readonly byRequestKey = new Map<string, BridgeContextUsageSnapshot>();

  updateForSession(
    session: object,
    requestKey: string,
    model: string,
    data: CopilotUsageInfoData,
    outputTokenLimit = 0
  ): BridgeContextUsageSnapshot {
    const snapshot = snapshotFromUsageInfo(model, data, outputTokenLimit);
    this.bySession.set(session, snapshot);
    this.byRequestKey.set(requestKey, snapshot);
    return snapshot;
  }

  getForSession(session: object): BridgeContextUsageSnapshot | undefined {
    return this.bySession.get(session);
  }

  getForRequestKey(requestKey: string): BridgeContextUsageSnapshot | undefined {
    return this.byRequestKey.get(requestKey);
  }

  deleteRequestKey(requestKey: string): void {
    this.byRequestKey.delete(requestKey);
  }
}

export function countTokensResponse(
  tokenSnapshot: BridgeContextUsageSnapshot,
  contextSnapshot: BridgeContextUsageSnapshot = tokenSnapshot
): BridgeCountTokensResponse {
  return {
    input_tokens: Math.max(1, tokenSnapshot.totalTokens),
    context: contextSnapshot,
  };
}
