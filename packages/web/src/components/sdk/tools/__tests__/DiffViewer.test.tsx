// @ts-nocheck
import { describe, it, expect } from 'vitest';

import { render } from '@testing-library/preact';
import { DiffViewer } from '../DiffViewer';

describe('DiffViewer', () => {
  describe('Basic Rendering', () => {
    it('should render diff for simple text change', () => {
      const { container } = render(
        <DiffViewer oldText="hello world" newText="hello there world" />
      );
      const table = container.querySelector('table');
      expect(table).toBeTruthy();
    });

    it('should render with file path header', () => {
      const { container } = render(
        <DiffViewer oldText="const a = 1;" newText="const a = 2;" filePath="/path/to/file.ts" />
      );
      const header = container.querySelector('.font-mono');
      expect(header?.textContent).toContain('/path/to/file.ts');
    });

    it('should not render header when filePath is not provided', () => {
      const { container } = render(<DiffViewer oldText="line1" newText="line2" />);
      const fontMono = container.querySelector('.font-mono');
      const hasFilePath = fontMono?.textContent?.includes('/');
      expect(hasFilePath).toBeFalsy();
    });

    it('should apply custom className', () => {
      const { container } = render(
        <DiffViewer oldText="old" newText="new" className="custom-diff-class" />
      );
      const wrapper = container.querySelector('.custom-diff-class');
      expect(wrapper).toBeTruthy();
    });
  });

  describe('Diff Statistics', () => {
    it('should show correct addition count', () => {
      const { container } = render(<DiffViewer oldText="line1" newText="line1\nline2\nline3" />);
      const stats = container.querySelector('.text-green-700');
      expect(stats?.textContent).toContain('+');
    });

    it('should show correct deletion count', () => {
      const { container } = render(<DiffViewer oldText="line1\nline2\nline3" newText="line1" />);
      const stats = container.querySelector('.text-red-700');
      expect(stats?.textContent).toContain('-');
    });

    it('should show both additions and deletions for replacements', () => {
      const { container } = render(<DiffViewer oldText="old line" newText="new line" />);
      const greenSpan = container.querySelector('.text-green-700');
      const redSpan = container.querySelector('.text-red-700');
      expect(greenSpan).toBeTruthy();
      expect(redSpan).toBeTruthy();
    });
  });

  describe('Line Display', () => {
    it('should display line numbers', () => {
      const { container } = render(<DiffViewer oldText="line1\nline2" newText="line1\nmodified" />);
      const cells = container.querySelectorAll('td');
      const lineNumberCells = Array.from(cells).filter(
        (cell) =>
          cell.className.includes('text-right') && /^\d+$/.test(cell.textContent?.trim() || '')
      );
      expect(lineNumberCells.length).toBeGreaterThan(0);
    });

    it('should show + sign for added lines', () => {
      const { container } = render(<DiffViewer oldText="line1" newText="line1\nadded" />);
      const cells = container.querySelectorAll('td');
      const plusCell = Array.from(cells).find((cell) => cell.textContent === '+');
      expect(plusCell).toBeTruthy();
    });

    it('should show - sign for removed lines', () => {
      const { container } = render(<DiffViewer oldText="line1\nremoved" newText="line1" />);
      const cells = container.querySelectorAll('td');
      const minusCell = Array.from(cells).find((cell) => cell.textContent === '-');
      expect(minusCell).toBeTruthy();
    });

    it('should show context lines around changes', () => {
      const { container } = render(
        <DiffViewer
          oldText="ctx1\nctx2\nctx3\nchanged\nctx4\nctx5\nctx6"
          newText="ctx1\nctx2\nctx3\nmodified\nctx4\nctx5\nctx6"
        />
      );
      const rows = container.querySelectorAll('tr');
      expect(rows.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Diff Algorithm', () => {
    it('should handle identical texts', () => {
      const { container } = render(<DiffViewer oldText="same content" newText="same content" />);
      const footer = container.querySelector('.border-t');
      expect(footer?.textContent).toContain('0 additions');
      expect(footer?.textContent).toContain('0 deletions');
    });

    it('should handle empty old text', () => {
      const { container } = render(<DiffViewer oldText="" newText="new content" />);
      const table = container.querySelector('table');
      expect(table).toBeTruthy();
    });

    it('should handle empty new text', () => {
      const { container } = render(<DiffViewer oldText="old content" newText="" />);
      const table = container.querySelector('table');
      expect(table).toBeTruthy();
    });

    it('should handle both empty texts', () => {
      const { container } = render(<DiffViewer oldText="" newText="" />);
      const footer = container.querySelector('.border-t');
      expect(footer?.textContent).toContain('0 additions');
      expect(footer?.textContent).toContain('0 deletions');
    });

    it('should handle multiline changes', () => {
      const oldText = `function foo() {
  return 1;
}`;
      const newText = `function foo() {
  return 2;
}`;
      const { container } = render(<DiffViewer oldText={oldText} newText={newText} />);
      const table = container.querySelector('table');
      expect(table).toBeTruthy();
    });
  });

  describe('Context Lines', () => {
    it('should show context lines before changes', () => {
      const oldText = 'context1\ncontext2\ncontext3\ncontext4\nchanged\nafter';
      const newText = 'context1\ncontext2\ncontext3\ncontext4\nmodified\nafter';
      const { container } = render(<DiffViewer oldText={oldText} newText={newText} />);
      const rows = container.querySelectorAll('tr');
      expect(rows.length).toBeGreaterThan(2);
    });

    it('should show separator for skipped lines', () => {
      const oldLines = Array(10)
        .fill(0)
        .map((_, i) => `line${i}`)
        .join('\n');
      const newLines = Array(10)
        .fill(0)
        .map((_, i) => (i === 5 ? 'changed' : `line${i}`))
        .join('\n');
      const { container } = render(<DiffViewer oldText={oldLines} newText={newLines} />);
      const cells = container.querySelectorAll('td');
      const separatorCell = Array.from(cells).find((cell) => cell.textContent === '...');
      expect(separatorCell).toBeTruthy();
    });
  });

  describe('Styling', () => {
    it('should have green background for added lines', () => {
      const { container } = render(<DiffViewer oldText="line1" newText="line1\nadded" />);
      const rows = container.querySelectorAll('tr');
      const addedRow = Array.from(rows).find((row) => row.className.includes('bg-green'));
      expect(addedRow).toBeTruthy();
    });

    it('should have red background for removed lines', () => {
      const { container } = render(<DiffViewer oldText="line1\nremoved" newText="line1" />);
      const rows = container.querySelectorAll('tr');
      const removedRow = Array.from(rows).find((row) => row.className.includes('bg-red'));
      expect(removedRow).toBeTruthy();
    });

    it('should have rounded border', () => {
      const { container } = render(<DiffViewer oldText="old" newText="new" />);
      const wrapper = container.querySelector('.rounded-lg');
      expect(wrapper).toBeTruthy();
    });
  });

  describe('Footer Statistics', () => {
    it('should display additions text', () => {
      const { container } = render(<DiffViewer oldText="line1" newText="line1\nline2" />);
      const footer = container.querySelector('.border-t');
      expect(footer?.textContent).toContain('additions');
    });

    it('should display deletions text', () => {
      const { container } = render(<DiffViewer oldText="line1\nline2" newText="line1" />);
      const footer = container.querySelector('.border-t');
      expect(footer?.textContent).toContain('deletions');
    });
  });
});
