// @ts-nocheck
/**
 * Tests for the merged SessionInfoPanel.
 *
 * Covers: the background-task extraction helper, the metadata format helpers
 * (ported from the deleted SessionInfoModal), and the rendered merged panel —
 * the compact action toolbar (gated by features/readonly), the live sections,
 * the metadata sections, and the collapsed Internal region.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/preact';

import { extractBackgroundTasks } from '../../hooks/useRunningToolUseIds.ts';
import type { ChatMessage, Session } from '@hyperneo/shared';
import { connectionState } from '../../lib/state';

// Git status is fetched when the panel opens; stub it so no network/rejection
// occurs and the Git section settles to "No Git workspace.".
vi.mock('../../lib/api-helpers', () => ({
  getGitSessionStatus: vi.fn().mockResolvedValue({ mode: 'none', files: [] }),
}));

import {
  SessionInfoPanelButton,
  getSDKProjectDir,
  formatDate,
  formatCost,
  formatTokens,
} from '../SessionInfoPanel.tsx';

function createMockSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    title: 'Test Session',
    status: 'active',
    workspacePath: '/Users/test/project',
    createdAt: '2024-01-01T00:00:00.000Z',
    lastActiveAt: '2024-01-01T00:00:00.000Z',
    config: {
      model: 'sonnet',
      provider: 'anthropic',
      maxTokens: 8192,
      temperature: 1.0,
    },
    metadata: {
      messageCount: 10,
      totalTokens: 12345,
      inputTokens: 5000,
      outputTokens: 7345,
      totalCost: 0.05,
      toolCallCount: 5,
      titleGenerated: true,
      workspaceInitialized: false,
    },
    ...overrides,
  };
}

const defaultProps = {
  session: createMockSession(),
  onToolsClick: vi.fn(),
  onExportClick: vi.fn(),
  onResetClick: vi.fn(),
  onArchiveClick: vi.fn(),
  onDeleteClick: vi.fn(),
  messages: [] as ChatMessage[],
  toolInputsMap: new Map<string, unknown>(),
};

function openPanel(container: HTMLElement) {
  const trigger = container.querySelector('button[title="Session info"]')!;
  fireEvent.click(trigger);
  return container.querySelector('[data-testid="session-info-panel"]');
}

describe('SessionInfoPanel', () => {
  beforeEach(() => {
    connectionState.value = 'connected';
  });

  afterEach(() => {
    cleanup();
  });

  it('extracts paused background task updates from transcript messages', () => {
    const messages = [
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'Bash',
              input: { description: 'Run test suite', command: 'bun test' },
            },
          ],
        },
      },
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-1',
        tool_use_id: 'tool-1',
        description: 'Run tests',
      },
      {
        type: 'system',
        subtype: 'task_updated',
        task_id: 'task-1',
        patch: {
          status: 'paused',
          is_backgrounded: true,
        },
      },
    ] as unknown as ChatMessage[];

    expect(
      extractBackgroundTasks(messages, new Map([['tool-1', { command: 'bun test' }]]))
    ).toEqual([
      {
        id: 'task-1',
        toolUseId: 'tool-1',
        label: 'bun test',
        status: 'paused',
        backgrounded: true,
      },
    ]);
  });

  describe('format helpers', () => {
    describe('getSDKProjectDir', () => {
      it('replaces / and . with - in the workspace path', () => {
        expect(getSDKProjectDir('/Users/test/project')).toBe(
          '~/.claude/projects/-Users-test-project'
        );
      });

      it('handles workspace paths with dots', () => {
        expect(getSDKProjectDir('/Users/test/.config/project')).toBe(
          '~/.claude/projects/-Users-test--config-project'
        );
      });

      it('returns undefined for a missing workspace path', () => {
        expect(getSDKProjectDir(null)).toBeUndefined();
      });
    });

    describe('formatDate', () => {
      it('returns undefined when no date is provided', () => {
        expect(formatDate(undefined)).toBeUndefined();
      });

      it('formats a valid ISO date string', () => {
        expect(typeof formatDate('2024-01-01T00:00:00.000Z')).toBe('string');
      });
    });

    describe('formatCost', () => {
      it('returns undefined for zero or missing cost', () => {
        expect(formatCost(undefined)).toBeUndefined();
        expect(formatCost(0)).toBeUndefined();
      });

      it('formats cost as USD with 4 decimal places', () => {
        expect(formatCost(0.1234)).toBe('$0.1234');
      });
    });

    describe('formatTokens', () => {
      it('returns undefined for zero or missing counts', () => {
        expect(formatTokens(undefined)).toBeUndefined();
        expect(formatTokens(0)).toBeUndefined();
      });

      it('formats token counts with commas', () => {
        expect(formatTokens(12345)).toBe('12,345');
      });
    });
  });

  describe('merged panel', () => {
    it('opens the panel when the info button is clicked', () => {
      const { container } = render(<SessionInfoPanelButton {...defaultProps} />);
      expect(container.querySelector('[data-testid="session-info-panel"]')).toBeNull();

      const panel = openPanel(container);
      expect(panel).toBeTruthy();
    });

    it('renders the action toolbar with all actions when connected and writable', () => {
      const { container } = render(<SessionInfoPanelButton {...defaultProps} />);
      openPanel(container);

      const toolbar = container.querySelector('[data-testid="session-info-toolbar"]')!;
      expect(toolbar).toBeTruthy();
      expect(toolbar.querySelector('button[title="Tools"]')).toBeTruthy();
      expect(toolbar.querySelector('button[title="Export chat"]')).toBeTruthy();
      expect(toolbar.querySelector('button[title="Reset agent"]')).toBeTruthy();
      expect(toolbar.querySelector('button[title="Archive session"]')).toBeTruthy();
      expect(toolbar.querySelector('button[title="Delete chat"]')).toBeTruthy();
    });

    it('hides the Tools action when readonly', () => {
      const { container } = render(<SessionInfoPanelButton {...defaultProps} readonly />);
      openPanel(container);

      const toolbar = container.querySelector('[data-testid="session-info-toolbar"]')!;
      expect(toolbar.querySelector('button[title="Tools"]')).toBeNull();
      // Export/Reset remain available.
      expect(toolbar.querySelector('button[title="Export chat"]')).toBeTruthy();
    });

    it('hides Archive and Delete when features.archive is false', () => {
      const { container } = render(
        <SessionInfoPanelButton {...defaultProps} features={{ archive: false }} />
      );
      openPanel(container);

      const toolbar = container.querySelector('[data-testid="session-info-toolbar"]')!;
      expect(toolbar.querySelector('button[title="Archive session"]')).toBeNull();
      expect(toolbar.querySelector('button[title="Delete chat"]')).toBeNull();
      expect(toolbar.querySelector('button[title="Export chat"]')).toBeTruthy();
    });

    it('disables tools/export/reset/delete actions when disconnected', () => {
      connectionState.value = 'connecting';
      const { container } = render(<SessionInfoPanelButton {...defaultProps} />);
      openPanel(container);

      const toolbar = container.querySelector('[data-testid="session-info-toolbar"]')!;
      // Tools opens a modal that fetches daemon config, so it must also disable.
      expect(toolbar.querySelector('button[title="Tools"]')?.disabled).toBe(true);
      expect(toolbar.querySelector('button[title="Export chat"]')?.disabled).toBe(true);
      expect(toolbar.querySelector('button[title="Reset agent"]')?.disabled).toBe(true);
      expect(toolbar.querySelector('button[title="Delete chat"]')?.disabled).toBe(true);
    });

    it('invokes the action callback when an toolbar action is clicked', () => {
      const onExportClick = vi.fn();
      const { container } = render(
        <SessionInfoPanelButton {...defaultProps} onExportClick={onExportClick} />
      );
      openPanel(container);

      fireEvent.click(container.querySelector('button[title="Export chat"]')!);
      expect(onExportClick).toHaveBeenCalledTimes(1);
    });

    it('renders metadata sections (Workspace, Configuration, Usage)', () => {
      const { container } = render(<SessionInfoPanelButton {...defaultProps} />);
      openPanel(container);

      const headers = Array.from(container.querySelectorAll('h3')).map((h) => h.textContent);
      expect(headers).toContain('Workspace');
      expect(headers).toContain('Configuration');
      expect(headers).toContain('Usage');

      // Model value from config renders in the panel.
      expect(container.textContent).toContain('sonnet');
    });

    it('shows only the action toolbar (no live/metadata sections) when features.sessionInfo is false', () => {
      // Lobby-style session: actions must stay reachable, but session info is off.
      const { container } = render(
        <SessionInfoPanelButton
          {...defaultProps}
          features={{
            rewind: false,
            worktree: false,
            coordinator: false,
            archive: false,
            sessionInfo: false,
          }}
        />
      );
      openPanel(container);

      const toolbar = container.querySelector('[data-testid="session-info-toolbar"]')!;
      expect(toolbar.querySelector('button[title="Export chat"]')).toBeTruthy();

      const headers = Array.from(container.querySelectorAll('h3')).map((h) => h.textContent);
      expect(headers).not.toContain('Progress');
      expect(headers).not.toContain('Git');
      expect(headers).not.toContain('Workspace');
      expect(container.querySelector('[data-testid="session-info-internal"]')).toBeNull();
    });

    it('collapses the Internal section by default and expands on click', () => {
      const { container } = render(<SessionInfoPanelButton {...defaultProps} />);
      openPanel(container);

      const details = container.querySelector(
        '[data-testid="session-info-internal"]'
      ) as HTMLDetailsElement;
      expect(details).toBeTruthy();
      expect(details.open).toBe(false);

      fireEvent.click(details.querySelector('summary')!);
      expect(details.open).toBe(true);
    });
  });
});
