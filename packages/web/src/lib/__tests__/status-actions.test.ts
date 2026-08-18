// @ts-nocheck

import { getCurrentAction } from '../status-actions';
import type { SDKMessage } from '@hyperneo/shared/sdk/sdk.d.ts';

function createToolProgressMessage(toolName: string, elapsedTime: number): SDKMessage {
  return {
    type: 'tool_progress',
    tool_name: toolName,
    elapsed_time_seconds: elapsedTime,
  } as unknown as SDKMessage;
}

function createAssistantMessage(toolName: string): SDKMessage {
  return {
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', name: toolName, id: 'tool-1', input: {} }],
    },
  } as unknown as SDKMessage;
}

function createStreamEvent(
  eventType: string,
  contentBlock?: { type: string; name?: string }
): SDKMessage {
  return {
    type: 'stream_event',
    event: {
      type: eventType,
      content_block: contentBlock,
    },
  } as unknown as SDKMessage;
}

describe('getCurrentAction', () => {
  describe('when not processing', () => {
    it('should return undefined', () => {
      const result = getCurrentAction(null, false);
      expect(result).toBeUndefined();
    });

    it('should return undefined even with a message', () => {
      const message = createToolProgressMessage('Read', 1);
      const result = getCurrentAction(message, false);
      expect(result).toBeUndefined();
    });
  });

  describe('compaction priority', () => {
    it('should return "Compacting context..." when isCompacting is true', () => {
      const result = getCurrentAction(null, true, { isCompacting: true });
      expect(result).toBe('Compacting context...');
    });

    it('should prioritize compaction over tool actions', () => {
      const message = createToolProgressMessage('Read', 1);
      const result = getCurrentAction(message, true, { isCompacting: true });
      expect(result).toBe('Compacting context...');
    });
  });

  describe('tool progress messages', () => {
    it('should extract action from Read tool', () => {
      const message = createToolProgressMessage('Read', 0.5);
      const result = getCurrentAction(message, true);
      expect(result).toBe('Reading files...');
    });

    it('should extract action from Write tool', () => {
      const message = createToolProgressMessage('Write', 0.5);
      const result = getCurrentAction(message, true);
      expect(result).toBe('Writing files...');
    });

    it('should extract action from Edit tool', () => {
      const message = createToolProgressMessage('Edit', 0.5);
      const result = getCurrentAction(message, true);
      expect(result).toBe('Editing files...');
    });

    it('should extract action from Bash tool', () => {
      const message = createToolProgressMessage('Bash', 0.5);
      const result = getCurrentAction(message, true);
      expect(result).toBe('Running command...');
    });

    it('should extract action from Grep tool', () => {
      const message = createToolProgressMessage('Grep', 0.5);
      const result = getCurrentAction(message, true);
      expect(result).toBe('Searching code...');
    });

    it('should extract action from Glob tool', () => {
      const message = createToolProgressMessage('Glob', 0.5);
      const result = getCurrentAction(message, true);
      expect(result).toBe('Finding files...');
    });

    it('should extract action from Task tool', () => {
      const message = createToolProgressMessage('Task', 0.5);
      const result = getCurrentAction(message, true);
      expect(result).toBe('Starting agent...');
    });

    it('should extract action from WebFetch tool', () => {
      const message = createToolProgressMessage('WebFetch', 0.5);
      const result = getCurrentAction(message, true);
      expect(result).toBe('Fetching web content...');
    });

    it('should extract action from WebSearch tool', () => {
      const message = createToolProgressMessage('WebSearch', 0.5);
      const result = getCurrentAction(message, true);
      expect(result).toBe('Searching web...');
    });

    it('should show elapsed time for long-running tools', () => {
      const message = createToolProgressMessage('Bash', 5);
      const result = getCurrentAction(message, true);
      expect(result).toBe('Running command (5s)...');
    });

    it('should not show elapsed time for short-running tools', () => {
      const message = createToolProgressMessage('Bash', 1);
      const result = getCurrentAction(message, true);
      expect(result).toBe('Running command...');
    });

    it('should handle MCP tools with known actions', () => {
      const message = createToolProgressMessage('mcp__chrome_devtools__take_snapshot', 0.5);
      const result = getCurrentAction(message, true);
      expect(result).toBe('Taking snapshot...');
    });

    it('should handle tool names containing known tool as substring', () => {
      const message = createToolProgressMessage('mcp__custom__Read_and_parse', 0.5);
      const result = getCurrentAction(message, true);
      expect(result).toBe('Reading files...');
    });

    it('should generate readable action for unknown MCP tools', () => {
      const message = createToolProgressMessage('mcp__custom__do_something', 0.5);
      const result = getCurrentAction(message, true);
      expect(result).toBe('Do Something...');
    });
  });

  describe('assistant messages with tool use', () => {
    it('should extract action from assistant message tool_use block', () => {
      const message = createAssistantMessage('Read');
      const result = getCurrentAction(message, true);
      expect(result).toBe('Reading files...');
    });

    it('should handle unknown tools', () => {
      const message = createAssistantMessage('UnknownTool');
      const result = getCurrentAction(message, true);
      expect(result).toBeDefined();
    });
  });

  describe('stream events', () => {
    it('should return "Thinking..." for thinking content block', () => {
      const message = createStreamEvent('content_block_start', {
        type: 'thinking',
      });
      const result = getCurrentAction(message, true);
      expect(result).toBe('Thinking...');
    });

    it('should extract action from tool_use content block', () => {
      const message = createStreamEvent('content_block_start', {
        type: 'tool_use',
        name: 'Grep',
      });
      const result = getCurrentAction(message, true);
      expect(result).toBe('Searching code...');
    });

    it('should return "Writing..." for text delta', () => {
      const message = {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta' },
        },
      } as unknown as SDKMessage;
      const result = getCurrentAction(message, true);
      expect(result).toBe('Writing...');
    });
  });

  describe('phase-based actions', () => {
    it('should return "Starting..." for initializing phase', () => {
      const result = getCurrentAction(null, true, {
        streamingPhase: 'initializing',
      });
      expect(result).toBe('Starting...');
    });

    it('should return "Thinking..." for thinking phase', () => {
      const result = getCurrentAction(null, true, {
        streamingPhase: 'thinking',
      });
      expect(result).toBe('Thinking...');
    });

    it('should return "Streaming..." for streaming phase', () => {
      const result = getCurrentAction(null, true, {
        streamingPhase: 'streaming',
      });
      expect(result).toBe('Streaming...');
    });

    it('should return "Streaming (Xs)..." with duration', () => {
      const startedAt = Date.now() - 5000;
      const result = getCurrentAction(null, true, {
        streamingPhase: 'streaming',
        streamingStartedAt: startedAt,
      });
      expect(result).toMatch(/^Streaming \(\d+s\)\.\.\.$/);
    });

    it('should return "Finalizing..." for finalizing phase', () => {
      const result = getCurrentAction(null, true, {
        streamingPhase: 'finalizing',
      });
      expect(result).toBe('Finalizing...');
    });
  });

  describe('fallback actions', () => {
    it('should return a fallback action when no specific action found', () => {
      const result = getCurrentAction(null, true);
      expect(result).toBeDefined();
      expect(result).toMatch(/\.\.\.$/);
    });

    it('should rotate through fallback actions', () => {
      const actions = new Set<string>();
      for (let i = 0; i < 10; i++) {
        const result = getCurrentAction(null, true);
        if (result) actions.add(result);
      }
      expect(actions.size).toBeGreaterThan(1);
    });
  });

  describe('priority order', () => {
    it('should prioritize compaction over tool actions', () => {
      const message = createToolProgressMessage('Read', 1);
      const result = getCurrentAction(message, true, { isCompacting: true });
      expect(result).toBe('Compacting context...');
    });

    it('should prioritize tool actions over phase actions', () => {
      const message = createToolProgressMessage('Read', 1);
      const result = getCurrentAction(message, true, {
        streamingPhase: 'thinking',
      });
      expect(result).toBe('Reading files...');
    });

    it('should prioritize phase actions over fallback', () => {
      const result = getCurrentAction(null, true, {
        streamingPhase: 'thinking',
      });
      expect(result).toBe('Thinking...');
    });
  });
});

