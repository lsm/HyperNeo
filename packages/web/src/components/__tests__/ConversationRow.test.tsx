import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { ConversationRow } from '../ConversationRow.tsx';
import { getSessionSidebarStatus } from '../../lib/session-sidebar-status.ts';

afterEach(cleanup);

describe('ConversationRow', () => {
  it.each(['processing', 'waiting_for_input', 'rate_limit_cooldown', 'interrupted'])(
    'keeps unread visible alongside %s',
    (state) => {
      const status = getSessionSidebarStatus({
        status: 'active',
        processingState: { status: state },
      });
      render(<ConversationRow title="Review" status={status} unreadCount={5} onClick={() => {}} />);
      expect(screen.getByRole('img', { name: status.label })).toBeTruthy();
      expect(screen.getByLabelText('5 unread messages')).toBeTruthy();
    }
  );

  it('exposes clone identity and selection without adding text to the title', () => {
    render(
      <ConversationRow
        title="Review"
        selected
        clone
        nested
        status={getSessionSidebarStatus({})}
        onClick={() => {}}
      />
    );
    expect(screen.getByRole('heading').textContent).toBe('Review');
    expect(screen.getByRole('img', { name: 'Clone conversation' })).toBeTruthy();
    expect(screen.getByRole('button').getAttribute('aria-current')).toBe('page');
  });

  it('keeps actions outside the navigation button and supports keyboard rename', () => {
    const navigate = vi.fn();
    const rename = vi.fn();
    const archive = vi.fn();
    render(
      <ConversationRow
        title="Review"
        status={getSessionSidebarStatus({})}
        onClick={navigate}
        onTitleDoubleClick={rename}
        actions={<button onClick={archive}>Archive</button>}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    expect(archive).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('button', { name: /Idle Review/ }), { key: 'F2' });
    expect(rename).toHaveBeenCalledOnce();
  });
});
