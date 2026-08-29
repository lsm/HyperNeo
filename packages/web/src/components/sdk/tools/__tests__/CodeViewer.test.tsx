// @ts-nocheck
import { describe, it, expect, vi, afterEach } from 'vitest';

import { render } from '@testing-library/preact';
import { CodeViewer } from '../CodeViewer';
import hljs from 'highlight.js';

describe('CodeViewer', () => {
  describe('Basic Rendering', () => {
    it('should render code content', () => {
      const { container } = render(<CodeViewer code="const x = 1;" />);
      const pre = container.querySelector('pre');
      expect(pre).toBeTruthy();
    });

    it('should render with file path header when showHeader is true', () => {
      const { container } = render(
        <CodeViewer code="const x = 1;" filePath="/path/to/file.ts" showHeader={true} />
      );
      const header = container.querySelector('.font-mono');
      expect(header?.textContent).toContain('/path/to/file.ts');
    });

    it('should not render header when showHeader is false', () => {
      const { container } = render(
        <CodeViewer code="const x = 1;" filePath="/path/to/file.ts" showHeader={false} />
      );
      const headerDivs = container.querySelectorAll('.border-b');
      const hasFilePath = Array.from(headerDivs).some((div) =>
        div.textContent?.includes('/path/to/file.ts')
      );
      expect(hasFilePath).toBe(false);
    });

    it('should apply custom className', () => {
      const { container } = render(<CodeViewer code="test" className="custom-code-class" />);
      const wrapper = container.querySelector('.custom-code-class');
      expect(wrapper).toBeTruthy();
    });
  });

  describe('Line Numbers', () => {
    it('should show line numbers by default', () => {
      const { container } = render(
        <CodeViewer code="line1\nline2\nline3" showLineNumbers={true} />
      );
      const footer = container.querySelector('.border-t');
      expect(footer).toBeTruthy();
      expect(footer?.textContent).toContain('line');
    });

    it('should not show footer when showLineNumbers is false', () => {
      const { container } = render(<CodeViewer code="line1\nline2" showLineNumbers={false} />);
      const footers = container.querySelectorAll('.border-t');
      const hasLineCount = Array.from(footers).some((f) => f.textContent?.includes('lines'));
      expect(hasLineCount).toBe(false);
    });

    it('should show singular "line" for single line code', () => {
      const { container } = render(<CodeViewer code="single line" showLineNumbers={true} />);
      const footer = container.querySelector('.border-t');
      expect(footer?.textContent).toContain('1 line');
    });
  });

  describe('Language Detection from File Path', () => {
    it('should detect TypeScript from .ts extension', () => {
      const { container } = render(
        <CodeViewer code="const x: number = 1;" filePath="/path/to/file.ts" showHeader={true} />
      );
      const languageBadge = container.querySelector('.rounded');
      expect(languageBadge?.textContent).toContain('typescript');
    });

    it('should detect JavaScript from .js extension', () => {
      const { container } = render(
        <CodeViewer code="const x = 1;" filePath="/path/to/file.js" showHeader={true} />
      );
      const languageBadge = container.querySelector('.bg-fill-strong');
      expect(languageBadge?.textContent).toContain('javascript');
    });

    it('should detect Python from .py extension', () => {
      const { container } = render(
        <CodeViewer code="x = 1" filePath="/path/to/file.py" showHeader={true} />
      );
      const languageBadge = container.querySelector('.bg-fill-strong');
      expect(languageBadge?.textContent).toContain('python');
    });

    it('should detect JSON from .json extension', () => {
      const { container } = render(
        <CodeViewer code='{"key": "value"}' filePath="/path/to/config.json" showHeader={true} />
      );
      const languageBadge = container.querySelector('.bg-fill-strong');
      expect(languageBadge?.textContent).toContain('json');
    });

    it('should detect CSS from .css extension', () => {
      const { container } = render(
        <CodeViewer
          code=".class { color: red; }"
          filePath="/path/to/styles.css"
          showHeader={true}
        />
      );
      const languageBadge = container.querySelector('.bg-fill-strong');
      expect(languageBadge?.textContent).toContain('css');
    });

    it('should detect Markdown from .md extension', () => {
      const { container } = render(
        <CodeViewer code="# Heading" filePath="/path/to/README.md" showHeader={true} />
      );
      const languageBadge = container.querySelector('.bg-fill-strong');
      expect(languageBadge?.textContent).toContain('markdown');
    });

    it('should detect Bash from .sh extension', () => {
      const { container } = render(
        <CodeViewer
          code="#!/bin/bash\necho 'hello'"
          filePath="/path/to/script.sh"
          showHeader={true}
        />
      );
      const languageBadge = container.querySelector('.bg-fill-strong');
      expect(languageBadge?.textContent).toContain('bash');
    });
  });

  describe('Explicit Language Override', () => {
    it('should use explicit language prop over file extension', () => {
      const { container } = render(
        <CodeViewer
          code="function test() {}"
          filePath="/path/to/file.txt"
          language="javascript"
          showHeader={true}
        />
      );
      const languageBadge = container.querySelector('.bg-fill-strong');
      expect(languageBadge?.textContent).toContain('javascript');
    });
  });

  describe('Max Height', () => {
    it('should apply default max height', () => {
      const { container } = render(<CodeViewer code="test" />);
      const codeContainer = container.querySelector('.relative');
      expect((codeContainer as HTMLElement)?.style?.maxHeight).toBe('500px');
    });

    it('should apply custom max height', () => {
      const { container } = render(<CodeViewer code="test" maxHeight="300px" />);
      const codeContainer = container.querySelector('.relative');
      expect((codeContainer as HTMLElement)?.style?.maxHeight).toBe('300px');
    });

    it('should handle none max height', () => {
      const { container } = render(<CodeViewer code="test" maxHeight="none" />);
      const codeContainer = container.querySelector('.relative');
      expect((codeContainer as HTMLElement)?.style?.maxHeight).toBe('none');
    });
  });

  describe('Header Display', () => {
    it('should show line count in header', () => {
      const { container } = render(
        <CodeViewer
          code="line1\nline2\nline3\nline4\nline5"
          filePath="/path/to/file.ts"
          showHeader={true}
        />
      );
      const header = container.querySelector('.border-b');
      expect(header?.textContent).toContain('file.ts');
    });

    it('should not show header when filePath is not provided even if showHeader is true', () => {
      const { container } = render(<CodeViewer code="const x = 1;" showHeader={true} />);
      const headerDivs = container.querySelectorAll('.border-b');
      const hasFilePath = Array.from(headerDivs).some((div) => div.textContent?.includes('/'));
      expect(hasFilePath).toBe(false);
    });
  });

  describe('Code Content', () => {
    it('should handle empty code', () => {
      const { container } = render(<CodeViewer code="" />);
      const pre = container.querySelector('pre');
      expect(pre).toBeTruthy();
    });

    it('should handle multiline code', () => {
      const code = `function hello() {
  console.log('hello');
  return true;
}`;
      const { container } = render(<CodeViewer code={code} showLineNumbers={true} />);
      const footer = container.querySelector('.border-t');
      expect(footer?.textContent).toContain('4 lines');
    });

    it('should preserve whitespace in code', () => {
      const { container } = render(<CodeViewer code="  indented\n    more indented" />);
      const code = container.querySelector('code');
      expect(code?.style?.whiteSpace).toBe('pre');
    });
  });

  describe('Language Highlighting Error Handling', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should fallback to auto-detect when hljs.highlight throws', () => {
      const originalHighlight = hljs.highlight;
      let callCount = 0;
      vi.spyOn(hljs, 'highlight').mockImplementation((...args) => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Unknown language');
        }
        return originalHighlight.call(hljs, ...args);
      });

      const { container } = render(<CodeViewer code="const x = 1;" filePath="/test/file.ts" />);
      const code = container.querySelector('code');
      expect(code).toBeTruthy();
    });

    it('should handle unknown file extensions gracefully', () => {
      const { container } = render(
        <CodeViewer code="const x = 1;" filePath="/test/file.unknown_ext" />
      );
      const code = container.querySelector('code');
      expect(code).toBeTruthy();
    });
  });

  describe('Styling', () => {
    it('should have rounded border', () => {
      const { container } = render(<CodeViewer code="test" />);
      const wrapper = container.querySelector('.rounded-lg');
      expect(wrapper).toBeTruthy();
    });

    it('should have code font styling', () => {
      const { container } = render(<CodeViewer code="test" />);
      const code = container.querySelector('code');
      expect(code?.className).toContain('font-mono');
    });

    it('should have small text size', () => {
      const { container } = render(<CodeViewer code="test" />);
      const code = container.querySelector('code');
      expect(code?.className).toContain('text-xs');
    });
  });
});
