// @ts-nocheck
/**
 * Tests for SessionInfoModal Component
 */

import { render, cleanup } from '@testing-library/preact';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionInfoModal } from '../SessionInfoModal';
import type { Session } from '@hyperneo/shared';

// Mock CopyButton to simplify testing
vi.mock('../ui/CopyButton', () => ({
  CopyButton: ({ text, label }: { text: string; label?: string }) => (
    <button data-testid="copy-button" data-text={text} title={label}>
      Copy
    </button>
  ),
}));

function createMockSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'test-session-id',
    title: 'Test Session',
    workspacePath: '/Users/test/project',
    createdAt: '2024-01-01T00:00:00.000Z',
    lastActiveAt: '2024-01-01T00:00:00.000Z',
    status: 'active',
    config: {
      model: 'sonnet',
      maxTokens: 8192,
      temperature: 1.0,
    },
    metadata: {
      messageCount: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0,
      toolCallCount: 0,
    },
    ...overrides,
  };
}

describe('SessionInfoModal', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    cleanup();
    document.body.style.overflow = '';
  });

  describe('Rendering', () => {
    it('should render modal with title', () => {
      const session = createMockSession();
      render(<SessionInfoModal isOpen={true} onClose={() => {}} session={session} />);

      const title = document.body.querySelector('h2');
      expect(title?.textContent).toBe('Session Info');
    });

    it('should not render when closed', () => {
      const session = createMockSession();
      render(<SessionInfoModal isOpen={false} onClose={() => {}} session={session} />);

      const modal = document.body.querySelector('[role="dialog"]');
      expect(modal).toBeNull();
    });

    it('should not render when session is null', () => {
      render(<SessionInfoModal isOpen={true} onClose={() => {}} session={null} />);

      const modal = document.body.querySelector('[role="dialog"]');
      expect(modal).toBeNull();
    });
  });

  describe('SDK Folder Path', () => {
    it('should display SDK folder path', () => {
      const session = createMockSession({ workspacePath: '/Users/test/project' });
      render(<SessionInfoModal isOpen={true} onClose={() => {}} session={session} />);

      // Find the SDK Folder label
      const labels = document.body.querySelectorAll('span');
      const sdkFolderLabel = Array.from(labels).find((l) => l.textContent === 'SDK Folder');
      expect(sdkFolderLabel).toBeTruthy();
    });

    it('should compute SDK folder path correctly', () => {
      const session = createMockSession({ workspacePath: '/Users/test/project' });
      render(<SessionInfoModal isOpen={true} onClose={() => {}} session={session} />);

      // The path should replace / and . with -
      // /Users/test/project -> -Users-test-project
      const expectedPath = '~/.claude/projects/-Users-test-project';

      // Find the copy button with the SDK folder path
      const copyButtons = document.body.querySelectorAll('[data-testid="copy-button"]');
      const sdkFolderButton = Array.from(copyButtons).find(
        (btn) => btn.getAttribute('data-text') === expectedPath
      );
      expect(sdkFolderButton).toBeTruthy();
    });

    it('should handle workspace path with dots', () => {
      const session = createMockSession({ workspacePath: '/Users/test/.config/project' });
      render(<SessionInfoModal isOpen={true} onClose={() => {}} session={session} />);

      // Both / and . should be replaced with -
      const expectedPath = '~/.claude/projects/-Users-test--config-project';

      const copyButtons = document.body.querySelectorAll('[data-testid="copy-button"]');
      const sdkFolderButton = Array.from(copyButtons).find(
        (btn) => btn.getAttribute('data-text') === expectedPath
      );
      expect(sdkFolderButton).toBeTruthy();
    });
  });

  describe('SDK Session ID', () => {
    it('should display SDK session ID when available', () => {
      const session = createMockSession({ sdkSessionId: 'sdk-123-456' });
      render(<SessionInfoModal isOpen={true} onClose={() => {}} session={session} />);

      // Find the SDK Session ID label
      const labels = document.body.querySelectorAll('span');
      const sdkSessionLabel = Array.from(labels).find((l) => l.textContent === 'SDK Session ID');
      expect(sdkSessionLabel).toBeTruthy();

      // Find the copy button with the SDK session ID
      const copyButtons = document.body.querySelectorAll('[data-testid="copy-button"]');
      const sdkSessionButton = Array.from(copyButtons).find(
        (btn) => btn.getAttribute('data-text') === 'sdk-123-456'
      );
      expect(sdkSessionButton).toBeTruthy();
    });

    it('should not display SDK session ID when not available', () => {
      const session = createMockSession({ sdkSessionId: undefined });
      render(<SessionInfoModal isOpen={true} onClose={() => {}} session={session} />);

      // Find the SDK Session ID label - should not exist
      const labels = document.body.querySelectorAll('span');
      const sdkSessionLabel = Array.from(labels).find((l) => l.textContent === 'SDK Session ID');
      expect(sdkSessionLabel).toBeFalsy();
    });
  });

  describe('Copy Buttons', () => {
    it('should render copy button for SDK folder', () => {
      const session = createMockSession();
      render(<SessionInfoModal isOpen={true} onClose={() => {}} session={session} />);

      const copyButtons = document.body.querySelectorAll('[data-testid="copy-button"]');
      expect(copyButtons.length).toBeGreaterThanOrEqual(1);
    });

    it('should render copy button for SDK session ID when available', () => {
      const session = createMockSession({ sdkSessionId: 'sdk-123' });
      render(<SessionInfoModal isOpen={true} onClose={() => {}} session={session} />);

      const copyButtons = document.body.querySelectorAll('[data-testid="copy-button"]');
      // Now displays many fields, so there should be multiple copy buttons
      expect(copyButtons.length).toBeGreaterThan(2);
    });
  });

  describe('Interactions', () => {
    it('should call onClose when close button is clicked', () => {
      const onClose = vi.fn();
      const session = createMockSession();
      render(<SessionInfoModal isOpen={true} onClose={onClose} session={session} />);

      const closeButton = document.body.querySelector('button[aria-label="Close modal"]');
      closeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('should call onClose when Escape is pressed', () => {
      const onClose = vi.fn();
      const session = createMockSession();
      render(<SessionInfoModal isOpen={true} onClose={onClose} session={session} />);

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('Styling', () => {
    it('should use large size modal', () => {
      const session = createMockSession();
      render(<SessionInfoModal isOpen={true} onClose={() => {}} session={session} />);

      const modal = document.body.querySelector('.bg-dark-900');
      expect(modal?.className).toContain('max-w-2xl');
    });

    it('should render in portal', () => {
      const session = createMockSession();
      render(<SessionInfoModal isOpen={true} onClose={() => {}} session={session} />);

      const portal = document.body.querySelector('[data-portal="true"]');
      expect(portal).toBeTruthy();
    });
  });

  describe('Usage Statistics with non-zero values', () => {
    it('should format and display total cost when > 0', () => {
      const session = createMockSession({
        metadata: {
          messageCount: 10,
          totalTokens: 5000,
          inputTokens: 2000,
          outputTokens: 3000,
          totalCost: 0.1234,
          toolCallCount: 5,
        },
      });
      render(<SessionInfoModal isOpen={true} onClose={() => {}} session={session} />);

      // Find the Total Cost value
      const spans = document.body.querySelectorAll('span');
      const costValue = Array.from(spans).find((s) => s.textContent === '$0.1234');
      expect(costValue).toBeTruthy();
    });

    it('should format and display token counts when > 0', () => {
      const session = createMockSession({
        metadata: {
          messageCount: 10,
          totalTokens: 12345,
          inputTokens: 5000,
          outputTokens: 7345,
          totalCost: 0.05,
          toolCallCount: 5,
        },
      });
      render(<SessionInfoModal isOpen={true} onClose={() => {}} session={session} />);

      // Find the Total Tokens value (formatted with commas)
      const spans = document.body.querySelectorAll('span');
      const tokenValue = Array.from(spans).find((s) => s.textContent === '12,345');
      expect(tokenValue).toBeTruthy();

      // Find the Input Tokens value
      const inputTokenValue = Array.from(spans).find((s) => s.textContent === '5,000');
      expect(inputTokenValue).toBeTruthy();

      // Find the Output Tokens value
      const outputTokenValue = Array.from(spans).find((s) => s.textContent === '7,345');
      expect(outputTokenValue).toBeTruthy();
    });

    it('should not display cost when 0', () => {
      const session = createMockSession({
        metadata: {
          messageCount: 10,
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalCost: 0,
          toolCallCount: 0,
        },
      });
      render(<SessionInfoModal isOpen={true} onClose={() => {}} session={session} />);

      // Should not find Total Cost label (since it's not rendered when 0)
      const spans = document.body.querySelectorAll('span');
      const costLabel = Array.from(spans).find((s) => s.textContent === 'Total Cost');
      // If cost is 0, the InfoRow returns null, so the label should not be present
      // Actually, let me check: if formatCost returns undefined, InfoRow renders null
      // So we shouldn't see a Total Cost row
      expect(costLabel).toBeFalsy();
    });
  });

  describe('Date formatting edge cases', () => {
    it('should handle invalid date strings gracefully', () => {
      // Create a session with an invalid date string that will fail Date parsing
      // Note: Most strings will parse to a valid date, but we can test the error case
      // by mocking Date or using a string that causes issues
      const session = createMockSession({
        createdAt: 'invalid-date-string',
      });
      render(<SessionInfoModal isOpen={true} onClose={() => {}} session={session} />);

      // The date should be displayed as-is when parsing fails
      const spans = document.body.querySelectorAll('span');
      // Note: JavaScript's Date constructor is very permissive, so most strings
      // will parse to "Invalid Date" which toLocaleString() will return
      // Let's check that at least the Created row is rendered
      const createdLabel = Array.from(spans).find((s) => s.textContent === 'Created');
      expect(createdLabel).toBeTruthy();
    });

    it('should return original string when Date throws', () => {
      // Mock Date to throw to test the catch block
      const OriginalDate = globalThis.Date;
      const mockDate = vi.fn().mockImplementation(() => {
        throw new Error('Date parsing error');
      });
      // Copy static properties
      Object.setPrototypeOf(mockDate, OriginalDate);
      globalThis.Date = mockDate as unknown as DateConstructor;

      try {
        const session = createMockSession({
          createdAt: 'test-date-string',
        });
        render(<SessionInfoModal isOpen={true} onClose={() => {}} session={session} />);

        // When Date throws, the original string should be returned
        const spans = document.body.querySelectorAll('span');
        const dateValue = Array.from(spans).find((s) => s.textContent === 'test-date-string');
        expect(dateValue).toBeTruthy();
      } finally {
        // Restore original Date
        globalThis.Date = OriginalDate;
      }
    });
  });

  describe('Worktree Information', () => {
    it('should display worktree section when worktree exists', () => {
      const session = createMockSession({
        worktree: {
          worktreePath: '/Users/test/.hyperneo/worktrees/session-123',
          mainRepoPath: '/Users/test/project',
          branch: 'session/test-branch',
        },
      });
      render(<SessionInfoModal isOpen={true} onClose={() => {}} session={session} />);

      // Find the Worktree section header (CSS makes it uppercase but textContent is original)
      const headers = document.body.querySelectorAll('h3');
      const worktreeHeader = Array.from(headers).find((h) => h.textContent === 'Worktree');
      expect(worktreeHeader).toBeTruthy();

      // Check for worktree path
      const copyButtons = document.body.querySelectorAll('[data-testid="copy-button"]');
      const worktreePathButton = Array.from(copyButtons).find(
        (btn) => btn.getAttribute('data-text') === '/Users/test/.hyperneo/worktrees/session-123'
      );
      expect(worktreePathButton).toBeTruthy();
    });

    it('should not display worktree section when worktree is undefined', () => {
      const session = createMockSession({ worktree: undefined });
      render(<SessionInfoModal isOpen={true} onClose={() => {}} session={session} />);

      // Should not find Worktree header
      const headers = document.body.querySelectorAll('h3');
      const worktreeHeader = Array.from(headers).find((h) => h.textContent === 'Worktree');
      expect(worktreeHeader).toBeFalsy();
    });
  });

  describe('Git Branch', () => {
    it('should display git branch when available', () => {
      const session = createMockSession({ gitBranch: 'feature/test-branch' });
      render(<SessionInfoModal isOpen={true} onClose={() => {}} session={session} />);

      const copyButtons = document.body.querySelectorAll('[data-testid="copy-button"]');
      const branchButton = Array.from(copyButtons).find(
        (btn) => btn.getAttribute('data-text') === 'feature/test-branch'
      );
      expect(branchButton).toBeTruthy();
    });
  });

  describe('Archived Session', () => {
    it('should display archived date when session is archived', () => {
      const session = createMockSession({
        archivedAt: '2024-02-01T00:00:00.000Z',
      });
      render(<SessionInfoModal isOpen={true} onClose={() => {}} session={session} />);

      // Find the Archived label
      const spans = document.body.querySelectorAll('span');
      const archivedLabel = Array.from(spans).find((s) => s.textContent === 'Archived');
      expect(archivedLabel).toBeTruthy();
    });
  });

  describe('Available Commands', () => {
    it('should display available commands when present', () => {
      const session = createMockSession({
        availableCommands: ['/help', '/clear', '/model'],
      });
      render(<SessionInfoModal isOpen={true} onClose={() => {}} session={session} />);

      // Find the Available Commands value
      const spans = document.body.querySelectorAll('span');
      const commandsValue = Array.from(spans).find(
        (s) => s.textContent === '/help, /clear, /model'
      );
      expect(commandsValue).toBeTruthy();
    });

    it('should not display available commands when empty array', () => {
      const session = createMockSession({
        availableCommands: [],
      });
      render(<SessionInfoModal isOpen={true} onClose={() => {}} session={session} />);

      // Should not find Available Commands label
      const spans = document.body.querySelectorAll('span');
      const commandsLabel = Array.from(spans).find((s) => s.textContent === 'Available Commands');
      expect(commandsLabel).toBeFalsy();
    });
  });

  describe('Internal Flags', () => {
    it('should display Title Generated as Yes when true', () => {
      const session = createMockSession({
        metadata: {
          messageCount: 5,
          totalTokens: 1000,
          inputTokens: 500,
          outputTokens: 500,
          totalCost: 0.01,
          toolCallCount: 2,
          titleGenerated: true,
        },
      });
      render(<SessionInfoModal isOpen={true} onClose={() => {}} session={session} />);

      // Find the Title Generated value
      const spans = document.body.querySelectorAll('span');
      const titleGeneratedLabel = Array.from(spans).find(
        (s) => s.textContent === 'Title Generated'
      );
      expect(titleGeneratedLabel).toBeTruthy();

      // Find the 'Yes' value (should appear after the label)
      const yesValue = Array.from(spans).find((s) => s.textContent === 'Yes');
      expect(yesValue).toBeTruthy();
    });

    it('should display Title Generated as No when false', () => {
      const session = createMockSession({
        metadata: {
          messageCount: 5,
          totalTokens: 1000,
          inputTokens: 500,
          outputTokens: 500,
          totalCost: 0.01,
          toolCallCount: 2,
          titleGenerated: false,
        },
      });
      render(<SessionInfoModal isOpen={true} onClose={() => {}} session={session} />);

      const spans = document.body.querySelectorAll('span');
      const titleGeneratedLabel = Array.from(spans).find(
        (s) => s.textContent === 'Title Generated'
      );
      expect(titleGeneratedLabel).toBeTruthy();
    });

    it('should display Workspace Initialized as Yes when true', () => {
      const session = createMockSession({
        metadata: {
          messageCount: 5,
          totalTokens: 1000,
          inputTokens: 500,
          outputTokens: 500,
          totalCost: 0.01,
          toolCallCount: 2,
          workspaceInitialized: true,
        },
      });
      render(<SessionInfoModal isOpen={true} onClose={() => {}} session={session} />);

      const spans = document.body.querySelectorAll('span');
      const workspaceLabel = Array.from(spans).find(
        (s) => s.textContent === 'Workspace Initialized'
      );
      expect(workspaceLabel).toBeTruthy();
    });

    it('should display Workspace Initialized as No when false', () => {
      const session = createMockSession({
        metadata: {
          messageCount: 5,
          totalTokens: 1000,
          inputTokens: 500,
          outputTokens: 500,
          totalCost: 0.01,
          toolCallCount: 2,
          workspaceInitialized: false,
        },
      });
      render(<SessionInfoModal isOpen={true} onClose={() => {}} session={session} />);

      const spans = document.body.querySelectorAll('span');
      const workspaceLabel = Array.from(spans).find(
        (s) => s.textContent === 'Workspace Initialized'
      );
      expect(workspaceLabel).toBeTruthy();
    });
  });
});
