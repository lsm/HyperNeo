import { describe, test, expect } from 'bun:test';
import {
  flattenSDKSlashCommands,
  isSDKAssistantMessage,
  isSDKUserMessage,
  isSDKUserMessageReplay,
  isSDKResultMessage,
  isSDKResultSuccess,
  isSDKResultError,
  getSdkResultOriginKind,
  isSDKSystemMessage,
  isSDKSystemInit,
  isSDKCompactBoundary,
  isSDKStatusMessage,
  isSDKHookResponse,
  isSDKStreamEvent,
  isSDKToolProgressMessage,
  isSDKAuthStatusMessage,
  isTextBlock,
  isToolUseBlock,
  isThinkingBlock,
  hasRenderableThinking,
  getMessageTypeDescription,
  isUserVisibleMessage,
  isHiddenSystemSubtype,
  isConditionallyHiddenSystemMessage,
  type ContentBlock,
} from '../src/sdk/type-guards';
import type { SDKMessage } from '../src/sdk/sdk';

const baseProps = {
  uuid: 'test-uuid',
  session_id: 'test-session',
};

describe('flattenSDKSlashCommands', () => {
  test('should normalize command names and aliases', () => {
    expect(
      flattenSDKSlashCommands([
        { name: '/status', aliases: ['/cost', 'stats'] },
        { name: 'status', aliases: ['/cost'] },
      ])
    ).toEqual(['status', 'cost', 'stats']);
  });
});

describe('isSDKAssistantMessage', () => {
  test('should return true for assistant message', () => {
    const msg = {
      ...baseProps,
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello' }],
        model: 'claude-sonnet-4-5-20250929',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    };
    expect(isSDKAssistantMessage(msg as unknown as SDKMessage)).toBe(true);
  });

  test('should return false for non-assistant message', () => {
    const msg = {
      ...baseProps,
      type: 'user',
      parent_tool_use_id: null,
      message: { role: 'user', content: 'Hello' },
    };
    expect(isSDKAssistantMessage(msg as unknown as SDKMessage)).toBe(false);
  });
});

describe('isSDKUserMessage', () => {
  test('should return true for user message', () => {
    const msg = {
      ...baseProps,
      type: 'user',
      parent_tool_use_id: null,
      message: { role: 'user', content: 'Hello' },
    };
    expect(isSDKUserMessage(msg as unknown as SDKMessage)).toBe(true);
  });

  test('should return false for user replay message', () => {
    const msg = {
      ...baseProps,
      type: 'user',
      parent_tool_use_id: null,
      isReplay: true,
      message: { role: 'user', content: 'Hello' },
    };
    expect(isSDKUserMessage(msg as unknown as SDKMessage)).toBe(false);
  });

  test('should return false for assistant message', () => {
    const msg = {
      ...baseProps,
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello' }],
        model: 'claude-sonnet-4-5-20250929',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    };
    expect(isSDKUserMessage(msg as unknown as SDKMessage)).toBe(false);
  });
});

describe('isSDKUserMessageReplay', () => {
  test('should return true for user replay message', () => {
    const msg = {
      ...baseProps,
      type: 'user',
      parent_tool_use_id: null,
      isReplay: true,
      message: { role: 'user', content: 'Hello' },
    };
    expect(isSDKUserMessageReplay(msg as unknown as SDKMessage)).toBe(true);
  });

  test('should return false for regular user message', () => {
    const msg = {
      ...baseProps,
      type: 'user',
      parent_tool_use_id: null,
      message: { role: 'user', content: 'Hello' },
    };
    expect(isSDKUserMessageReplay(msg as unknown as SDKMessage)).toBe(false);
  });
});

describe('isSDKResultMessage', () => {
  test('should return true for result message', () => {
    const msg = {
      ...baseProps,
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 1,
    };
    expect(isSDKResultMessage(msg as unknown as SDKMessage)).toBe(true);
  });

  test('should return false for non-result message', () => {
    const msg = {
      ...baseProps,
      type: 'user',
      parent_tool_use_id: null,
      message: { role: 'user', content: 'Hello' },
    };
    expect(isSDKResultMessage(msg as unknown as SDKMessage)).toBe(false);
  });
});

