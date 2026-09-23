// @ts-nocheck

import { render, fireEvent } from '@testing-library/preact';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import ReferenceAutocomplete from '../ReferenceAutocomplete';
import type { ReferenceSearchResult } from '@hyperneo/shared';

const fileResult: ReferenceSearchResult = {
  type: 'file',
  id: 'src/app.ts',
  displayText: 'app.ts',
  subtitle: 'src/app.ts',
};

const otherFileResult: ReferenceSearchResult = {
  type: 'file',
  id: 'src/index.ts',
  displayText: 'index.ts',
  subtitle: 'src/index.ts',
};

const folderResult: ReferenceSearchResult = {
  type: 'folder',
  id: 'src',
  displayText: 'src',
  subtitle: 'src/',
};

function sectionLabels(container: Element): Array<string | undefined> {
  return Array.from(container.querySelectorAll('span.text-\\[10px\\]')).map((el) =>
    el.textContent?.trim()
  );
}

const defaultProps = {
  results: [fileResult, otherFileResult, folderResult],
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

    it('skips results of the retired task and goal types', () => {
      const retired = [
        { type: 'task', id: 't-1', displayText: 'Fix login bug' },
        { type: 'goal', id: 'g-1', displayText: 'Launch v2' },
      ];
      const { container } = render(
        <ReferenceAutocomplete {...defaultProps} results={[...retired, fileResult]} />
      );
      expect(container.querySelectorAll('button[type="button"]').length).toBe(1);
      expect(container.textContent).not.toContain('Fix login bug');
      expect(container.textContent).not.toContain('Launch v2');
    });

    it('renders displayText for each result', () => {
      const { container } = render(<ReferenceAutocomplete {...defaultProps} />);
      expect(container.textContent).toContain('app.ts');
      expect(container.textContent).toContain('index.ts');
      expect(container.textContent).toContain('src');
    });

    it('renders subtitle for results that have it', () => {
      const { container } = render(<ReferenceAutocomplete {...defaultProps} />);
      expect(container.textContent).toContain('src/app.ts');
      expect(container.textContent).toContain('src/index.ts');
      expect(container.textContent).toContain('src/');
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
      expect(sectionLabels(container)).toEqual(['Files', 'Folders']);
    });

    it('does not render empty group section labels', () => {
      const { container } = render(
        <ReferenceAutocomplete {...defaultProps} results={[folderResult]} />
      );
      expect(sectionLabels(container)).toEqual(['Folders']);
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
      expect(onSelect).toHaveBeenCalledWith(fileResult);
    });

    it('calls onSelect with the second file result when its button is clicked', () => {
      const onSelect = vi.fn();
      const { container } = render(<ReferenceAutocomplete {...defaultProps} onSelect={onSelect} />);
      const buttons = container.querySelectorAll('button[type="button"]');
      fireEvent.click(buttons[1]);
      expect(onSelect).toHaveBeenCalledWith(otherFileResult);
    });

    it('calls onSelect with the folder result when folder button is clicked', () => {
      const onSelect = vi.fn();
      const { container } = render(<ReferenceAutocomplete {...defaultProps} onSelect={onSelect} />);
      const buttons = container.querySelectorAll('button[type="button"]');
      fireEvent.click(buttons[2]);
      expect(onSelect).toHaveBeenCalledWith(folderResult);
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
    it('renders groups in order: Files, Folders', () => {
      const { container } = render(
        <ReferenceAutocomplete {...defaultProps} results={[folderResult, fileResult]} />
      );
      expect(sectionLabels(container)).toEqual(['Files', 'Folders']);
    });
  });

  describe('Result count', () => {
    it('renders the correct number of result buttons', () => {
      const { container } = render(<ReferenceAutocomplete {...defaultProps} />);
      const buttons = container.querySelectorAll('button[type="button"]');
      expect(buttons.length).toBe(3);
    });

    it('renders only matching buttons for single-type results', () => {
      const { container } = render(
        <ReferenceAutocomplete {...defaultProps} results={[folderResult]} />
      );
      const buttons = container.querySelectorAll('button[type="button"]');
      expect(buttons.length).toBe(1);
    });
  });
});
