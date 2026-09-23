// @ts-nocheck

import { render, fireEvent } from '@testing-library/preact';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import MentionToken from '../MentionToken';
import type { ReferenceMention, ReferenceMetadata } from '@hyperneo/shared';

const idMention: ReferenceMention = {
  type: 'file',
  id: 't-42',
  displayText: 'Fix login bug',
};

const fileMention: ReferenceMention = {
  type: 'file',
  id: 'src/app.ts',
  displayText: 'app.ts',
};

const folderMention: ReferenceMention = {
  type: 'folder',
  id: 'src',
  displayText: 'src',
};

describe('MentionToken', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Rendering', () => {
    it('renders displayText from mention when no metadata is provided', () => {
      const { container } = render(<MentionToken mention={idMention} />);
      expect(container.textContent).toContain('Fix login bug');
    });

    it('renders displayText from metadata when available', () => {
      const metadata: ReferenceMetadata = {
        '@ref{file:t-42}': { type: 'file', id: 't-42', displayText: 'Updated Task Title' },
      };
      const { container } = render(<MentionToken mention={idMention} metadata={metadata} />);
      expect(container.textContent).toContain('Updated Task Title');
    });

    it('prefers metadata displayText over mention displayText', () => {
      const metadata: ReferenceMetadata = {
        '@ref{file:t-42}': { type: 'file', id: 't-42', displayText: 'Meta Title' },
      };
      const { container } = render(<MentionToken mention={idMention} metadata={metadata} />);
      expect(container.textContent).toContain('Meta Title');
      expect(container.textContent).not.toContain('Fix login bug');
    });

    it('falls back to mention.id when displayText is empty string', () => {
      const mention: ReferenceMention = { type: 'file', id: 't-99', displayText: '' };
      const { container } = render(<MentionToken mention={mention} />);
      expect(container.textContent).toContain('t-99');
    });

    it('renders file mention with green styling', () => {
      const { container } = render(<MentionToken mention={fileMention} />);
      const token = container.querySelector('[aria-label]');
      expect(token?.className).toContain('bg-success/15');
      expect(token?.className).toContain('text-success-soft');
    });

    it('renders folder mention with yellow styling', () => {
      const { container } = render(<MentionToken mention={folderMention} />);
      const token = container.querySelector('[aria-label]');
      expect(token?.className).toContain('bg-warning/15');
      expect(token?.className).toContain('text-warning-soft');
    });

    it('renders a pill shape (rounded-full)', () => {
      const { container } = render(<MentionToken mention={idMention} />);
      const token = container.querySelector('[aria-label]');
      expect(token?.className).toContain('rounded-full');
    });

    it('renders an SVG icon for each type', () => {
      const types = [fileMention, folderMention];
      for (const mention of types) {
        const { container } = render(<MentionToken mention={mention} />);
        expect(container.querySelector('svg')).toBeTruthy();
      }
    });
  });

  describe('ARIA accessibility', () => {
    it('sets aria-label with type and displayText for file', () => {
      const { container } = render(<MentionToken mention={fileMention} />);
      const token = container.querySelector('[aria-label]');
      expect(token?.getAttribute('aria-label')).toBe('file reference: app.ts');
    });

    it('sets aria-label with type and displayText for folder', () => {
      const { container } = render(<MentionToken mention={folderMention} />);
      const token = container.querySelector('[aria-label]');
      expect(token?.getAttribute('aria-label')).toBe('folder reference: src');
    });

    it('sets role="button" when onClick is provided', () => {
      const { container } = render(<MentionToken mention={idMention} onClick={vi.fn()} />);
      const token = container.querySelector('[role="button"]');
      expect(token).toBeTruthy();
    });

    it('does not set role="button" when onClick is not provided', () => {
      const { container } = render(<MentionToken mention={idMention} />);
      const token = container.querySelector('[role="button"]');
      expect(token).toBeNull();
    });

    it('is focusable via tabIndex=0 when onClick is provided', () => {
      const { container } = render(<MentionToken mention={idMention} onClick={vi.fn()} />);
      const token = container.querySelector('[tabindex="0"]');
      expect(token).toBeTruthy();
    });

    it('is not focusable when onClick is not provided', () => {
      const { container } = render(<MentionToken mention={idMention} />);
      const token = container.querySelector('[tabindex="0"]');
      expect(token).toBeNull();
    });

    it('sets aria-describedby to tooltip id when tooltip is visible', () => {
      const { container } = render(<MentionToken mention={idMention} onClick={vi.fn()} />);
      const token = container.querySelector('[aria-label]');
      fireEvent.mouseEnter(token!);
      const tooltip = container.querySelector('[role="tooltip"]');
      const tooltipId = tooltip?.getAttribute('id');
      expect(tooltipId).toBeTruthy();
      expect(token?.getAttribute('aria-describedby')).toBe(tooltipId);
    });

    it('does not set aria-describedby when tooltip is hidden', () => {
      const { container } = render(<MentionToken mention={idMention} onClick={vi.fn()} />);
      const token = container.querySelector('[aria-label]');
      expect(token?.getAttribute('aria-describedby')).toBeNull();
    });

    it('uses metadata displayText in aria-label when available', () => {
      const metadata: ReferenceMetadata = {
        '@ref{file:t-42}': { type: 'file', id: 't-42', displayText: 'Meta Label' },
      };
      const { container } = render(<MentionToken mention={idMention} metadata={metadata} />);
      const token = container.querySelector('[aria-label]');
      expect(token?.getAttribute('aria-label')).toBe('file reference: Meta Label');
    });
  });

  describe('Click interaction', () => {
    it('calls onClick when the token is clicked', () => {
      const onClick = vi.fn();
      const { container } = render(<MentionToken mention={idMention} onClick={onClick} />);
      const token = container.querySelector('[aria-label]');
      fireEvent.click(token!);
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('does not throw when clicked without onClick handler', () => {
      const { container } = render(<MentionToken mention={idMention} />);
      const token = container.querySelector('[aria-label]');
      expect(() => fireEvent.click(token!)).not.toThrow();
    });

    it('applies cursor-pointer class when onClick is provided', () => {
      const { container } = render(<MentionToken mention={idMention} onClick={vi.fn()} />);
      const token = container.querySelector('[aria-label]');
      expect(token?.className).toContain('cursor-pointer');
    });

    it('applies cursor-default class when onClick is not provided', () => {
      const { container } = render(<MentionToken mention={idMention} />);
      const token = container.querySelector('[aria-label]');
      expect(token?.className).toContain('cursor-default');
    });
  });

  describe('Keyboard accessibility', () => {
    it('calls onClick when Enter key is pressed', () => {
      const onClick = vi.fn();
      const { container } = render(<MentionToken mention={idMention} onClick={onClick} />);
      const token = container.querySelector('[aria-label]');
      fireEvent.keyDown(token!, { key: 'Enter' });
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('calls onClick when Space key is pressed', () => {
      const onClick = vi.fn();
      const { container } = render(<MentionToken mention={idMention} onClick={onClick} />);
      const token = container.querySelector('[aria-label]');
      fireEvent.keyDown(token!, { key: ' ' });
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('does not call onClick when other keys are pressed', () => {
      const onClick = vi.fn();
      const { container } = render(<MentionToken mention={idMention} onClick={onClick} />);
      const token = container.querySelector('[aria-label]');
      fireEvent.keyDown(token!, { key: 'Tab' });
      fireEvent.keyDown(token!, { key: 'a' });
      expect(onClick).not.toHaveBeenCalled();
    });

    it('does not throw on Enter key press when onClick is absent', () => {
      const { container } = render(<MentionToken mention={idMention} />);
      const token = container.querySelector('[aria-label]');
      expect(() => fireEvent.keyDown(token!, { key: 'Enter' })).not.toThrow();
    });
  });

  describe('Tooltip', () => {
    it('shows tooltip on mouse enter', () => {
      const { container } = render(<MentionToken mention={idMention} />);
      const token = container.querySelector('[aria-label]');
      fireEvent.mouseEnter(token!);
      const tooltip = container.querySelector('[role="tooltip"]');
      expect(tooltip).toBeTruthy();
    });

    it('hides tooltip on mouse leave', () => {
      const { container } = render(<MentionToken mention={idMention} />);
      const token = container.querySelector('[aria-label]');
      fireEvent.mouseEnter(token!);
      fireEvent.mouseLeave(token!);
      const tooltip = container.querySelector('[role="tooltip"]');
      expect(tooltip).toBeNull();
    });

    it('shows tooltip on focus', () => {
      const { container } = render(<MentionToken mention={idMention} />);
      const token = container.querySelector('[aria-label]');
      fireEvent.focus(token!);
      const tooltip = container.querySelector('[role="tooltip"]');
      expect(tooltip).toBeTruthy();
    });

    it('hides tooltip on blur', () => {
      const { container } = render(<MentionToken mention={idMention} />);
      const token = container.querySelector('[aria-label]');
      fireEvent.focus(token!);
      fireEvent.blur(token!);
      const tooltip = container.querySelector('[role="tooltip"]');
      expect(tooltip).toBeNull();
    });

    it('tooltip shows displayText', () => {
      const { container } = render(<MentionToken mention={idMention} />);
      const token = container.querySelector('[aria-label]');
      fireEvent.mouseEnter(token!);
      const tooltip = container.querySelector('[role="tooltip"]');
      expect(tooltip?.textContent).toContain('Fix login bug');
    });

    it('tooltip shows type and id', () => {
      const { container } = render(<MentionToken mention={idMention} />);
      const token = container.querySelector('[aria-label]');
      fireEvent.mouseEnter(token!);
      const tooltip = container.querySelector('[role="tooltip"]');
      expect(tooltip?.textContent).toContain('file');
      expect(tooltip?.textContent).toContain('t-42');
    });

    it('tooltip shows status when present in metadata', () => {
      const metadata: ReferenceMetadata = {
        '@ref{file:t-42}': {
          type: 'file',
          id: 't-42',
          displayText: 'Fix login bug',
          status: 'in-progress',
        },
      };
      const { container } = render(<MentionToken mention={idMention} metadata={metadata} />);
      const token = container.querySelector('[aria-label]');
      fireEvent.mouseEnter(token!);
      const tooltip = container.querySelector('[role="tooltip"]');
      expect(tooltip?.textContent).toContain('in-progress');
    });

    it('tooltip does not show status when absent', () => {
      const { container } = render(<MentionToken mention={idMention} />);
      const token = container.querySelector('[aria-label]');
      fireEvent.mouseEnter(token!);
      const tooltip = container.querySelector('[role="tooltip"]');
      const innerContainer = tooltip?.querySelector('span');
      const childSpans = innerContainer?.querySelectorAll(':scope > span');
      expect(childSpans?.length).toBe(2);
    });

    it('tooltip is not rendered initially', () => {
      const { container } = render(<MentionToken mention={idMention} />);
      const tooltip = container.querySelector('[role="tooltip"]');
      expect(tooltip).toBeNull();
    });
  });

  describe('Metadata fallback', () => {
    it('falls back to mention.displayText when metadata key does not match', () => {
      const metadata: ReferenceMetadata = {
        '@ref{file:t-99}': { type: 'file', id: 't-99', displayText: 'Other Task' },
      };
      const { container } = render(<MentionToken mention={idMention} metadata={metadata} />);
      expect(container.textContent).toContain('Fix login bug');
    });

    it('falls back to mention.id when both metadata and displayText are unavailable', () => {
      const mention: ReferenceMention = { type: 'file', id: 'src/foo.ts', displayText: '' };
      const { container } = render(<MentionToken mention={mention} />);
      expect(container.textContent).toContain('src/foo.ts');
    });

    it('renders without metadata prop', () => {
      expect(() => render(<MentionToken mention={idMention} />)).not.toThrow();
    });
  });
});
