import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { ConversationRow } from '../ConversationRow.tsx';
import { getSessionSidebarStatus } from '../../lib/session-sidebar-status.ts';

afterEach(cleanup);

describe('ConversationRow', () => {
  it.each(['processing', 'waiting_for_input', 'rate_limit_cooldown', 'interrupted'])(
    'keeps unread accessible while %s owns the visible slot',
    (state) => {
      const status = getSessionSidebarStatus({
        status: 'active',
        processingState: { status: state },
      });
      render(<ConversationRow title="Review" status={status} unreadCount={5} onClick={() => {}} />);
      expect(screen.getByRole('img', { name: status.label })).toBeTruthy();
      expect(screen.getByLabelText('5 unread messages').classList.contains('sr-only')).toBe(true);
    }
  );

  it('keeps nested selection clear without a redundant clone icon', () => {
    render(
      <ConversationRow
        title="Review"
        selected
        nested
        status={getSessionSidebarStatus({})}
        onClick={() => {}}
      />
    );
    expect(screen.getByRole('heading').textContent).toBe('Review');
    expect(screen.queryByRole('img', { name: 'Clone conversation' })).toBeNull();
    expect(screen.getByRole('button').getAttribute('aria-current')).toBe('page');
  });

  it('preserves full titles and status details in rename tooltips', () => {
    const title = 'Review the proposed navigation and accessibility changes';
    render(
      <ConversationRow
        title={title}
        titleHint="Double-click or press F2 to rename"
        status={getSessionSidebarStatus({ processingState: { status: 'queued' } })}
        onClick={() => {}}
      />
    );
    expect(screen.getByRole('heading').title).toBe(
      `${title} · Queued · Double-click or press F2 to rename`
    );
  });

  it('uses one leading signal while preserving unread in the accessible row', () => {
    const { rerender } = render(
      <ConversationRow
        title="Review"
        status={getSessionSidebarStatus({ processingState: { status: 'processing' } })}
        unread
        unreadCount={100}
        onClick={() => {}}
      />
    );
    expect(screen.getByRole('img', { name: 'Processing' })).toBeTruthy();
    expect(screen.getByLabelText('100 unread messages').textContent).toBe('');
    expect(screen.getByLabelText('100 unread messages').classList.contains('sr-only')).toBe(true);
    expect(screen.getByRole('heading').classList.contains('font-semibold')).toBe(true);
    expect(screen.queryByRole('img', { name: 'Has updates' })).toBeNull();
    rerender(
      <ConversationRow
        title="Review"
        status={getSessionSidebarStatus({})}
        unread
        onClick={() => {}}
      />
    );
    expect(screen.getByRole('img', { name: 'Has updates' })).toBeTruthy();
    expect(
      screen.getByRole('img', { name: 'Has updates' }).querySelector('.sidebar-unread-mark')
    ).toBeTruthy();
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
