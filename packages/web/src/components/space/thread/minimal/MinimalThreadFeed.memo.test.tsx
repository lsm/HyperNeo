import { render } from '@testing-library/preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseThreadRow } from '../space-task-thread-events';
import { MinimalThreadFeed } from './MinimalThreadFeed';

const markdownRenders = vi.hoisted(() => new Map<string, number>());

vi.mock('../../../chat/MarkdownRenderer.tsx', () => ({
  default: ({ content }: { content: string }) => {
    markdownRenders.set(content, (markdownRenders.get(content) ?? 0) + 1);
    return <div data-testid="md">{content}</div>;
  },
}));

vi.mock('../../../../lib/router', () => ({
  pushOverlayHistory: vi.fn(),
}));

const baseTime = new Date('2026-04-25T18:00:00Z').getTime();

const rawRows = [
  { id: 'a1', label: 'Coder Agent', offset: 0, message: assistantText('a1', 'coder done') },
  { id: 'r1', label: 'Coder Agent', offset: 1000, message: resultMessage('r1') },
  { id: 'a2', label: 'Reviewer Agent', offset: 5000, message: assistantText('a2', 'looks good') },
  { id: 'r2', label: 'Reviewer Agent', offset: 6000, message: resultMessage('r2') },
];

function assistantText(uuid: string, text: string) {
  return { type: 'assistant', uuid, message: { content: [{ type: 'text', text }] } };
}

function resultMessage(uuid: string) {
  return {
    type: 'result',
    uuid,
    subtype: 'success',
    result: '',
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

function parseRows(rows: typeof rawRows) {
  return rows.map((row) =>
    parseThreadRow({
      id: row.id,
      sessionId: 'space:s:task:t',
      kind: 'task_agent',
      role: 'task',
      label: row.label,
      taskId: 't',
      taskTitle: 'Task',
      messageType: 'assistant',
      content: JSON.stringify(row.message),
      createdAt: baseTime + row.offset,
    })
  );
}

describe('MinimalThreadFeed memoization', () => {
  beforeEach(() => {
    markdownRenders.clear();
  });

  it('does not re-render unchanged turns when a delta re-parses every row', () => {
    const { rerender } = render(<MinimalThreadFeed parsedRows={parseRows(rawRows)} />);
    expect(markdownRenders.get('coder done')).toBe(1);
    expect(markdownRenders.get('looks good')).toBe(1);

    const appended = [
      ...rawRows,
      { id: 'a3', label: 'Coder Agent', offset: 9000, message: assistantText('a3', 'next turn') },
    ];
    rerender(<MinimalThreadFeed parsedRows={parseRows(appended)} />);

    expect(markdownRenders.get('coder done')).toBe(1);
    expect(markdownRenders.get('looks good')).toBe(1);
    expect(markdownRenders.get('next turn')).toBe(1);
  });

  it('re-renders a turn whose content changed', () => {
    const { rerender } = render(<MinimalThreadFeed parsedRows={parseRows(rawRows)} />);

    const edited = rawRows.map((row) =>
      row.id === 'a2' ? { ...row, message: assistantText('a2', 'needs changes') } : row
    );
    rerender(<MinimalThreadFeed parsedRows={parseRows(edited)} />);

    expect(markdownRenders.get('coder done')).toBe(1);
    expect(markdownRenders.get('needs changes')).toBe(1);
  });
});