describe('isSDKResultSuccess', () => {
  test('should return true for success result', () => {
    const msg = {
      ...baseProps,
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 1,
    };
    expect(isSDKResultSuccess(msg as unknown as SDKMessage)).toBe(true);
  });

  test('should return false for error result', () => {
    const msg = {
      ...baseProps,
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      num_turns: 1,
      error: 'Something went wrong',
    };
    expect(isSDKResultSuccess(msg as unknown as SDKMessage)).toBe(false);
  });
});

describe('isSDKResultError', () => {
  test('should return true for error result', () => {
    const msg = {
      ...baseProps,
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      num_turns: 1,
      error: 'Something went wrong',
    };
    expect(isSDKResultError(msg as unknown as SDKMessage)).toBe(true);
  });

  test('should return true for max_turns error', () => {
    const msg = {
      ...baseProps,
      type: 'result',
      subtype: 'error_max_turns',
      is_error: true,
      num_turns: 10,
    };
    expect(isSDKResultError(msg as unknown as SDKMessage)).toBe(true);
  });

  test('should return false for success result', () => {
    const msg = {
      ...baseProps,
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 1,
    };
    expect(isSDKResultError(msg as unknown as SDKMessage)).toBe(false);
  });
});

describe('getSdkResultOriginKind', () => {
  test('should return the origin kind for result message with origin', () => {
    const msg = {
      ...baseProps,
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 2,
      origin: { kind: 'task-notification' },
    };
    expect(getSdkResultOriginKind(msg as unknown as SDKMessage)).toBe('task-notification');
  });

  test('should return null for result message without origin', () => {
    const msg = {
      ...baseProps,
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 1,
    };
    expect(getSdkResultOriginKind(msg as unknown as SDKMessage)).toBeNull();
  });

  test('should return null for non-result message', () => {
    const msg = {
      ...baseProps,
      type: 'user',
      parent_tool_use_id: null,
      message: { role: 'user', content: 'Hello' },
    };
    expect(getSdkResultOriginKind(msg as unknown as SDKMessage)).toBeNull();
  });
});

describe('isSDKSystemMessage', () => {
  test('should return true for system message', () => {
    const msg = {
      ...baseProps,
      type: 'system',
      subtype: 'init',
      cwd: '/test',
    };
    expect(isSDKSystemMessage(msg as unknown as SDKMessage)).toBe(true);
  });

  test('should return false for non-system message', () => {
    const msg = {
      ...baseProps,
      type: 'user',
      parent_tool_use_id: null,
      message: { role: 'user', content: 'Hello' },
    };
    expect(isSDKSystemMessage(msg as unknown as SDKMessage)).toBe(false);
  });
});

describe('isSDKSystemInit', () => {
  test('should return true for init system message', () => {
    const msg = {
      ...baseProps,
      type: 'system',
      subtype: 'init',
      cwd: '/test',
    };
    expect(isSDKSystemInit(msg as unknown as SDKMessage)).toBe(true);
  });

  test('should return false for other system message', () => {
    const msg = {
      ...baseProps,
      type: 'system',
      subtype: 'status',
      status: null,
    };
    expect(isSDKSystemInit(msg as unknown as SDKMessage)).toBe(false);
  });
});

describe('isSDKCompactBoundary', () => {
  test('should return true for compact_boundary message', () => {
    const msg = {
      ...baseProps,
      type: 'system',
      subtype: 'compact_boundary',
    };
    expect(isSDKCompactBoundary(msg as unknown as SDKMessage)).toBe(true);
  });

  test('should return false for other system message', () => {
    const msg = {
      ...baseProps,
      type: 'system',
      subtype: 'init',
      cwd: '/test',
    };
    expect(isSDKCompactBoundary(msg as unknown as SDKMessage)).toBe(false);
  });
});

