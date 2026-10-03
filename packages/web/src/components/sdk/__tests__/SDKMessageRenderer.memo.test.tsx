import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/preact';
import type { SDKMessage } from '@hyperneo/shared/sdk/sdk.d.ts';
import type { ChatMessage } from '@hyperneo/shared';
import { useMessageMaps } from '../../../hooks/useMessageMaps.ts';

const assistantRenders = vi.hoisted(() => new Map<string, number>());

vi.mock('../SDKAssistantMessage.tsx', () => ({
  SDKAssistantMessage: ({ message }: { message: { uuid: string } }) => {
    assistantRenders.set(message.uuid, (assistantRenders.get(message.uuid) ?? 0) + 1);
    return <div data-testid={`assistant-${message.uuid}`} />;
  },
}));

import { SDKMessageRenderer } from '../SDKMessageRenderer';

function assistantText(uuid: string, text: string): SDKMessage {
  return {
    type: 'assistant',
    uuid,
    session_id: 's1',
    parent_tool_use_id: null,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  } as unknown as SDKMessage;
}

function assistantToolUse(uuid: string, toolUseId: string): SDKMessage {
  return {
    type: 'assistant',
    uuid,
    session_id: 's1',
    parent_tool_use_id: null,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: toolUseId, name: 'Read', input: { file_path: '/a' } }],
    },
  } as unknown as SDKMessage;
}

function toolResult(uuid: string, toolUseId: string): SDKMessage {
  return {
    type: 'user',
    uuid,
    session_id: 's1',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }],
    },
  } as unknown as SDKMessage;
}

function Feed({ messages }: { messages: SDKMessage[] }) {
  const maps = useMessageMaps(messages as unknown as ChatMessage[], 's1');
  return (
    <div>
      {messages.map((msg, idx) => (
        <SDKMessageRenderer
          key={msg.uuid}
          message={msg}
          toolResultsMap={maps.toolResultsMap}
          toolInputsMap={maps.toolInputsMap}
          subagentMessagesMap={maps.subagentMessagesMap}
          taskNotificationsMap={maps.taskNotificationsMap}
          taskProgressMap={maps.taskProgressMap}
          foldableToolUseIds={maps.foldableToolUseIds}
          completedHookUuids={maps.completedHookUuids}
          replacementStatusMap={maps.replacementStatusMap}
          sessionId="s1"
          isLiveTail={idx === messages.length - 1}
        />
      ))}
    </div>
  );
}

describe('SDKMessageRenderer memo across message deltas', () => {
  beforeEach(() => {
    assistantRenders.clear();
  });

  it('does not re-render unchanged rows when a text-only message is appended', () => {
    const base = [
      assistantText('a1', 'first'),
      assistantToolUse('a2', 'tool-1'),
      toolResult('u1', 'tool-1'),
      assistantText('a3', 'third'),
    ];
    const { rerender } = render(<Feed messages={base} />);
    expect(assistantRenders.get('a1')).toBe(1);
    expect(assistantRenders.get('a2')).toBe(1);

    rerender(<Feed messages={[...base, assistantText('a4', 'streamed')]} />);

    expect(assistantRenders.get('a1')).toBe(1);
    expect(assistantRenders.get('a2')).toBe(1);
    expect(assistantRenders.get('a3')).toBe(2);
    expect(assistantRenders.get('a4')).toBe(1);
  });

  it('re-renders rows when a delta changes a map they read', () => {
    const base = [assistantText('a1', 'first'), assistantToolUse('a2', 'tool-1')];
    const { rerender } = render(<Feed messages={base} />);

    rerender(<Feed messages={[...base, toolResult('u1', 'tool-1')]} />);

    expect(assistantRenders.get('a1')).toBe(2);
    expect(assistantRenders.get('a2')).toBe(2);
  });
});
