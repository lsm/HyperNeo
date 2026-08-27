import { describe, expect, it } from 'bun:test';

import type { SDKMessage } from '@hyperneo/shared/sdk';
import { isMeaningfulSdkStartupProgress } from '../../../../src/lib/agent/sdk-startup-progress';

function msg(fields: Record<string, unknown>): SDKMessage {
  return fields as unknown as SDKMessage;
}

describe('isMeaningfulSdkStartupProgress', () => {
  it('treats model-pipeline messages as meaningful startup progress', () => {
    expect(isMeaningfulSdkStartupProgress(msg({ type: 'assistant' }))).toBe(true);
    expect(isMeaningfulSdkStartupProgress(msg({ type: 'user' }))).toBe(true);
    expect(isMeaningfulSdkStartupProgress(msg({ type: 'user', isReplay: true }))).toBe(true);
    expect(isMeaningfulSdkStartupProgress(msg({ type: 'result', subtype: 'success' }))).toBe(true);
    expect(
      isMeaningfulSdkStartupProgress(msg({ type: 'result', subtype: 'error_during_execution' }))
    ).toBe(true);
    expect(isMeaningfulSdkStartupProgress(msg({ type: 'stream_event' }))).toBe(true);
  });

  it('treats system init (prompt acceptance) as meaningful startup progress', () => {
    expect(isMeaningfulSdkStartupProgress(msg({ type: 'system', subtype: 'init' }))).toBe(true);
  });

  it('treats connection-status and retry system events as non-progress', () => {
    expect(
      isMeaningfulSdkStartupProgress(
        msg({ type: 'system', subtype: 'status', status: 'connected' })
      )
    ).toBe(false);
    expect(
      isMeaningfulSdkStartupProgress(
        msg({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10 })
      )
    ).toBe(false);
  });

  it('treats ambient system subtypes as non-progress', () => {
    for (const subtype of [
      'thinking_tokens',
      'commands_changed',
      'session_state_changed',
      'tool_progress',
      'hook_response',
      'local_command_output',
    ]) {
      expect(isMeaningfulSdkStartupProgress(msg({ type: 'system', subtype }))).toBe(false);
    }
  });

  it('treats ambient non-system events as non-progress', () => {
    expect(isMeaningfulSdkStartupProgress(msg({ type: 'auth_status' }))).toBe(false);
    expect(isMeaningfulSdkStartupProgress(msg({ type: 'conversation_reset' }))).toBe(false);
    expect(isMeaningfulSdkStartupProgress(msg({ type: 'prompt_suggestion' }))).toBe(false);
  });
});