describe('isSDKStatusMessage', () => {
  test('should return true for status message', () => {
    const msg = {
      ...baseProps,
      type: 'system',
      subtype: 'status',
      status: 'compacting',
    };
    expect(isSDKStatusMessage(msg as unknown as SDKMessage)).toBe(true);
  });

  test('should return false for other system message', () => {
    const msg = {
      ...baseProps,
      type: 'system',
      subtype: 'init',
      cwd: '/test',
    };
    expect(isSDKStatusMessage(msg as unknown as SDKMessage)).toBe(false);
  });
});

describe('isSDKHookResponse', () => {
  test('should return true for hook_response message', () => {
    const msg = {
      ...baseProps,
      type: 'system',
      subtype: 'hook_response',
      hook_name: 'test-hook',
      blocked: false,
    };
    expect(isSDKHookResponse(msg as unknown as SDKMessage)).toBe(true);
  });

  test('should return false for other system message', () => {
    const msg = {
      ...baseProps,
      type: 'system',
      subtype: 'status',
      status: null,
    };
    expect(isSDKHookResponse(msg as unknown as SDKMessage)).toBe(false);
  });
});

describe('isSDKStreamEvent', () => {
  test('should return true for stream_event message', () => {
    const msg = {
      ...baseProps,
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0 },
    };
    expect(isSDKStreamEvent(msg as unknown as SDKMessage)).toBe(true);
  });

  test('should return false for non-stream message', () => {
    const msg = {
      ...baseProps,
      type: 'user',
      parent_tool_use_id: null,
      message: { role: 'user', content: 'Hello' },
    };
    expect(isSDKStreamEvent(msg as unknown as SDKMessage)).toBe(false);
  });
});

describe('isSDKToolProgressMessage', () => {
  test('should return true for tool_progress message', () => {
    const msg = {
      ...baseProps,
      type: 'tool_progress',
      tool_name: 'Read',
      data: {},
    };
    expect(isSDKToolProgressMessage(msg as unknown as SDKMessage)).toBe(true);
  });

  test('should return false for non-tool_progress message', () => {
    const msg = {
      ...baseProps,
      type: 'user',
      parent_tool_use_id: null,
      message: { role: 'user', content: 'Hello' },
    };
    expect(isSDKToolProgressMessage(msg as unknown as SDKMessage)).toBe(false);
  });
});

describe('isSDKAuthStatusMessage', () => {
  test('should return true for auth_status message', () => {
    const msg = {
      ...baseProps,
      type: 'auth_status',
      has_api_key: true,
      has_oauth: false,
    };
    expect(isSDKAuthStatusMessage(msg as unknown as SDKMessage)).toBe(true);
  });

  test('should return false for non-auth_status message', () => {
    const msg = {
      ...baseProps,
      type: 'user',
      parent_tool_use_id: null,
      message: { role: 'user', content: 'Hello' },
    };
    expect(isSDKAuthStatusMessage(msg as unknown as SDKMessage)).toBe(false);
  });
});

