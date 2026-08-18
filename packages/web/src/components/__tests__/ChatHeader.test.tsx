// @ts-nocheck
import { describe, it, expect, vi } from 'vitest';

import { render, cleanup } from '@testing-library/preact';
import type { Session } from '@hyperneo/shared';
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

    it('does not render the old three-dots kebab / session-options menu', () => {
      const { container } = render(<ChatHeader {...defaultProps} />);

      expect(container.querySelector('button[title="Session options"]')).toBeNull();
      expect(container.textContent).not.toContain('Export Chat');
      expect(container.textContent).not.toContain('Reset Agent');
      expect(container.textContent).not.toContain('Archive Session');
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
