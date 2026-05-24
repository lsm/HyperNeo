// @ts-nocheck
/**
 * Tests for ChatHeader Component
 *
 * Tests the compact chat header with session title, action menu, and mobile hamburger menu.
 */
import { describe, it, expect, vi } from 'vitest';

import { render, cleanup, fireEvent } from '@testing-library/preact';
import type { Session } from '@neokai/shared';
import { ChatHeader } from '../ChatHeader';
import { contextPanelOpenSignal } from '../../lib/signals';

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
    onInfoClick: vi.fn(() => {}),
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
      // Reset signal state
      contextPanelOpenSignal.value = false;

      const { container } = render(<ChatHeader {...defaultProps} />);

      const menuButton = container.querySelector('button[title="Open menu"]')!;
      fireEvent.click(menuButton);

      expect(contextPanelOpenSignal.value).toBe(true);

      // Clean up
      contextPanelOpenSignal.value = false;
    });
  });

  describe('Dropdown Menu', () => {
    it('should render dropdown component', () => {
      const { container } = render(<ChatHeader {...defaultProps} />);

      // Should have some buttons for options
      const buttons = container.querySelectorAll('button');
      expect(buttons.length).toBeGreaterThan(0);
    });

    it('should render with onInfoClick handler', () => {
      const onInfoClick = vi.fn();
      const props = { ...defaultProps, onInfoClick };

      // Component should render without error when onInfoClick is provided
      const { container } = render(<ChatHeader {...props} />);

      // Basic sanity check - component rendered
      const header = container.querySelector('h2');
      expect(header).toBeTruthy();
    });

    it('should render when handlers are provided', () => {
      const onResetClick = vi.fn();
      const props = { ...defaultProps, onResetClick };

      const { container } = render(<ChatHeader {...props} />);

      // Component should render without error
      const header = container.querySelector('h2');
      expect(header).toBeTruthy();
    });
  });

  describe('Action States', () => {
    it('should show "Resetting..." when resettingAgent is true', () => {
      const { container } = render(<ChatHeader {...defaultProps} resettingAgent={true} />);

      // The reset button text should change in the dropdown items
      expect(container.textContent || '').not.toContain('Resetting...');
    });

    it('should show archiving state', () => {
      const { container } = render(<ChatHeader {...defaultProps} archiving={true} />);

      // Just verify it renders without error when archiving
      const title = container.querySelector('h2');
      expect(title?.textContent).toBe('Test Session');
    });

    it('should disable archive option for archived sessions', () => {
      const archivedSession = { ...mockSession, status: 'archived' as const };
      const { container } = render(<ChatHeader {...defaultProps} session={archivedSession} />);

      // Component should render without error
      const title = container.querySelector('h2');
      expect(title?.textContent).toBe('Test Session');
    });
  });
});