describe('Content Block Type Guards', () => {
  describe('isTextBlock', () => {
    test('should return true for text block', () => {
      const block: ContentBlock = { type: 'text', text: 'Hello' };
      expect(isTextBlock(block)).toBe(true);
    });

    test('should return false for tool_use block', () => {
      const block: ContentBlock = {
        type: 'tool_use',
        id: '1',
        name: 'Read',
        input: {},
      };
      expect(isTextBlock(block)).toBe(false);
    });
  });

  describe('isToolUseBlock', () => {
    test('should return true for tool_use block', () => {
      const block: ContentBlock = {
        type: 'tool_use',
        id: '1',
        name: 'Read',
        input: {},
      };
      expect(isToolUseBlock(block)).toBe(true);
    });

    test('should return true for legacy tool_use block without input', () => {
      const block = {
        type: 'tool_use',
        id: '1',
        name: 'Read',
      } as ContentBlock;
      expect(isToolUseBlock(block)).toBe(true);
    });

    test('should return false for text block', () => {
      const block: ContentBlock = { type: 'text', text: 'Hello' };
      expect(isToolUseBlock(block)).toBe(false);
    });
  });

  describe('isThinkingBlock', () => {
    test('should return true for thinking block', () => {
      const block: ContentBlock = {
        type: 'thinking',
        thinking: 'Let me think...',
      };
      expect(isThinkingBlock(block)).toBe(true);
    });

    test('should return false for text block', () => {
      const block: ContentBlock = { type: 'text', text: 'Hello' };
      expect(isThinkingBlock(block)).toBe(false);
    });

    test('should return true even when thinking payload is empty (Opus 4.7 case)', () => {
      const block: ContentBlock = {
        type: 'thinking',
        thinking: '',
        signature: 'sig_abc',
      };
      expect(isThinkingBlock(block)).toBe(true);
    });

    test('should return false for redacted_thinking block', () => {
      const block: ContentBlock = {
        type: 'redacted_thinking',
        data: 'opaque',
      };
      expect(isThinkingBlock(block)).toBe(false);
    });
  });

  describe('hasRenderableThinking', () => {
    test('should return true for non-empty thinking', () => {
      const block = { type: 'thinking' as const, thinking: 'Real reasoning.' };
      expect(hasRenderableThinking(block)).toBe(true);
    });

    test('should return false for empty thinking (Opus 4.7 omitted stub)', () => {
      const block = { type: 'thinking' as const, thinking: '', signature: 'sig_x' };
      expect(hasRenderableThinking(block)).toBe(false);
    });

    test('should return false for whitespace-only thinking', () => {
      const block = { type: 'thinking' as const, thinking: '   \n\t  ' };
      expect(hasRenderableThinking(block)).toBe(false);
    });

    test('should return false when thinking field is missing/non-string', () => {
      const block = { type: 'thinking' as const, thinking: undefined as unknown as string };
      expect(hasRenderableThinking(block)).toBe(false);
    });
  });
});

describe('getMessageTypeDescription', () => {
  test('should describe assistant message', () => {
    const msg = {
      ...baseProps,
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello' }],
        model: 'claude-sonnet-4-5-20250929',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    };
    expect(getMessageTypeDescription(msg as unknown as SDKMessage)).toBe('Assistant Response');
  });

  test('should describe user message', () => {
    const msg = {
      ...baseProps,
      type: 'user',
      parent_tool_use_id: null,
      message: { role: 'user', content: 'Hello' },
    };
    expect(getMessageTypeDescription(msg as unknown as SDKMessage)).toBe('User Message');
  });

  test('should describe user replay message', () => {
    const msg = {
      ...baseProps,
      type: 'user',
      parent_tool_use_id: null,
      isReplay: true,
      message: { role: 'user', content: 'Hello' },
    };
    expect(getMessageTypeDescription(msg as unknown as SDKMessage)).toBe('User Message (Replay)');
  });

  test('should describe success result', () => {
    const msg = {
      ...baseProps,
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 1,
    };
    expect(getMessageTypeDescription(msg as unknown as SDKMessage)).toBe('Query Success');
  });

  test('should describe error result', () => {
    const msg = {
      ...baseProps,
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      num_turns: 1,
      error: 'Error',
    };
    expect(getMessageTypeDescription(msg as unknown as SDKMessage)).toBe(
      'Query Error: during_execution'
    );
  });

  test('should describe init message', () => {
    const msg = {
      ...baseProps,
      type: 'system',
      subtype: 'init',
      cwd: '/test',
    };
    expect(getMessageTypeDescription(msg as unknown as SDKMessage)).toBe('Session Initialized');
  });

  test('should describe compact_boundary message', () => {
    const msg = {
      ...baseProps,
      type: 'system',
      subtype: 'compact_boundary',
    };
    expect(getMessageTypeDescription(msg as unknown as SDKMessage)).toBe('Compaction Boundary');
  });

  test('should describe status message', () => {
    const msg = {
      ...baseProps,
      type: 'system',
      subtype: 'status',
      status: 'compacting',
    };
    expect(getMessageTypeDescription(msg as unknown as SDKMessage)).toBe('Status: compacting');
  });

  test('should describe hook_response message', () => {
    const msg = {
      ...baseProps,
      type: 'system',
      subtype: 'hook_response',
      hook_name: 'test-hook',
      blocked: false,
    };
    expect(getMessageTypeDescription(msg as unknown as SDKMessage)).toBe(
      'Hook Response: test-hook'
    );
  });

  test('should describe stream_event message', () => {
    const msg = {
      ...baseProps,
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0 },
    };
    expect(getMessageTypeDescription(msg as unknown as SDKMessage)).toBe('Streaming Event');
  });

  test('should describe tool_progress message', () => {
    const msg = {
      ...baseProps,
      type: 'tool_progress',
      tool_name: 'Read',
      data: {},
    };
    expect(getMessageTypeDescription(msg as unknown as SDKMessage)).toBe('Tool Progress: Read');
  });

  test('should describe auth_status message', () => {
    const msg = {
      ...baseProps,
      type: 'auth_status',
      has_api_key: true,
      has_oauth: false,
    };
    expect(getMessageTypeDescription(msg as unknown as SDKMessage)).toBe('Authentication Status');
  });

  test('should return Unknown Message for unrecognized type', () => {
    const msg = {
      ...baseProps,
      type: 'unknown_type',
    } as unknown as SDKMessage;
    expect(getMessageTypeDescription(msg as unknown as SDKMessage)).toBe('Unknown Message');
  });
});

