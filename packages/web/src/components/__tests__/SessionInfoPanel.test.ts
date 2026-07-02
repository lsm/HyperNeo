import { describe, expect, it } from 'vitest';
import { extractBackgroundTasks } from '../../hooks/useRunningToolUseIds.ts';
import type { ChatMessage } from '@hyperneo/shared';

describe('SessionInfoPanel', () => {
  it('extracts paused background task updates from transcript messages', () => {
    const messages = [
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'Bash',
              input: { description: 'Run test suite', command: 'bun test' },
            },
          ],
        },
      },
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-1',
        tool_use_id: 'tool-1',
        description: 'Run tests',
      },
      {
        type: 'system',
        subtype: 'task_updated',
        task_id: 'task-1',
        patch: {
          status: 'paused',
          is_backgrounded: true,
        },
      },
    ] as unknown as ChatMessage[];

    expect(
      extractBackgroundTasks(messages, new Map([['tool-1', { command: 'bun test' }]]))
    ).toEqual([
      {
        id: 'task-1',
        toolUseId: 'tool-1',
        label: 'bun test',
        status: 'paused',
        backgrounded: true,
      },
    ]);
  });
});
