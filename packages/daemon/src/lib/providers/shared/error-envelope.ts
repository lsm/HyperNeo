import type { AnthropicErrorType } from '@hyperneo/shared/provider/error-taxonomy';

export type { AnthropicErrorType };

export function createAnthropicErrorBody(errorType: AnthropicErrorType, message: string): string {
  return JSON.stringify({ type: 'error', error: { type: errorType, message } });
}