describe('isUserVisibleMessage', () => {
  test('should return false for stream_event', () => {
    const msg = {
      ...baseProps,
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0 },
    };
    expect(isUserVisibleMessage(msg as unknown as SDKMessage)).toBe(false);
  });

  test('should return true for compact_boundary', () => {
    const msg = {
      ...baseProps,
      type: 'system',
      subtype: 'compact_boundary',
    };
    expect(isUserVisibleMessage(msg as unknown as SDKMessage)).toBe(true);
  });

  test('should return true for compacting status', () => {
    const msg = {
      ...baseProps,
      type: 'system',
      subtype: 'status',
      status: 'compacting',
    };
    expect(isUserVisibleMessage(msg as unknown as SDKMessage)).toBe(true);
  });

  test('should return true for assistant message', () => {
    const msg = {
      ...baseProps,
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello' }],
        model: 'claude-sonnet-4-5-20250929',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    };
    expect(isUserVisibleMessage(msg as unknown as SDKMessage)).toBe(true);
  });

  test('should return true for user message', () => {
    const msg = {
      ...baseProps,
      type: 'user',
      parent_tool_use_id: null,
      message: { role: 'user', content: 'Hello' },
    };
    expect(isUserVisibleMessage(msg as unknown as SDKMessage)).toBe(true);
  });

  test('should return true for user replay message', () => {
    const msg = {
      ...baseProps,
      type: 'user',
      parent_tool_use_id: null,
      isReplay: true,
      message: { role: 'user', content: 'Hello' },
    };
    expect(isUserVisibleMessage(msg as unknown as SDKMessage)).toBe(true);
  });

  test('should return true for result message', () => {
    const msg = {
      ...baseProps,
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 1,
    };
    expect(isUserVisibleMessage(msg as unknown as SDKMessage)).toBe(true);
  });

  test('should return true for tool_progress message', () => {
    const msg = {
      ...baseProps,
      type: 'tool_progress',
      tool_name: 'Read',
      data: {},
    };
    expect(isUserVisibleMessage(msg as unknown as SDKMessage)).toBe(true);
  });

  test('should return true for auth_status message', () => {
    const msg = {
      ...baseProps,
      type: 'auth_status',
      has_api_key: true,
      has_oauth: false,
    };
    expect(isUserVisibleMessage(msg as unknown as SDKMessage)).toBe(true);
  });

  test('should return true for non-compacting status message', () => {
    const msg = {
      ...baseProps,
      type: 'system',
      subtype: 'status',
      status: 'thinking',
    };
    expect(isUserVisibleMessage(msg as unknown as SDKMessage)).toBe(true);
  });
});

