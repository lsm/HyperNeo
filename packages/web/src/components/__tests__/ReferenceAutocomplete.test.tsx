// @ts-nocheck

import { render, fireEvent } from '@testing-library/preact';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import ReferenceAutocomplete from '../ReferenceAutocomplete';
import type { ReferenceSearchResult } from '@hyperneo/shared';

const taskResult: ReferenceSearchResult = {
  type: 'task',
  id: 't-1',
  displayText: 'Fix login bug',
  subtitle: 'in-progress',
};

const goalResult: ReferenceSearchResult = {
  type: 'goal',
  id: 'g-1',
  displayText: 'Launch v2',
  subtitle: 'active',
};

const fileResult: ReferenceSearchResult = {
  type: 'file',
  id: 'src/app.ts',
  displayText: 'app.ts',
  subtitle: 'src/app.ts',
};

const folderResult: ReferenceSearchResult = {
  type: 'folder',
  id: 'src',
  displayText: 'src',
  subtitle: 'src/',
};

const defaultProps = {
  results: [taskResult, goalResult, fileResult, folderResult],
  selectedIndex: 0,
  onSelect: vi.fn(),
  onClose: vi.fn(),
};

describe('ReferenceAutocomplete', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Rendering', () => {
    it('renders nothing when results is empty', () => {
      const { container } = render(<ReferenceAutocomplete {...defaultProps} results={[]} />);
      expect(container.firstChild).toBeNull();
    });

    it('renders the container when results are present', () => {
      const { container } = render(<ReferenceAutocomplete {...defaultProps} />);
      expect(container.querySelector('div')).toBeTruthy();
    });

    it('shows "References" header when results include tasks or goals', () => {
      const { container } = render(<ReferenceAutocomplete {...defaultProps} />);
      expect(container.textContent).toContain('References');
    });

    it('shows "Files & Folders" header when results contain only file/folder types', () => {
      const { container } = render(
        <ReferenceAutocomplete {...defaultProps} results={[fileResult, folderResult]} />
      );
      expect(container.textContent).toContain('Files & Folders');
    });

    it('shows "Files & Folders" header for file-only results', () => {
      const { container } = render(
        <ReferenceAutocomplete {...defaultProps} results={[fileResult]} />
      );
      expect(container.textContent).toContain('Files & Folders');
    });

    it('shows "Files & Folders" header for folder-only results', () => {
      const { container } = render(
        <ReferenceAutocomplete {...defaultProps} results={[folderResult]} />
      );
      expect(container.textContent).toContain('Files & Folders');
    });

    it('shows "References" header when task results are present alongside files', () => {
      const { container } = render(
        <ReferenceAutocomplete {...defaultProps} results={[taskResult, fileResult]} />
      );
      expect(container.textContent).toContain('References');
    });

    it('renders displayText for each result', () => {
      const { container } = render(<ReferenceAutocomplete {...defaultProps} />);
      expect(container.textContent).toContain('Fix login bug');
      expect(container.textContent).toContain('Launch v2');
      expect(container.textContent).toContain('app.ts');
      expect(container.textContent).toContain('src');
    });

    it('renders subtitle for results that have it', () => {
      const { container } = render(<ReferenceAutocomplete {...defaultProps} />);
      expect(container.textContent).toContain('in-progress');
      expect(container.textContent).toContain('active');
      expect(container.textContent).toContain('src/app.ts');
    });

    it('does not render subtitle element when subtitle is absent', () => {
      const resultNoSubtitle: ReferenceSearchResult = {
        type: 'file',
        id: 'readme.md',
        displayText: 'README.md',
      };
      const { container } = render(
        <ReferenceAutocomplete {...defaultProps} results={[resultNoSubtitle]} />
      );
      const buttons = container.querySelectorAll('button[type="button"]');
      expect(buttons.length).toBe(1);
      const spans = buttons[0].querySelectorAll('span > span');
      expect(spans.length).toBe(1);
    });

    it('renders group section labels', () => {
      const { container } = render(<ReferenceAutocomplete {...defaultProps} />);
      expect(container.textContent).toContain('Tasks');
      expect(container.textContent).toContain('Goals');
      expect(container.textContent).toContain('Files');
      expect(container.textContent).toContain('Folders');
    });

    it('does not render empty group section labels', () => {
      const { container } = render(
        <ReferenceAutocomplete {...defaultProps} results={[taskResult]} />
      );
      expect(container.textContent).toContain('Tasks');
      expect(container.textContent).not.toContain('Goals');
      expect(container.textContent).not.toContain('Files');
      expect(container.textContent).not.toContain('Folders');
    });

    it('renders keyboard hint footer', () => {
      const { container } = render(<ReferenceAutocomplete {...defaultProps} />);
      expect(container.textContent).toContain('↑↓');
      expect(container.textContent).toContain('Enter');
      expect(container.textContent).toContain('Esc');
    });
  });

  describe('Selection highlighting', () => {
    it('applies selected styling to the item at selectedIndex', () => {
      const { container } = render(<ReferenceAutocomplete {...defaultProps} selectedIndex={0} />);
      const buttons = container.querySelectorAll('button[type="button"]');
      expect(buttons[0].className).toContain('bg-accent/20');
      expect(buttons[0].className).toContain('border-accent');
    });

    it('does not apply selected styling to non-selected items', () => {
      const { container } = render(<ReferenceAutocomplete {...defaultProps} selectedIndex={0} />);
      const buttons = container.querySelectorAll('button[type="button"]');
      for (let i = 1; i < buttons.length; i++) {
        expect(buttons[i].className).not.toContain('bg-accent/20');
      }
    });

    it('applies selected styling to the correct item when selectedIndex changes', () => {
      const { container, rerender } = render(
        <ReferenceAutocomplete {...defaultProps} selectedIndex={0} />
      );
      rerender(<ReferenceAutocomplete {...defaultProps} selectedIndex={2} />);
      const buttons = container.querySelectorAll('button[type="button"]');
      expect(buttons[2].className).toContain('bg-accent/20');
      expect(buttons[0].className).not.toContain('bg-accent/20');
    });
  });

  describe('Click selection', () => {
    it('calls onSelect with the correct result when a button is clicked', () => {
      const onSelect = vi.fn();
      const { container } = render(<ReferenceAutocomplete {...defaultProps} onSelect={onSelect} />);
      const buttons = container.querySelectorAll('button[type="button"]');
      fireEvent.click(buttons[0]);
      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(onSelect).toHaveBeenCalledWith(taskResult);
    });

    it('calls onSelect with the goal result when goal button is clicked', () => {
      const onSelect = vi.fn();
      const { container } = render(<ReferenceAutocomplete {...defaultProps} onSelect={onSelect} />);
      const buttons = container.querySelectorAll('button[type="button"]');
      fireEvent.click(buttons[1]);
      expect(onSelect).toHaveBeenCalledWith(goalResult);
    });

    it('calls onSelect with the file result when file button is clicked', () => {
      const onSelect = vi.fn();
      const { container } = render(<ReferenceAutocomplete {...defaultProps} onSelect={onSelect} />);
      const buttons = container.querySelectorAll('button[type="button"]');
      fireEvent.click(buttons[2]);
      expect(onSelect).toHaveBeenCalledWith(fileResult);
    });
  });

  describe('Click outside', () => {
    it('calls onClose when clicking outside the component', () => {
      const onClose = vi.fn();
      const { container } = render(
        <div>
          <ReferenceAutocomplete {...defaultProps} onClose={onClose} />
          <div data-testid="outside">Outside</div>
        </div>
      );
      const outside = container.querySelector('[data-testid="outside"]');
      fireEvent.mouseDown(outside!);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('calls onClose when touch-ending outside the component', () => {
      const onClose = vi.fn();
      const { container } = render(
        <div>
          <ReferenceAutocomplete {...defaultProps} onClose={onClose} />
          <div data-testid="outside">Outside</div>
        </div>
      );
      const outside = container.querySelector('[data-testid="outside"]');
      fireEvent.touchEnd(outside!);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('does not call onClose when touching inside the component', () => {
      const onClose = vi.fn();
      const { container } = render(<ReferenceAutocomplete {...defaultProps} onClose={onClose} />);
      const buttons = container.querySelectorAll('button[type="button"]');
      fireEvent.touchEnd(buttons[0]);
      expect(onClose).not.toHaveBeenCalled();
    });

    it('does not call onClose when clicking inside the component', () => {
      const onClose = vi.fn();
      const { container } = render(<ReferenceAutocomplete {...defaultProps} onClose={onClose} />);
      const buttons = container.querySelectorAll('button[type="button"]');
      fireEvent.mouseDown(buttons[0]);
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe('Positioning', () => {
    it('defaults to bottom positioning (above textarea) when no position is given', () => {
      const { container } = render(<ReferenceAutocomplete {...defaultProps} />);
      const dropdown = container.querySelector('div');
      expect(dropdown?.style.marginBottom).toBe('8px');
      expect(dropdown?.style.top).toBe('');
    });

    it('applies explicit top/left position when position prop is provided', () => {
      const { container } = render(
        <ReferenceAutocomplete {...defaultProps} position={{ top: 100, left: 50 }} />
      );
      const dropdown = container.querySelector('div');
      expect(dropdown?.style.top).toBe('100px');
      expect(dropdown?.style.left).toBe('50px');
    });
  });

  describe('Group ordering', () => {
    it('renders groups in order: Tasks, Goals, Files, Folders', () => {
      const { container } = render(<ReferenceAutocomplete {...defaultProps} />);
      const sectionLabels = Array.from(container.querySelectorAll('span.text-\\[10px\\]')).map(
        (el) => el.textContent?.trim()
      );
      expect(sectionLabels).toEqual(['Tasks', 'Goals', 'Files', 'Folders']);
    });
  });

  describe('Result count', () => {
    it('renders the correct number of result buttons', () => {
      const { container } = render(<ReferenceAutocomplete {...defaultProps} />);
      const buttons = container.querySelectorAll('button[type="button"]');
      expect(buttons.length).toBe(4);
    });

    it('renders only matching buttons for single-type results', () => {
      const { container } = render(
        <ReferenceAutocomplete {...defaultProps} results={[taskResult]} />
      );
      const buttons = container.querySelectorAll('button[type="button"]');
      expect(buttons.length).toBe(1);
    });
  });
});
