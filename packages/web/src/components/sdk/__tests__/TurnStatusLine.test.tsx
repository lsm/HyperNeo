import { cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatTurn } from '../../../lib/chat-turns.ts';
import { TurnStatusLine } from '../TurnStatusLine.tsx';

const turn = (overrides: Partial<ChatTurn>): ChatTurn => ({
  key: 'u1',
  messages: [],
  toolCount: 6,
  errorCount: 1,
  startedAt: 0,
  durationMs: 41_000,
  outcome: 'done',
  ...overrides,
});

describe('TurnStatusLine', () => {
  afterEach(cleanup);

  it('summarizes a finished turn and toggles its steps', () => {
    const onToggle = vi.fn();
    const { getByTestId, getByRole } = render(
      <TurnStatusLine turn={turn({})} expanded={false} onToggle={onToggle} />
    );
    expect(getByTestId('turn-status-line').textContent).toContain(
      'Worked for 41s · 6 tool calls · 1 failed'
    );
    fireEvent.click(getByRole('button', { name: 'Show steps' }));
    expect(onToggle).toHaveBeenCalled();
  });

  it('shows the current action while running', () => {
    const { getByTestId } = render(
      <TurnStatusLine
        turn={turn({ outcome: 'running', startedAt: Date.now() })}
        currentAction="Reading router.ts..."
        expanded={false}
        onToggle={() => {}}
      />
    );
    expect(getByTestId('turn-status-line').textContent).toContain('Working · Reading router.ts');
  });

  it('stays out of the way for a plain reply', () => {
    const { container } = render(
      <TurnStatusLine
        turn={turn({ toolCount: 0, errorCount: 0 })}
        expanded={false}
        onToggle={() => {}}
      />
    );
    expect(container.innerHTML).toBe('');
  });
});