describe('isHiddenSystemSubtype', () => {
  test('should return true for session_state_changed', () => {
    expect(isHiddenSystemSubtype('session_state_changed')).toBe(true);
  });

  test('should return true for commands_changed', () => {
    expect(isHiddenSystemSubtype('commands_changed')).toBe(true);
  });

  test('should return false for hook_started (rendered in chat + task roster)', () => {
    expect(isHiddenSystemSubtype('hook_started')).toBe(false);
  });

  test('should return false for hook_progress (rendered in chat + task roster)', () => {
    expect(isHiddenSystemSubtype('hook_progress')).toBe(false);
  });

  test('should return true for task_started', () => {
    expect(isHiddenSystemSubtype('task_started')).toBe(true);
  });

  test('should return true for task_progress', () => {
    expect(isHiddenSystemSubtype('task_progress')).toBe(true);
  });

  test('should return true for task_updated', () => {
    expect(isHiddenSystemSubtype('task_updated')).toBe(true);
  });

  test('should return true for mirror_error', () => {
    expect(isHiddenSystemSubtype('mirror_error')).toBe(true);
  });

  test('should return true for elicitation_complete', () => {
    expect(isHiddenSystemSubtype('elicitation_complete')).toBe(true);
  });

  test('should return false for visible subtypes', () => {
    expect(isHiddenSystemSubtype('init')).toBe(false);
    expect(isHiddenSystemSubtype('compact_boundary')).toBe(false);
    expect(isHiddenSystemSubtype('status')).toBe(false);
    expect(isHiddenSystemSubtype('hook_response')).toBe(false);
    expect(isHiddenSystemSubtype('informational')).toBe(false);
    expect(isHiddenSystemSubtype('worker_shutting_down')).toBe(false);
    expect(isHiddenSystemSubtype('model_refusal_fallback')).toBe(false);
    expect(isHiddenSystemSubtype('permission_denied')).toBe(false);
    expect(isHiddenSystemSubtype('task_notification')).toBe(false);
    expect(isHiddenSystemSubtype('memory_recall')).toBe(false);
    expect(isHiddenSystemSubtype('local_command_output')).toBe(false);
    expect(isHiddenSystemSubtype('notification')).toBe(false);
    expect(isHiddenSystemSubtype('files_persisted')).toBe(false);
    expect(isHiddenSystemSubtype('plugin_install')).toBe(false);
  });
});

describe('isConditionallyHiddenSystemMessage', () => {
  test('hides files_persisted when no failures', () => {
    expect(
      isConditionallyHiddenSystemMessage({
        type: 'system',
        subtype: 'files_persisted',
        failed: [],
      } as unknown as SDKMessage)
    ).toBe(true);
    expect(
      isConditionallyHiddenSystemMessage({
        type: 'system',
        subtype: 'files_persisted',
        failed: [{ path: 'a.txt' }],
      } as unknown as SDKMessage)
    ).toBe(false);
  });

  test('hides plugin_install started/installed statuses', () => {
    expect(
      isConditionallyHiddenSystemMessage({
        type: 'system',
        subtype: 'plugin_install',
        status: 'started',
      } as unknown as SDKMessage)
    ).toBe(true);
    expect(
      isConditionallyHiddenSystemMessage({
        type: 'system',
        subtype: 'plugin_install',
        status: 'installed',
      } as unknown as SDKMessage)
    ).toBe(true);
    expect(
      isConditionallyHiddenSystemMessage({
        type: 'system',
        subtype: 'plugin_install',
        status: 'failed',
      } as unknown as SDKMessage)
    ).toBe(false);
    expect(
      isConditionallyHiddenSystemMessage({
        type: 'system',
        subtype: 'plugin_install',
        status: 'completed',
      } as unknown as SDKMessage)
    ).toBe(false);
  });

  test('ignores non-system and unrelated subtypes', () => {
    expect(
      isConditionallyHiddenSystemMessage({
        type: 'assistant',
        subtype: 'files_persisted',
        failed: [],
      } as unknown as SDKMessage)
    ).toBe(false);
    expect(
      isConditionallyHiddenSystemMessage({
        type: 'system',
        subtype: 'permission_denied',
      } as unknown as SDKMessage)
    ).toBe(false);
  });
});
