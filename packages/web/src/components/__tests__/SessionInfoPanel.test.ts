import { describe, expect, it } from 'vitest';
import { extractBackgroundTasks } from '../SessionInfoPanel';
import type { ChatMessage } from '@neokai/shared';

describe('SessionInfoPanel', () => {
  it('extracts paused background task updates', () => {
    const messages = [
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-1',
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

    expect(extractBackgroundTasks(messages, new Map())).toEqual([
      {
        id: 'task-1',
        label: 'Run tests',
        status: 'paused',
        backgrounded: true,
      },
    ]);
  });
});
