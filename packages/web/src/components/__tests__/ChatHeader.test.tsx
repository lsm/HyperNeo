// @ts-nocheck

import type { Session } from '@hyperneo/shared';

import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionStore } from '../../lib/session-store';
import { contextPanelOpenSignal, rightPanelTargetSignal } from '../../lib/signals';
import { connectionState } from '../../lib/state';
import { ChatHeader } from '../ChatHeader';

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
    sessionStore.activeSessionId.value = 'session-1';
  });

  afterEach(() => {
    cleanup();
    sessionStore.activeSessionId.value = null;
  });

  describe('View mode in the actions menu', () => {
    beforeEach(() => {
      connectionState.value = 'connected';
    });

    function openMenu(container: HTMLElement) {
      fireEvent.click(container.querySelector('[data-testid="chat-menu-btn"]')!);
      return container.querySelector('[role="menu"]')!;
    }

    it('lists Full, Compact and Minimal with the current mode checked', () => {
      const { container } = render(
        <ChatHeader {...defaultProps} displayMode="compact" onDisplayModeChange={vi.fn()} />
      );
      const items = Array.from(openMenu(container).querySelectorAll('[role="menuitem"]'));

      expect(items.slice(0, 3).map((item) => item.getAttribute('title'))).toEqual([
        'Full view',
        'Compact view',
        'Minimal view',
      ]);
      const checked = items
        .slice(0, 3)
        .filter((item) => item.querySelectorAll('svg').length === 2)
        .map((item) => item.getAttribute('title'));
      expect(checked).toEqual(['Compact view']);
    });

    it('switches the display mode when a view is picked', () => {
      const onDisplayModeChange = vi.fn();
      const { container } = render(
        <ChatHeader
          {...defaultProps}
          displayMode="compact"
          onDisplayModeChange={onDisplayModeChange}
        />
      );
      const menu = openMenu(container);

      fireEvent.click(menu.querySelector('button[title="Minimal view"]')!);
      expect(onDisplayModeChange).toHaveBeenCalledWith('minimal');
    });

    it('hides the view options without a handler', () => {
      const { container } = render(<ChatHeader {...defaultProps} />);
      const menu = openMenu(container);

      expect(menu.querySelector('button[title="Full view"]')).toBeNull();
    });
  });

  describe('Basic Rendering', () => {
    it('shows the visible user folder path in the session header', () => {
      const { getByTestId } = render(
        <ChatHeader
          {...defaultProps}
          session={{ ...mockSession, workspacePath: '/synthetic/HyperNeo', worktree: undefined }}
        />
      );
      const folder = getByTestId('chat-header-folder');
      expect(folder.textContent).toBe('/synthetic/HyperNeo');
      expect(folder.getAttribute('title')).toBe('/synthetic/HyperNeo');
    });
    it('should render session title', () => {
      const { container } = render(<ChatHeader {...defaultProps} />);

      const title = container.querySelector('h2');
      expect(title?.textContent).toBe('Test Session');
    });

    it('should render "New conversation" when session has no title', () => {
      const sessionWithoutTitle = { ...mockSession, title: '' };
      const { container } = render(<ChatHeader {...defaultProps} session={sessionWithoutTitle} />);

      const title = container.querySelector('h2');
      expect(title?.textContent).toBe('New conversation');
    });

    it('should render "New conversation" when session is null', () => {
      const { container } = render(<ChatHeader {...defaultProps} session={null} />);

      const title = container.querySelector('h2');
      expect(title?.textContent).toBe('New conversation');
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
    it('represents clone conversations with an icon and a clean title', () => {
      const { getByTestId, getByLabelText } = render(
        <ChatHeader
          {...defaultProps}
          session={{ ...mockSession, title: 'Research · 分身', parentSessionId: 'parent-1' }}
        />
      );
      expect(getByTestId('chat-header-title').textContent).toBe('Research');
      expect(getByLabelText('Clone conversation').querySelector('svg')).toBeTruthy();
    });

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

  describe('Schedules and conversation actions', () => {
    beforeEach(() => {
      rightPanelTargetSignal.value = null;
      connectionState.value = 'connected';
    });

    function openMenu(container: HTMLElement) {
      fireEvent.click(container.querySelector('[data-testid="chat-menu-btn"]')!);
      return container.querySelector('[role="menu"]')!;
    }

    it('offers Schedules in the menu only for the globally active session', () => {
      const { container } = render(<ChatHeader {...defaultProps} />);
      expect(openMenu(container).querySelector('button[title="Schedules"]')).toBeTruthy();
      expect(container.querySelector('[data-testid="schedules-btn"]')).toBeNull();
      cleanup();

      sessionStore.activeSessionId.value = 'other';
      const other = render(<ChatHeader {...defaultProps} />);
      expect(openMenu(other.container).querySelector('button[title="Schedules"]')).toBeNull();
    });

    it('toggles the schedules panel in the right panel from the menu', async () => {
      const { container } = render(<ChatHeader {...defaultProps} />);

      fireEvent.click(openMenu(container).querySelector('button[title="Schedules"]')!);
      expect(rightPanelTargetSignal.value).toEqual({ type: 'schedules', sessionId: 'session-1' });
      await waitFor(() => expect(container.querySelector('[role="menu"]')).toBeNull());

      fireEvent.click(openMenu(container).querySelector('button[title="Schedules"]')!);
      expect(rightPanelTargetSignal.value).toBeNull();
    });

    it('omits the workspace path and branch rows when the chat has neither', () => {
      const bare = {
        ...mockSession,
        workspacePath: undefined,
        worktree: undefined,
        gitBranch: undefined,
      };
      const { container } = render(<ChatHeader {...defaultProps} session={bare} />);
      const menu = openMenu(container);

      expect(menu.querySelector('button[title="Copy session id"]')).toBeTruthy();
      expect(menu.querySelector('button[title="Copy workspace path"]')).toBeNull();
      expect(menu.querySelector('button[title="Copy branch"]')).toBeNull();
    });

    it('puts the copy icon on the right of each copy row', () => {
      const { container } = render(<ChatHeader {...defaultProps} />);
      const row = openMenu(container).querySelector('button[title="Copy session id"]')!;

      expect(row.textContent).toBe('Session ID');
      expect(row.querySelectorAll('svg').length).toBe(2);
    });

    it('has no info or display-mode button in the header bar', () => {
      const { container } = render(<ChatHeader {...defaultProps} />);

      expect(container.querySelector('[data-testid="session-info-btn"]')).toBeNull();
      expect(container.querySelector('[data-testid="display-mode-btn"]')).toBeNull();
    });

    it('renames the chat in place from the menu', () => {
      const { container } = render(<ChatHeader {...defaultProps} />);
      fireEvent.click(openMenu(container).querySelector('button[title="Rename conversation"]')!);

      expect(container.querySelector('[data-testid="chat-header-rename-input"]')).toBeTruthy();
      expect(container.querySelector('[data-testid="chat-header-title"]')).toBeNull();
    });

    it('offers copy actions for the session ID, workspace path and branch', () => {
      const { container } = render(<ChatHeader {...defaultProps} />);
      const titles = Array.from(openMenu(container).querySelectorAll('[role="menuitem"]')).map(
        (b) => b.getAttribute('title')
      );

      expect(titles).toEqual(
        expect.arrayContaining(['Copy session id', 'Copy workspace path', 'Copy branch'])
      );
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

    it('lists Tools, Export, Reset, Move, Archive and Delete for a writable session', () => {
      const { container } = render(<ChatHeader {...defaultProps} />);
      const menu = openMenu(container);

      const titles = Array.from(menu.querySelectorAll('[role="menuitem"]')).map((b) =>
        b.getAttribute('title')
      );
      expect(titles).toEqual([
        'Schedules',
        'Rename conversation',
        'Move under another chat',
        'Export chat',
        'Copy session id',
        'Copy workspace path',
        'Copy branch',
        'Tools',
        'Reset agent',
        'Archive chat',
        'Delete chat',
      ]);
    });

    it('offers Move to top level for a child chat', () => {
      const child = { ...mockSession, parentSessionId: 'parent-1' };
      const { container } = render(<ChatHeader {...defaultProps} session={child} />);
      const menu = openMenu(container);

      const titles = Array.from(menu.querySelectorAll('[role="menuitem"]')).map((b) =>
        b.getAttribute('title')
      );
      expect(titles).toContain('Move to top level');
      expect(titles).not.toContain('Move under another chat');
    });

    it('offers no move action for Neo or Space sessions', () => {
      for (const session of [
        { ...mockSession, id: 'neo:root' },
        { ...mockSession, context: { spaceId: 'space-1' } },
      ]) {
        const { container, unmount } = render(<ChatHeader {...defaultProps} session={session} />);
        const menu = openMenu(container);
        const titles = Array.from(menu.querySelectorAll('[role="menuitem"]')).map((b) =>
          b.getAttribute('title')
        );
        expect(titles).toContain('Export chat');
        expect(titles).not.toContain('Move under another chat');
        expect(titles).not.toContain('Move to top level');
        unmount();
      }
    });

    it('hides Tools when readonly and Archive/Delete when features.archive is false', () => {
      const { container } = render(
        <ChatHeader {...defaultProps} readonly features={{ archive: false }} />
      );
      const menu = openMenu(container);

      const titles = Array.from(menu.querySelectorAll('[role="menuitem"]')).map((b) =>
        b.getAttribute('title')
      );
      expect(titles).toEqual([
        'Schedules',
        'Export chat',
        'Copy session id',
        'Copy workspace path',
        'Copy branch',
        'Reset agent',
      ]);
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
        (menu.querySelector('button[title="Archive chat"]') as HTMLButtonElement).disabled
      ).toBe(true);
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