describe('TOOL_ACTION_MAP coverage', () => {
  const knownTools = [
    ['Read', 'Reading files...'],
    ['Write', 'Writing files...'],
    ['Edit', 'Editing files...'],
    ['Bash', 'Running command...'],
    ['Grep', 'Searching code...'],
    ['Glob', 'Finding files...'],
    ['Task', 'Starting agent...'],
    ['Agent', 'Starting agent...'],
    ['WebFetch', 'Fetching web content...'],
    ['WebSearch', 'Searching web...'],
    ['SlashCommand', 'Running command...'],
    ['NotebookEdit', 'Editing notebook...'],
  ] as const;

  knownTools.forEach(([tool, expected]) => {
    it(`should map ${tool} to "${expected}"`, () => {
      const message = createToolProgressMessage(tool, 0.5);
      const result = getCurrentAction(message, true);
      expect(result).toBe(expected);
    });
  });
});

describe('Edge cases for branch coverage', () => {
  describe('getActionFromToolName - no match returns null', () => {
    it('should fall through to fallback for completely unknown tool in tool_progress', () => {
      const message = createToolProgressMessage('CompletelyUnknownTool', 0.5);
      const result = getCurrentAction(message, true);
      expect(result).toBeDefined();
      expect(result).toMatch(/\.\.\.$/);
    });

    it('should fall through for tool_progress with non-MCP unknown tool', () => {
      const message = createToolProgressMessage('ZzzUnknown', 0.5);
      const result = getCurrentAction(message, true);
      expect(result).toBeDefined();
    });
  });

  describe('assistant message with unknown tool name', () => {
    it('should fall through when assistant tool_use has completely unknown tool', () => {
      const message = {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'TotallyUnknownTool', id: 'tool-1', input: {} }],
        },
      } as unknown as SDKMessage;
      const result = getCurrentAction(message, true);
      expect(result).toBeDefined();
      expect(result).toMatch(/\.\.\.$/);
    });

    it('should handle assistant message with no content array', () => {
      const message = {
        type: 'assistant',
        message: {
          content: 'text string content',
        },
      } as unknown as SDKMessage;
      const result = getCurrentAction(message, true);
      expect(result).toBeDefined();
    });

    it('should handle assistant message with non-tool_use blocks', () => {
      const message = {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'hello' }],
        },
      } as unknown as SDKMessage;
      const result = getCurrentAction(message, true);
      expect(result).toBeDefined();
    });

    it('should handle assistant tool_use block without name', () => {
      const message = {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'tool-1', input: {} }],
        },
      } as unknown as SDKMessage;
      const result = getCurrentAction(message, true);
      expect(result).toBeDefined();
    });
  });

  describe('stream_event with tool_use unknown tool', () => {
    it('should fall through for content_block_start tool_use with unknown tool', () => {
      const message = createStreamEvent('content_block_start', {
        type: 'tool_use',
        name: 'CompletelyUnknownStreamTool',
      });
      const result = getCurrentAction(message, true);
      expect(result).toBeDefined();
    });

    it('should handle content_block_start with unknown content type', () => {
      const message = createStreamEvent('content_block_start', {
        type: 'some_other_type',
      });
      const result = getCurrentAction(message, true);
      expect(result).toBeDefined();
    });

    it('should handle content_block_delta with non-text delta', () => {
      const message = {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'thinking_delta' },
        },
      } as unknown as SDKMessage;
      const result = getCurrentAction(message, true);
      expect(result).toBeDefined();
    });

    it('should handle stream_event with unrecognized event type', () => {
      const message = {
        type: 'stream_event',
        event: {
          type: 'message_stop',
        },
      } as unknown as SDKMessage;
      const result = getCurrentAction(message, true);
      expect(result).toBeDefined();
    });
  });

  describe('streaming phase with zero duration', () => {
    it('should return "Streaming..." when duration is exactly 0', () => {
      const startedAt = Date.now();
      const result = getCurrentAction(null, true, {
        streamingPhase: 'streaming',
        streamingStartedAt: startedAt,
      });
      expect(result).toBe('Streaming...');
    });
  });

  describe('unrecognized message types', () => {
    it('should fall through to fallback for unknown message type', () => {
      const message = {
        type: 'result',
        data: {},
      } as unknown as SDKMessage;
      const result = getCurrentAction(message, true);
      expect(result).toBeDefined();
    });
  });

  describe('MCP tool with only 2 parts', () => {
    it('should return null for mcp__ tool with less than 3 parts', () => {
      const message = createToolProgressMessage('mcp__onlytwosegments', 0.5);
      const result = getCurrentAction(message, true);
      expect(result).toBeDefined();
    });
  });
});

describe('MCP tool name parsing', () => {
  it('should parse mcp__service__action format', () => {
    const message = createToolProgressMessage('mcp__test_service__custom_action', 0.5);
    const result = getCurrentAction(message, true);
    expect(result).toBe('Custom Action...');
  });

  it('should handle multi-word action names', () => {
    const message = createToolProgressMessage('mcp__svc__do_something_complex', 0.5);
    const result = getCurrentAction(message, true);
    expect(result).toBe('Do Something Complex...');
  });

  it('should handle single word action names', () => {
    const message = createToolProgressMessage('mcp__svc__execute', 0.5);
    const result = getCurrentAction(message, true);
    expect(result).toBe('Execute...');
  });
});
