// @ts-nocheck

import { renderHook } from '@testing-library/preact';
import { useMessageMaps } from '../useMessageMaps.ts';
import type { SDKMessage } from '@hyperneo/shared/sdk/sdk.d.ts';

const uuid1 = '00000000-0000-0000-0000-000000000001';
const uuid2 = '00000000-0000-0000-0000-000000000002';
const uuid3 = '00000000-0000-0000-0000-000000000003';
const uuid4 = '00000000-0000-0000-0000-000000000004';
const uuid5 = '00000000-0000-0000-0000-000000000005';

describe('useMessageMaps', () => {
  describe('toolResultsMap', () => {
    it('should create empty map when no tool results exist', () => {
      const messages = [
        {
          type: 'user',
          uuid: uuid1,
          session_id: 'session-1',
          message: {
            role: 'user',
            content: 'Hello',
          },
        },
        {
          type: 'assistant',
          uuid: uuid2,
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Hi there!' }],
          },
        },
      ] as unknown as SDKMessage[];

      const { result } = renderHook(() => useMessageMaps(messages, 'session-1'));
      expect(result.current.toolResultsMap.size).toBe(0);
    });

    it('should map tool_use_id to tool result data', () => {
      const messages = [
        {
          type: 'assistant',
          uuid: uuid1,
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tool-use-123',
                name: 'Read',
                input: { file_path: '/test.txt' },
              },
            ],
          },
        },
        {
          type: 'user',
          uuid: uuid2,
          session_id: 'session-1',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tool-use-123',
                content: 'File contents here',
              },
            ],
          },
        },
      ] as unknown as SDKMessage[];

      const { result } = renderHook(() => useMessageMaps(messages, 'session-1'));

      expect(result.current.toolResultsMap.size).toBe(1);
      const toolResult = result.current.toolResultsMap.get('tool-use-123');
      expect(toolResult).toBeDefined();
      expect(toolResult?.messageUuid).toBe(uuid2);
      expect(toolResult?.sessionId).toBe('session-1');
      expect(toolResult?.isOutputRemoved).toBe(false);
    });

    it('should mark tool result as removed when in removedOutputs', () => {
      const messages = [
        {
          type: 'user',
          uuid: uuid1,
          session_id: 'session-1',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tool-use-123',
                content: 'Result content',
              },
            ],
          },
        },
      ] as unknown as SDKMessage[];

      const { result } = renderHook(() => useMessageMaps(messages, 'session-1', [uuid1]));

      const toolResult = result.current.toolResultsMap.get('tool-use-123');
      expect(toolResult?.isOutputRemoved).toBe(true);
      expect(toolResult?.content).toBeDefined();
    });

    it('should mark retracted tool results as removed', () => {
      const messages = [
        {
          type: 'user',
          uuid: uuid1,
          session_id: 'session-1',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tool-use-123',
                content: 'Retracted result content',
              },
            ],
          },
        },
        {
          type: 'system',
          subtype: 'model_refusal_fallback',
          uuid: uuid2,
          session_id: 'session-1',
          retracted_message_uuids: [uuid1],
        },
      ] as unknown as SDKMessage[];

      const { result } = renderHook(() => useMessageMaps(messages, 'session-1'));

      const toolResult = result.current.toolResultsMap.get('tool-use-123');
      expect(toolResult?.messageUuid).toBe(uuid1);
      expect(toolResult?.isOutputRemoved).toBe(true);
      expect(toolResult?.content).toBeUndefined();
    });

    it('should handle multiple tool results in the same message', () => {
      const messages = [
        {
          type: 'user',
          uuid: uuid1,
          session_id: 'session-1',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tool-1',
                content: 'Result 1',
              },
              {
                type: 'tool_result',
                tool_use_id: 'tool-2',
                content: 'Result 2',
              },
              {
                type: 'tool_result',
                tool_use_id: 'tool-3',
                content: 'Result 3',
              },
            ],
          },
        },
      ] as unknown as SDKMessage[];

      const { result } = renderHook(() => useMessageMaps(messages, 'session-1'));

      expect(result.current.toolResultsMap.size).toBe(3);
      expect(result.current.toolResultsMap.has('tool-1')).toBe(true);
      expect(result.current.toolResultsMap.has('tool-2')).toBe(true);
      expect(result.current.toolResultsMap.has('tool-3')).toBe(true);
    });

    it('should include full content block in result', () => {
      const toolResultBlock = {
        type: 'tool_result',
        tool_use_id: 'tool-use-123',
        content: 'Full result content',
        is_error: false,
      };

      const messages = [
        {
          type: 'user',
          uuid: uuid1,
          session_id: 'session-1',
          message: {
            role: 'user',
            content: [toolResultBlock],
          },
        },
      ] as unknown as SDKMessage[];

      const { result } = renderHook(() => useMessageMaps(messages, 'session-1'));

      const toolResult = result.current.toolResultsMap.get('tool-use-123');
      expect(toolResult?.content).toEqual(toolResultBlock);
    });
  });

  describe('toolInputsMap', () => {
    it('should create empty map when no tool uses exist', () => {
      const messages = [
        {
          type: 'user',
          uuid: uuid1,
          session_id: 'session-1',
          message: {
            role: 'user',
            content: 'Hello',
          },
        },
        {
          type: 'assistant',
          uuid: uuid2,
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Hi!' }],
          },
        },
      ] as unknown as SDKMessage[];

      const { result } = renderHook(() => useMessageMaps(messages, 'session-1'));
      expect(result.current.toolInputsMap.size).toBe(0);
    });

    it('should map tool_use id to input data', () => {
      const toolInput = { file_path: '/test.txt', limit: 100 };
      const messages = [
        {
          type: 'assistant',
          uuid: uuid1,
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tool-use-abc',
                name: 'Read',
                input: toolInput,
              },
            ],
          },
        },
      ] as unknown as SDKMessage[];

      const { result } = renderHook(() => useMessageMaps(messages, 'session-1'));

      expect(result.current.toolInputsMap.size).toBe(1);
      expect(result.current.toolInputsMap.get('tool-use-abc')).toEqual(toolInput);
    });

    it('should handle multiple tool uses in the same message', () => {
      const messages = [
        {
          type: 'assistant',
          uuid: uuid1,
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tool-1',
                name: 'Read',
                input: { file: 'a.txt' },
              },
              {
                type: 'text',
                text: 'Some text in between',
              },
              {
                type: 'tool_use',
                id: 'tool-2',
                name: 'Write',
                input: { file: 'b.txt', content: 'data' },
              },
            ],
          },
        },
      ] as unknown as SDKMessage[];

      const { result } = renderHook(() => useMessageMaps(messages, 'session-1'));

      expect(result.current.toolInputsMap.size).toBe(2);
      expect(result.current.toolInputsMap.get('tool-1')).toEqual({ file: 'a.txt' });
      expect(result.current.toolInputsMap.get('tool-2')).toEqual({
        file: 'b.txt',
        content: 'data',
      });
    });

    it('should handle tool uses across multiple messages', () => {
      const messages = [
        {
          type: 'assistant',
          uuid: uuid1,
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tool-1',
                name: 'Read',
                input: { path: '/a' },
              },
            ],
          },
        },
        {
          type: 'user',
          uuid: uuid2,
          session_id: 'session-1',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tool-1',
                content: 'result',
              },
            ],
          },
        },
        {
          type: 'assistant',
          uuid: uuid3,
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tool-2',
                name: 'Write',
                input: { path: '/b' },
              },
            ],
          },
        },
      ] as unknown as SDKMessage[];

      const { result } = renderHook(() => useMessageMaps(messages, 'session-1'));

      expect(result.current.toolInputsMap.size).toBe(2);
      expect(result.current.toolInputsMap.get('tool-1')).toEqual({ path: '/a' });
      expect(result.current.toolInputsMap.get('tool-2')).toEqual({ path: '/b' });
    });

    it('should ignore non-assistant messages', () => {
      const messages = [
        {
          type: 'user',
          uuid: uuid1,
          session_id: 'session-1',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_use',
                id: 'fake-tool',
                name: 'Fake',
                input: {},
              },
            ],
          },
        },
      ] as unknown as SDKMessage[];

      const { result } = renderHook(() => useMessageMaps(messages, 'session-1'));
      expect(result.current.toolInputsMap.size).toBe(0);
    });
  });

  describe('sessionInfoMap', () => {
    it('should create empty map when no system:init messages exist', () => {
      const messages = [
        {
          type: 'user',
          uuid: uuid1,
          session_id: 'session-1',
          message: {
            role: 'user',
            content: 'Hello',
          },
        },
        {
          type: 'assistant',
          uuid: uuid2,
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Hi!' }],
          },
        },
      ] as unknown as SDKMessage[];

      const { result } = renderHook(() => useMessageMaps(messages, 'session-1'));
      expect(result.current.sessionInfoMap.size).toBe(0);
    });

    it('should attach system:init to preceding user message', () => {
      const systemInitMessage = {
        type: 'system',
        subtype: 'init',
        uuid: uuid2,
        session_id: 'session-1',
        message: {
          cwd: '/workspace',
          model: 'claude-sonnet-4',
        },
      };

      const messages = [
        {
          type: 'user',
          uuid: uuid1,
          session_id: 'session-1',
          message: {
            role: 'user',
            content: 'Hello',
          },
        },
        systemInitMessage,
      ] as unknown as SDKMessage[];

      const { result } = renderHook(() => useMessageMaps(messages, 'session-1'));

      expect(result.current.sessionInfoMap.size).toBe(1);
      expect(result.current.sessionInfoMap.get(uuid1)).toBe(systemInitMessage);
    });

    it('should attach system:init to following user message when no preceding user message', () => {
      const systemInitMessage = {
        type: 'system',
        subtype: 'init',
        uuid: uuid1,
        session_id: 'session-1',
        message: {
          cwd: '/workspace',
          model: 'claude-sonnet-4',
        },
      };

      const messages = [
        systemInitMessage,
        {
          type: 'user',
          uuid: uuid2,
          session_id: 'session-1',
          message: {
            role: 'user',
            content: 'Hello',
          },
        },
      ] as unknown as SDKMessage[];

      const { result } = renderHook(() => useMessageMaps(messages, 'session-1'));

      expect(result.current.sessionInfoMap.size).toBe(1);
      expect(result.current.sessionInfoMap.get(uuid2)).toBe(systemInitMessage);
    });

    it('should handle multiple system:init messages', () => {
      const systemInit1 = {
        type: 'system',
        subtype: 'init',
        uuid: uuid2,
        session_id: 'session-1',
        message: { cwd: '/workspace1' },
      };

      const systemInit2 = {
        type: 'system',
        subtype: 'init',
        uuid: uuid5,
        session_id: 'session-1',
        message: { cwd: '/workspace2' },
      };

      const messages = [
        {
          type: 'user',
          uuid: uuid1,
          session_id: 'session-1',
          message: { role: 'user', content: 'First message' },
        },
        systemInit1,
        {
          type: 'assistant',
          uuid: uuid3,
          session_id: 'session-1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Response' }] },
        },
        {
          type: 'user',
          uuid: uuid4,
          session_id: 'session-1',
          message: { role: 'user', content: 'Second message' },
        },
        systemInit2,
      ] as unknown as SDKMessage[];

      const { result } = renderHook(() => useMessageMaps(messages, 'session-1'));

      expect(result.current.sessionInfoMap.size).toBe(2);
      expect(result.current.sessionInfoMap.get(uuid1)).toBe(systemInit1);
      expect(result.current.sessionInfoMap.get(uuid4)).toBe(systemInit2);
    });

    it('should ignore non-init system messages', () => {
      const messages = [
        {
          type: 'user',
          uuid: uuid1,
          session_id: 'session-1',
          message: { role: 'user', content: 'Hello' },
        },
        {
          type: 'system',
          subtype: 'result',
          uuid: uuid2,
          session_id: 'session-1',
          message: { summary: 'Task completed' },
        },
      ] as unknown as SDKMessage[];

      const { result } = renderHook(() => useMessageMaps(messages, 'session-1'));
      expect(result.current.sessionInfoMap.size).toBe(0);
    });

    it('should skip assistant messages when finding preceding user message', () => {
      const systemInit = {
        type: 'system',
        subtype: 'init',
        uuid: uuid4,
        session_id: 'session-1',
        message: { cwd: '/workspace' },
      };

      const messages = [
        {
          type: 'user',
          uuid: uuid1,
          session_id: 'session-1',
          message: { role: 'user', content: 'User message' },
        },
        {
          type: 'assistant',
          uuid: uuid2,
          session_id: 'session-1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Response' }] },
        },
        {
          type: 'assistant',
          uuid: uuid3,
          session_id: 'session-1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'More' }] },
        },
        systemInit,
      ] as unknown as SDKMessage[];

      const { result } = renderHook(() => useMessageMaps(messages, 'session-1'));

      expect(result.current.sessionInfoMap.get(uuid1)).toBe(systemInit);
    });
  });

  describe('subagentMessagesMap', () => {
    it('should create empty map when no messages have parent_tool_use_id', () => {
      const messages = [
        {
          type: 'user',
          uuid: uuid1,
          session_id: 'session-1',
          message: {
            role: 'user',
            content: 'Hello',
          },
        },
        {
          type: 'assistant',
          uuid: uuid2,
          session_id: 'session-1',
          parent_tool_use_id: null,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Hi there!' }],
          },
        },
      ] as unknown as SDKMessage[];

      const { result } = renderHook(() => useMessageMaps(messages, 'session-1'));
      expect(result.current.subagentMessagesMap.size).toBe(0);
    });

    it('should group messages by parent_tool_use_id', () => {
      const messages = [
        {
          type: 'assistant',
          uuid: uuid1,
          session_id: 'session-1',
          parent_tool_use_id: null,
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tool-1',
                name: 'Task',
                input: {
                  subagent_type: 'explore',
                  description: 'Test',
                  prompt: 'Do something',
                },
              },
            ],
          },
        },
        {
          type: 'assistant',
          uuid: uuid2,
          session_id: 'session-1',
          parent_tool_use_id: 'tool-1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Exploring...' }],
          },
        },
        {
          type: 'user',
          uuid: uuid3,
          session_id: 'session-1',
          parent_tool_use_id: 'tool-1',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'sub-tool-1',
                content: 'Result',
              },
            ],
          },
        },
        {
          type: 'assistant',
          uuid: uuid4,
          session_id: 'session-1',
          parent_tool_use_id: 'tool-1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Done!' }],
          },
        },
      ] as unknown as SDKMessage[];

      const { result } = renderHook(() => useMessageMaps(messages, 'session-1'));
      const subagentMessages = result.current.subagentMessagesMap.get('tool-1');

      expect(subagentMessages).toBeDefined();
      expect(subagentMessages?.length).toBe(3);
      expect(subagentMessages?.[0].uuid).toBe(uuid2);
      expect(subagentMessages?.[1].uuid).toBe(uuid3);
      expect(subagentMessages?.[2].uuid).toBe(uuid4);
    });

    it('should handle multiple parent tool use IDs', () => {
      const messages = [
        {
          type: 'assistant',
          uuid: uuid1,
          session_id: 'session-1',
          parent_tool_use_id: 'tool-1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Agent 1 message' }],
          },
        },
        {
          type: 'assistant',
          uuid: uuid2,
          session_id: 'session-1',
          parent_tool_use_id: 'tool-2',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Agent 2 message' }],
          },
        },
        {
          type: 'assistant',
          uuid: uuid3,
          session_id: 'session-1',
          parent_tool_use_id: 'tool-1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Agent 1 second message' }],
          },
        },
      ] as unknown as SDKMessage[];

      const { result } = renderHook(() => useMessageMaps(messages, 'session-1'));

      const agent1Messages = result.current.subagentMessagesMap.get('tool-1');
      const agent2Messages = result.current.subagentMessagesMap.get('tool-2');

      expect(agent1Messages?.length).toBe(2);
      expect(agent2Messages?.length).toBe(1);
      expect(agent1Messages?.[0].uuid).toBe(uuid1);
      expect(agent1Messages?.[1].uuid).toBe(uuid3);
      expect(agent2Messages?.[0].uuid).toBe(uuid2);
    });

    it('should group agent_id-scoped messages under the matching Task tool_use id', () => {
      const messages = [
        {
          type: 'assistant',
          uuid: uuid1,
          session_id: 'session-1',
          parent_tool_use_id: null,
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tool-1',
                name: 'Task',
                input: { subagent_type: 'explore', description: 'Test', prompt: 'Do it' },
              },
            ],
          },
        },
        {
          type: 'assistant',
          uuid: uuid2,
          session_id: 'session-1',
          parent_tool_use_id: 'tool-1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Subagent work' }],
          },
        },
        {
          type: 'system',
          subtype: 'permission_denied',
          uuid: uuid3,
          session_id: 'session-1',
          agent_id: 'tool-1',
          tool_name: 'Bash',
          message: 'Denied',
        },
      ] as unknown as SDKMessage[];

      const { result } = renderHook(() => useMessageMaps(messages, 'session-1'));

      const subagentMessages = result.current.subagentMessagesMap.get('tool-1');
      expect(subagentMessages).toBeDefined();
      expect(subagentMessages?.length).toBe(2);
      expect(subagentMessages?.[0].uuid).toBe(uuid2);
      expect(subagentMessages?.[1].uuid).toBe(uuid3);
    });
  });

  describe('taskNotificationsMap', () => {
    it('maps tool_use_id to its terminal task_notification', () => {
      const messages = [
        {
          type: 'assistant',
          uuid: uuid1,
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'ls' } }],
          },
        },
        {
          type: 'system',
          uuid: uuid2,
          session_id: 'session-1',
          subtype: 'task_notification',
          task_id: 'task-1',
          tool_use_id: 'tu-1',
          status: 'completed',
          summary: 'ok',
          usage: { total_tokens: 10, tool_uses: 1, duration_ms: 5 },
        },
      ] as unknown as SDKMessage[];

      const { result } = renderHook(() => useMessageMaps(messages, 'session-1'));
      expect(result.current.taskNotificationsMap.size).toBe(1);
      const n = result.current.taskNotificationsMap.get('tu-1');
      expect(n?.status).toBe('completed');
      expect(n?.summary).toBe('ok');
    });

    it('skips task_notifications without a tool_use_id (orphans)', () => {
      const messages = [
        {
          type: 'system',
          uuid: uuid1,
          session_id: 'session-1',
          subtype: 'task_notification',
          task_id: 'task-1',
          status: 'completed',
          summary: 'orphan',
        },
      ] as unknown as SDKMessage[];

      const { result } = renderHook(() => useMessageMaps(messages, 'session-1'));
      expect(result.current.taskNotificationsMap.size).toBe(0);
    });

    it('ignores non-task_notification system messages', () => {
      const messages = [
        {
          type: 'system',
          uuid: uuid1,
          session_id: 'session-1',
          subtype: 'init',
        },
        {
          type: 'system',
          uuid: uuid2,
          session_id: 'session-1',
          subtype: 'session_state_changed',
        },
      ] as unknown as SDKMessage[];

      const { result } = renderHook(() => useMessageMaps(messages, 'session-1'));
      expect(result.current.taskNotificationsMap.size).toBe(0);
    });
  });

  describe('runningToolUseIdsByMessageUuid', () => {
    it('maps running tool use IDs to their assistant message UUID', () => {
      const messages = [
        {
          type: 'assistant',
          uuid: uuid1,
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'tool-running', name: 'Bash', input: {} },
              { type: 'tool_use', id: 'tool-idle', name: 'Read', input: {} },
            ],
          },
        },
        {
          type: 'assistant',
          uuid: uuid2,
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tool-running-2', name: 'Task', input: {} }],
          },
        },
      ] as unknown as SDKMessage[];

      const { result } = renderHook(() =>
        useMessageMaps(messages, 'session-1', [], new Set(['tool-running', 'tool-running-2']))
      );

      expect(result.current.runningToolUseIdsByMessageUuid.get(uuid1)).toEqual(
        new Set(['tool-running'])
      );
      expect(result.current.runningToolUseIdsByMessageUuid.get(uuid2)).toEqual(
        new Set(['tool-running-2'])
      );
    });

    it('does not mark idle tool uses as running', () => {
      const messages = [
        {
          type: 'assistant',
          uuid: uuid1,
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tool-idle', name: 'Bash', input: {} }],
          },
        },
      ] as unknown as SDKMessage[];

      const { result } = renderHook(() =>
        useMessageMaps(messages, 'session-1', [], new Set(['other-tool']))
      );

      expect(result.current.runningToolUseIdsByMessageUuid.size).toBe(0);
    });
  });

  describe('taskProgressMap', () => {
    it('maps tool_use_id to its latest task_progress', () => {
      const messages = [
        {
          type: 'system',
          uuid: uuid1,
          session_id: 'session-1',
          subtype: 'task_progress',
          task_id: 'task-1',
          tool_use_id: 'tu-1',
          description: 'first',
          usage: { total_tokens: 10, tool_uses: 1, duration_ms: 1000 },
          last_tool_name: 'Read',
        },
        {
          type: 'system',
          uuid: uuid2,
          session_id: 'session-1',
          subtype: 'task_progress',
          task_id: 'task-1',
          tool_use_id: 'tu-1',
          description: 'second',
          usage: { total_tokens: 12400, tool_uses: 3, duration_ms: 8200 },
          last_tool_name: 'Bash',
          summary: 'still running',
        },
      ] as unknown as SDKMessage[];

      const { result } = renderHook(() => useMessageMaps(messages, 'session-1'));
      expect(result.current.taskProgressMap.size).toBe(1);
      const progress = result.current.taskProgressMap.get('tu-1');
      expect(progress?.description).toBe('second');
      expect(progress?.usage.total_tokens).toBe(12400);
      expect(progress?.last_tool_name).toBe('Bash');
    });

    it('skips task_progress without a tool_use_id', () => {
      const messages = [
        {
          type: 'system',
          uuid: uuid1,
          session_id: 'session-1',
          subtype: 'task_progress',
          task_id: 'task-1',
          description: 'orphan',
          usage: { total_tokens: 10, tool_uses: 1, duration_ms: 1000 },
        },
      ] as unknown as SDKMessage[];

      const { result } = renderHook(() => useMessageMaps(messages, 'session-1'));
      expect(result.current.taskProgressMap.size).toBe(0);
    });

    it('ignores non-task_progress system messages', () => {
      const messages = [
        {
          type: 'system',
          uuid: uuid1,
          session_id: 'session-1',
          subtype: 'task_started',
          task_id: 'task-1',
          tool_use_id: 'tu-1',
        },
      ] as unknown as SDKMessage[];

      const { result } = renderHook(() => useMessageMaps(messages, 'session-1'));
      expect(result.current.taskProgressMap.size).toBe(0);
    });
  });

  describe('foldableToolUseIds', () => {
    it('includes top-level tool_uses and nested ones whose parent Task card is present', () => {
      const messages = [
        {
          type: 'assistant',
          uuid: uuid1,
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'task-1', name: 'Task', input: {} }],
          },
        },
        {
          type: 'assistant',
          uuid: uuid2,
          session_id: 'session-1',
          parent_tool_use_id: 'task-1',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'nested-1', name: 'Bash', input: {} }],
          },
        },
        {
          type: 'assistant',
          uuid: uuid3,
          session_id: 'session-1',
          parent_tool_use_id: 'task-missing',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'nested-orphan', name: 'Bash', input: {} }],
          },
        },
      ] as unknown as SDKMessage[];

      const { result } = renderHook(() => useMessageMaps(messages, 'session-1'));
      const f = result.current.foldableToolUseIds;
      expect(f.has('task-1')).toBe(true);
      expect(f.has('nested-1')).toBe(true);
      expect(f.has('nested-orphan')).toBe(false);
    });
  });

  describe('performance characteristics', () => {
    it('keeps session init mapping linear for large tool-heavy threads', () => {
      const messages: SDKMessage[] = [];
      for (let i = 0; i < 250; i++) {
        messages.push({
          type: 'user',
          uuid: `user-${i}`,
          session_id: 'session-1',
          message: { role: 'user', content: `prompt ${i}` },
        } as unknown as SDKMessage);
        messages.push({
          type: 'system',
          subtype: 'init',
          uuid: `init-${i}`,
          session_id: 'session-1',
          tools: ['Read', 'Bash'],
        } as unknown as SDKMessage);
        messages.push({
          type: 'assistant',
          uuid: `assistant-${i}`,
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: `tool-${i}`, name: 'Read', input: {} }],
          },
        } as unknown as SDKMessage);
        messages.push({
          type: 'user',
          uuid: `result-${i}`,
          session_id: 'session-1',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: `tool-${i}`, content: 'ok' }],
          },
        } as unknown as SDKMessage);
      }

      const { result } = renderHook(() => useMessageMaps(messages, 'session-1'));

      expect(result.current.sessionInfoMap.size).toBe(250);
      expect(result.current.toolInputsMap.size).toBe(250);
      expect(result.current.toolResultsMap.size).toBe(250);
      expect(result.current.sessionInfoMap.get('user-249')?.uuid).toBe('init-249');
    });
  });

  describe('replacementStatusMap', () => {
    it('should mark superseded and retracted messages by uuid', () => {
      const messages = [
        {
          type: 'assistant',
          uuid: uuid1,
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'original' }],
          },
        },
        {
          type: 'assistant',
          uuid: uuid2,
          session_id: 'session-1',
          supersedes: [uuid1],
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'replacement' }],
          },
        },
        {
          type: 'assistant',
          uuid: uuid3,
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'retracted' }],
          },
        },
        {
          type: 'system',
          subtype: 'model_refusal_fallback',
          uuid: uuid4,
          session_id: 'session-1',
          retracted_message_uuids: [uuid3],
        },
      ] as unknown as SDKMessage[];

      const { result } = renderHook(() => useMessageMaps(messages, 'session-1'));

      expect(result.current.replacementStatusMap.get(uuid1)).toBe('superseded');
      expect(result.current.replacementStatusMap.get(uuid3)).toBe('retracted');
      expect(result.current.replacementStatusMap.has(uuid2)).toBe(false);
      expect(result.current.replacementStatusMap.has(uuid4)).toBe(false);
    });
  });
});
