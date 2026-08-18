// @ts-nocheck

import { render, fireEvent, cleanup } from '@testing-library/preact';
import type { ArchiveSessionResponse } from '@hyperneo/shared';
import { ArchiveConfirmDialog } from '../ArchiveConfirmDialog';

describe('ArchiveConfirmDialog', () => {
  const mockOnConfirm = vi.fn(() => {});
  const mockOnCancel = vi.fn(() => {});

  const mockCommitStatus: ArchiveSessionResponse['commitStatus'] = {
    hasUnpushedCommits: true,
    commits: [
      {
        hash: 'abc123def456',
        message: 'Fix authentication bug',
        author: 'John Doe',
        date: '2024-01-15 10:30:00',
      },
      {
        hash: 'def456ghi789',
        message: 'Add unit tests for auth module',
        author: 'John Doe',
        date: '2024-01-15 11:00:00',
      },
      {
        hash: 'ghi789jkl012',
        message: 'Update documentation',
        author: 'Jane Smith',
        date: '2024-01-15 11:30:00',
      },
    ],
  };

  beforeEach(() => {
    cleanup();
    mockOnConfirm.mockClear();
    mockOnCancel.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  describe('Basic Rendering', () => {
    it('should render nothing when commitStatus is null', () => {
      const { container } = render(
        <ArchiveConfirmDialog
          commitStatus={null}
          archiving={false}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      expect(container.children.length).toBe(0);
    });

    it('should render nothing when commitStatus is undefined', () => {
      const { container } = render(
        <ArchiveConfirmDialog
          commitStatus={undefined}
          archiving={false}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      expect(container.children.length).toBe(0);
    });

    it('should render dialog when commitStatus is provided', () => {
      const { container } = render(
        <ArchiveConfirmDialog
          commitStatus={mockCommitStatus}
          archiving={false}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      expect(container.textContent).toContain('Confirm Archive');
    });
  });

  describe('Content Display', () => {
    it('should display dialog title', () => {
      const { container } = render(
        <ArchiveConfirmDialog
          commitStatus={mockCommitStatus}
          archiving={false}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      expect(container.textContent).toContain('Confirm Archive');
    });

    it('should display commit count', () => {
      const { container } = render(
        <ArchiveConfirmDialog
          commitStatus={mockCommitStatus}
          archiving={false}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      expect(container.textContent).toContain('3 uncommitted changes');
    });

    it('should display warning message', () => {
      const { container } = render(
        <ArchiveConfirmDialog
          commitStatus={mockCommitStatus}
          archiving={false}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      expect(container.textContent).toContain(
        'These commits will be lost when the worktree is removed'
      );
    });
  });

  describe('Commit List Display', () => {
    it('should display all commit hashes', () => {
      const { container } = render(
        <ArchiveConfirmDialog
          commitStatus={mockCommitStatus}
          archiving={false}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      expect(container.textContent).toContain('abc123def456');
      expect(container.textContent).toContain('def456ghi789');
      expect(container.textContent).toContain('ghi789jkl012');
    });

    it('should display all commit messages', () => {
      const { container } = render(
        <ArchiveConfirmDialog
          commitStatus={mockCommitStatus}
          archiving={false}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      expect(container.textContent).toContain('Fix authentication bug');
      expect(container.textContent).toContain('Add unit tests for auth module');
      expect(container.textContent).toContain('Update documentation');
    });

    it('should display commit authors', () => {
      const { container } = render(
        <ArchiveConfirmDialog
          commitStatus={mockCommitStatus}
          archiving={false}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      expect(container.textContent).toContain('John Doe');
      expect(container.textContent).toContain('Jane Smith');
    });

    it('should display commit dates', () => {
      const { container } = render(
        <ArchiveConfirmDialog
          commitStatus={mockCommitStatus}
          archiving={false}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      expect(container.textContent).toContain('2024-01-15 10:30:00');
      expect(container.textContent).toContain('2024-01-15 11:00:00');
      expect(container.textContent).toContain('2024-01-15 11:30:00');
    });
  });

  describe('Button Actions', () => {
    it('should render Cancel button', () => {
      const { container } = render(
        <ArchiveConfirmDialog
          commitStatus={mockCommitStatus}
          archiving={false}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      expect(container.textContent).toContain('Cancel');
    });

    it('should render Archive Anyway button', () => {
      const { container } = render(
        <ArchiveConfirmDialog
          commitStatus={mockCommitStatus}
          archiving={false}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      expect(container.textContent).toContain('Archive Anyway');
    });

    it('should call onCancel when Cancel button is clicked', () => {
      const { container } = render(
        <ArchiveConfirmDialog
          commitStatus={mockCommitStatus}
          archiving={false}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      const cancelButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Cancel')
      )!;
      fireEvent.click(cancelButton);

      expect(mockOnCancel).toHaveBeenCalledTimes(1);
    });

    it('should call onConfirm when Archive Anyway button is clicked', () => {
      const { container } = render(
        <ArchiveConfirmDialog
          commitStatus={mockCommitStatus}
          archiving={false}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      const confirmButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Archive Anyway')
      )!;
      fireEvent.click(confirmButton);

      expect(mockOnConfirm).toHaveBeenCalledTimes(1);
    });
  });

  describe('Archiving State', () => {
    it('should show "Archiving..." when archiving is true', () => {
      const { container } = render(
        <ArchiveConfirmDialog
          commitStatus={mockCommitStatus}
          archiving={true}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      expect(container.textContent).toContain('Archiving...');
      expect(container.textContent).not.toContain('Archive Anyway');
    });

    it('should disable confirm button when archiving', () => {
      const { container } = render(
        <ArchiveConfirmDialog
          commitStatus={mockCommitStatus}
          archiving={true}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      const confirmButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Archiving...')
      )! as HTMLButtonElement;

      expect(confirmButton.disabled).toBe(true);
    });
  });

  describe('Modal Styling', () => {
    it('should have modal backdrop', () => {
      const { container } = render(
        <ArchiveConfirmDialog
          commitStatus={mockCommitStatus}
          archiving={false}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      const backdrop = container.firstElementChild;
      expect(backdrop?.className).toContain('fixed');
      expect(backdrop?.className).toContain('inset-0');
      expect(backdrop?.className).toContain('bg-black/50');
    });

    it('should have centered dialog', () => {
      const { container } = render(
        <ArchiveConfirmDialog
          commitStatus={mockCommitStatus}
          archiving={false}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      const backdrop = container.firstElementChild;
      expect(backdrop?.className).toContain('flex');
      expect(backdrop?.className).toContain('items-center');
      expect(backdrop?.className).toContain('justify-center');
    });

    it('should have rounded dialog box', () => {
      const { container } = render(
        <ArchiveConfirmDialog
          commitStatus={mockCommitStatus}
          archiving={false}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      const dialog = container.querySelector('.rounded-xl');
      expect(dialog).toBeTruthy();
    });

    it('should have proper z-index for modal overlay', () => {
      const { container } = render(
        <ArchiveConfirmDialog
          commitStatus={mockCommitStatus}
          archiving={false}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      const backdrop = container.firstElementChild;
      expect(backdrop?.className).toContain('z-50');
    });
  });

  describe('Commit List Styling', () => {
    it('should have scrollable commit list', () => {
      const { container } = render(
        <ArchiveConfirmDialog
          commitStatus={mockCommitStatus}
          archiving={false}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      const commitList = container.querySelector('.overflow-y-auto');
      expect(commitList).toBeTruthy();
    });

    it('should have max height on commit list', () => {
      const { container } = render(
        <ArchiveConfirmDialog
          commitStatus={mockCommitStatus}
          archiving={false}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      const commitList = container.querySelector('.max-h-48');
      expect(commitList).toBeTruthy();
    });

    it('should have hash styled as blue text', () => {
      const { container } = render(
        <ArchiveConfirmDialog
          commitStatus={mockCommitStatus}
          archiving={false}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      const hashElement = container.querySelector('.text-blue-400');
      expect(hashElement).toBeTruthy();
    });
  });

  describe('Single Commit', () => {
    it('should handle single commit correctly', () => {
      const singleCommitStatus: ArchiveSessionResponse['commitStatus'] = {
        hasUnpushedCommits: true,
        commits: [
          {
            hash: 'abc123',
            message: 'Single commit',
            author: 'Test User',
            date: '2024-01-15 12:00:00',
          },
        ],
      };

      const { container } = render(
        <ArchiveConfirmDialog
          commitStatus={singleCommitStatus}
          archiving={false}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      expect(container.textContent).toContain('1 uncommitted changes');
      expect(container.textContent).toContain('abc123');
      expect(container.textContent).toContain('Single commit');
    });
  });

  describe('Warning Message Styling', () => {
    it('should have orange warning text', () => {
      const { container } = render(
        <ArchiveConfirmDialog
          commitStatus={mockCommitStatus}
          archiving={false}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      const warning = container.querySelector('.text-orange-400');
      expect(warning).toBeTruthy();
      expect(warning?.textContent).toContain('lost');
    });
  });

  describe('Button Styling', () => {
    it('should have orange confirm button', () => {
      const { container } = render(
        <ArchiveConfirmDialog
          commitStatus={mockCommitStatus}
          archiving={false}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      const confirmButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Archive Anyway')
      )!;

      expect(confirmButton.className).toContain('bg-orange-500');
    });

    it('should have buttons with equal width', () => {
      const { container } = render(
        <ArchiveConfirmDialog
          commitStatus={mockCommitStatus}
          archiving={false}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      const buttons = container.querySelectorAll('button');
      for (const button of buttons) {
        expect(button.className).toContain('flex-1');
      }
    });
  });
});
