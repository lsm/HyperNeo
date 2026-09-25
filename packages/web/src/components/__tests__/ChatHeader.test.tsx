// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { render, cleanup, fireEvent } from '@testing-library/preact';
import type { Session } from '@hyperneo/shared';
import { ChatHeader } from '../ChatHeader';
import { contextPanelOpenSignal } from '../../lib/signals';
import { connectionState } from '../../lib/state';

describe('ChatHeader', () => {
  const mockSession: Session = {
    id: 'session-1',
    title: 'Test Session',
    status: 'active',
    workspacePath: '/test/path',
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    metadata: {
      messageCount: 10,
      totalTokens: 5000,
      totalCost: 0.05,
    },
    worktree: {
      path: '/worktree/path',
      branch: 'session/test-branch',
    },
  };

  const defaultProps = {
    session: mockSession,
    onToolsClick: vi.fn(() => {}),
    onExportClick: vi.fn(() => {}),
    onResetClick: vi.fn(() => {}),
    onArchiveClick: vi.fn(() => {}),
    onDeleteClick: vi.fn(() => {}),
  };

  beforeEach(() => {
    cleanup();
  });

  afterEach(() => {
    cleanup();
  });

  describe('Basic Rendering', () => {
    it('should render session title', () => {
      const { container } = render(<ChatHeader {...defaultProps} />);

      const title = container.querySelector('h2');
      expect(title?.textContent).toBe('Test Session');
    });

    it('should render "New Session" when session has no title', () => {
      const sessionWithoutTitle = { ...mockSession, title: '' };
      const { container } = render(<ChatHeader {...defaultProps} session={sessionWithoutTitle} />);

      const title = container.querySelector('h2');
      expect(title?.textContent).toBe('New Session');
    });

    it('should render "New Session" when session is null', () => {
      const { container } = render(<ChatHeader {...defaultProps} session={null} />);

      const title = container.querySelector('h2');
      expect(title?.textContent).toBe('New Session');
    });

    it('does not render stats in the compact header', () => {
      const { container } = render(<ChatHeader {...defaultProps} />);

      expect(container.textContent).not.toContain('5.0k');
      expect(container.textContent).not.toContain('$0.0500');
    });

    it('does not render git branch text in the compact header', () => {
      const { container } = render(<ChatHeader {...defaultProps} />);

      expect(container.textContent).not.toContain('session/test-branch');
    });
  });

  describe('Return to parent', () => {
    it('is hidden for a session without a parent', () => {
      const { queryByTestId } = render(
        <ChatHeader {...defaultProps} onReturnToParent={vi.fn(() => {})} />
      );
      expect(queryByTestId('chat-header-return-to-parent')).toBeNull();
      expect(queryByTestId('chat-header-returned')).toBeNull();
    });

    it('sends the wrap-up request for an active clone and shows the returned marker', () => {
      const onReturnToParent = vi.fn(() => {});
      const clone = {
        ...mockSession,
        parentSessionId: 'parent-1',
        metadata: { ...mockSession.metadata, clone: { returnedAt: '2026-09-24T00:00:00.000Z' } },
      };
      const { getByTestId } = render(
        <ChatHeader {...defaultProps} session={clone} onReturnToParent={onReturnToParent} />
      );

      getByTestId('chat-header-return-to-parent').click();
      expect(onReturnToParent).toHaveBeenCalledOnce();
      expect(getByTestId('chat-header-returned').textContent).toContain('returned');
    });

    it('is hidden for an archived clone', () => {
      const clone = { ...mockSession, parentSessionId: 'parent-1', status: 'archived' };
      const { queryByTestId } = render(
        <ChatHeader {...defaultProps} session={clone} onReturnToParent={vi.fn(() => {})} />
      );
      expect(queryByTestId('chat-header-return-to-parent')).toBeNull();
    });
  });

  describe('Mobile Menu Button', () => {
    it('should render hamburger menu button', () => {
      const { container } = render(<ChatHeader {...defaultProps} />);

      const menuButton = container.querySelector('button[title="Open menu"]');
      expect(menuButton).toBeTruthy();
    });

    it('should have hamburger icon in menu button', () => {
      const { container } = render(<ChatHeader {...defaultProps} />);

      const menuButton = container.querySelector('button[title="Open menu"]')!;
      const svg = menuButton.querySelector('svg');
      expect(svg).toBeTruthy();
    });

    it('should set contextPanelOpenSignal to true when menu button is clicked', () => {
      contextPanelOpenSignal.value = false;

      const { container } = render(<ChatHeader {...defaultProps} />);

      const menuButton = container.querySelector('button[title="Open menu"]')!;
      menuButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(contextPanelOpenSignal.value).toBe(true);

      contextPanelOpenSignal.value = false;
    });
  });

  describe('Info Button', () => {
    it('renders exactly one far-right info button', () => {
      const { container } = render(<ChatHeader {...defaultProps} />);

      const infoButtons = container.querySelectorAll('button[title="Session info"]');
      expect(infoButtons.length).toBe(1);
    });

    it('keeps session actions out of the header until the actions menu is opened', () => {
      const { container } = render(<ChatHeader {...defaultProps} />);

      expect(container.textContent).not.toContain('Export chat');
      expect(container.textContent).not.toContain('Reset agent');
      expect(container.textContent).not.toContain('Archive session');
    });
  });

  describe('Actions Menu', () => {
    beforeEach(() => {
      connectionState.value = 'connected';
    });

    function openMenu(container: HTMLElement) {
      fireEvent.click(container.querySelector('[data-testid="chat-menu-btn"]')!);
      return container.querySelector('[role="menu"]')!;
    }

    it('lists Tools, Export, Reset, Archive and Delete for a writable session', () => {
      const { container } = render(<ChatHeader {...defaultProps} />);
      const menu = openMenu(container);

      const titles = Array.from(menu.querySelectorAll('[role="menuitem"]')).map((b) =>
        b.getAttribute('title')
      );
      expect(titles).toEqual([
        'Tools',
        'Export chat',
        'Reset agent',
        'Archive session',
        'Delete chat',
      ]);
    });

    it('hides Tools when readonly and Archive/Delete when features.archive is false', () => {
      const { container } = render(
        <ChatHeader {...defaultProps} readonly features={{ archive: false }} />
      );
      const menu = openMenu(container);

      const titles = Array.from(menu.querySelectorAll('[role="menuitem"]')).map((b) =>
        b.getAttribute('title')
      );
      expect(titles).toEqual(['Export chat', 'Reset agent']);
    });

    it('invokes the matching handler when an item is clicked', () => {
      const onExportClick = vi.fn();
      const onResetClick = vi.fn();
      const { container } = render(
        <ChatHeader {...defaultProps} onExportClick={onExportClick} onResetClick={onResetClick} />
      );
      const menu = openMenu(container);

      fireEvent.click(menu.querySelector('button[title="Reset agent"]')!);
      expect(onResetClick).toHaveBeenCalledTimes(1);
      expect(onExportClick).not.toHaveBeenCalled();
    });

    it('disables Archive for an archived session', () => {
      const { container } = render(
        <ChatHeader {...defaultProps} session={{ ...mockSession, status: 'archived' }} />
      );
      const menu = openMenu(container);

      expect(
        (menu.querySelector('button[title="Archive session"]') as HTMLButtonElement).disabled
      ).toBe(true);
    });

    it('shows the info button at every breakpoint (no longer lg-only)', () => {
      const { container } = render(<ChatHeader {...defaultProps} />);

      const infoButton = container.querySelector('button[title="Session info"]')!;
      const wrapper = infoButton.parentElement;
      expect(wrapper?.className).not.toContain('hidden');
    });

    it('still renders the info button when features.sessionInfo is false', () => {
      const { container } = render(
        <ChatHeader {...defaultProps} features={{ sessionInfo: false }} />
      );

      expect(container.querySelector('button[title="Session info"]')).toBeTruthy();
    });

    it('renders without error when action handlers and flags are provided', () => {
      const { container } = render(
        <ChatHeader {...defaultProps} archiving={true} resettingAgent={true} readonly={true} />
      );

      const title = container.querySelector('h2');
      expect(title?.textContent).toBe('Test Session');
    });
  });
});
