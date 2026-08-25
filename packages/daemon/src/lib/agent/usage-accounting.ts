export type UsageAccountingState = {
  messageCount: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  totalCost: number;
  toolCallCount: number;
  lastSdkCost: number;
  costBaseline: number;
};

export type SDKUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

export type ResultUsage = {
  usage: SDKUsage;
  total_cost_usd?: number;
};

export function recordResultUsage(
  state: UsageAccountingState,
  result: ResultUsage
): UsageAccountingState {
  const usage = result.usage ?? { input_tokens: 0, output_tokens: 0 };
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const totalTokens = inputTokens + outputTokens;
  const sdkCost = result.total_cost_usd || 0;
  const adjustedBaseline =
    sdkCost < state.lastSdkCost && state.lastSdkCost > 0
      ? state.costBaseline + state.lastSdkCost
      : state.costBaseline;

  return {
    messageCount: state.messageCount + 1,
    totalTokens: state.totalTokens + totalTokens,
    inputTokens: state.inputTokens + inputTokens,
    outputTokens: state.outputTokens + outputTokens,
    totalCost: adjustedBaseline + sdkCost,
    toolCallCount: state.toolCallCount,
    lastSdkCost: sdkCost,
    costBaseline: adjustedBaseline,
  };
}

export function commitPendingCost(state: UsageAccountingState): UsageAccountingState {
  if (state.lastSdkCost <= 0) {
    return state;
  }

  const costBaseline = state.costBaseline + state.lastSdkCost;
  return {
    ...state,
    costBaseline,
    lastSdkCost: 0,
    totalCost: costBaseline,
  };
}
