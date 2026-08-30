// @ts-nocheck

import { render, waitFor } from '@testing-library/preact';
import { beforeEach, expect, vi } from 'vitest';
import MarkdownRenderer, { renderPlainText } from '../MarkdownRenderer';

vi.mock('../../../lib/utils.ts', () => ({
  copyToClipboard: vi.fn(),
}));

import { copyToClipboard } from '../../../lib/utils.ts';

const { mermaidParseMock, mermaidRunMock } = vi.hoisted(() => ({
  mermaidParseMock: vi.fn(),
  mermaidRunMock: vi.fn(),
}));

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    parse: mermaidParseMock,
    run: mermaidRunMock,
  },
}));

describe('MarkdownRenderer', () => {
  beforeEach(() => {
    mermaidParseMock.mockReset();
    mermaidRunMock.mockReset();
    mermaidParseMock.mockResolvedValue(true);
    mermaidRunMock.mockResolvedValue(undefined);
  });
  describe('Basic Rendering', () => {
    it('should render plain text', async () => {
      const { container } = render(<MarkdownRenderer content="Hello World" />);
      await waitFor(() => {
        expect(container.textContent).toContain('Hello World');
      });
    });

    it('should render with prose class', () => {
      const { container } = render(<MarkdownRenderer content="Test" />);
      expect(container.querySelector('.prose')).toBeTruthy();
    });

    it('should merge custom className', () => {
      const { container } = render(<MarkdownRenderer content="Test" class="custom-class" />);
      const div = container.querySelector('.prose');
      expect(div?.className).toContain('prose');
      expect(div?.className).toContain('custom-class');
    });

    it('should handle empty className', () => {
      const { container } = render(<MarkdownRenderer content="Test" class="" />);
      const div = container.querySelector('.prose');
      expect(div?.className).toContain('prose');
    });
  });

  describe('Copy Button', () => {
    beforeEach(() => {
      (copyToClipboard as ReturnType<typeof vi.fn>).mockReset();
      (copyToClipboard as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    });

    it('should render a copy button for markdown content', async () => {
      const { container } = render(<MarkdownRenderer content="**bold** text" />);
      await waitFor(() => {
        expect(container.querySelector('.prose')?.textContent).toContain('bold');
      });
      const button = container.querySelector('button');
      expect(button).toBeTruthy();
      expect(button?.getAttribute('title')).toBe('Copy markdown');
    });

    it('should not render a copy button before the first render commits', () => {
      const { container } = render(<MarkdownRenderer content="**bold** text" />);
      expect(container.querySelector('.prose')?.textContent).not.toContain('bold');
      expect(container.querySelector('button')).toBeFalsy();
    });

    it('should not render a copy button for empty content', async () => {
      const { container, rerender } = render(<MarkdownRenderer content="   " />);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(container.querySelector('button')).toBeFalsy();

      rerender(<MarkdownRenderer content="streamed text" />);
      expect(container.querySelector('button')).toBeFalsy();

      await waitFor(() => {
        expect(container.querySelector('.prose')?.textContent).toContain('streamed');
      });
      expect(container.querySelector('button')).toBeTruthy();
    });

    it('should copy the raw markdown source on click', async () => {
      const { container } = render(<MarkdownRenderer content="**bold** text" />);
      await waitFor(() => {
        expect(container.querySelector('.prose')?.textContent).toContain('bold');
      });
      const button = container.querySelector('button');
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      await waitFor(() => {
        expect(copyToClipboard).toHaveBeenCalledWith('**bold** text');
      });
    });

    it('should copy the source matching the rendered html during streaming updates', async () => {
      const { container, rerender } = render(<MarkdownRenderer content="first" />);
      await waitFor(() => {
        expect(container.querySelector('.prose')?.textContent).toContain('first');
      });

      rerender(<MarkdownRenderer content="second" />);
      const button = container.querySelector('button');
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      await waitFor(() => {
        expect(copyToClipboard).toHaveBeenCalledTimes(1);
      });
      expect(copyToClipboard).toHaveBeenCalledWith('first');

      await waitFor(() => {
        expect(container.querySelector('.prose')?.textContent).toContain('second');
      });

      (copyToClipboard as ReturnType<typeof vi.fn>).mockClear();
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      await waitFor(() => {
        expect(copyToClipboard).toHaveBeenCalledWith('second');
      });
    });

    it('should not affect rendered markdown content placement', async () => {
      const { container } = render(<MarkdownRenderer content="Hello World" />);
      await waitFor(() => {
        expect(container.querySelector('.prose')?.textContent).toContain('Hello World');
      });
      expect(container.querySelector('.prose button')).toBeFalsy();
    });

    it('should show copied confirmation then revert', async () => {
      const { container } = render(<MarkdownRenderer content="**bold** text" />);
      await waitFor(() => {
        expect(container.querySelector('.prose')?.textContent).toContain('bold');
      });

      vi.useFakeTimers();

      try {
        const button = container.querySelector('button');
        button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(0);

        expect(button?.getAttribute('title')).toBe('Copied!');
        expect(button?.classList.contains('text-success')).toBe(true);

        await vi.advanceTimersByTimeAsync(2000);

        expect(button?.getAttribute('title')).toBe('Copy markdown');
        expect(button?.classList.contains('text-success')).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should reserve a right gutter for the copy button on touch devices', () => {
      const { container } = render(<MarkdownRenderer content="Test" />);
      const prose = container.querySelector('.prose');
      expect(prose?.className).toContain('[@media(hover:none)]:pr-7');
    });

    it('should stay visible when focused on hover-capable devices', async () => {
      const { container } = render(<MarkdownRenderer content="Test" />);
      await waitFor(() => {
        expect(container.querySelector('button')).toBeTruthy();
      });
      const wrapper = container.querySelector('button')?.parentElement;
      expect(wrapper?.className).toContain('[@media(hover:hover)]:focus-within:opacity-100');
    });

    it('should reset the copied confirmation when content changes', async () => {
      const { container, rerender } = render(<MarkdownRenderer content="first" />);
      await waitFor(() => {
        expect(container.querySelector('.prose')?.textContent).toContain('first');
      });

      const button = container.querySelector('button');
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      await waitFor(() => {
        expect(button?.getAttribute('title')).toBe('Copied!');
      });

      rerender(<MarkdownRenderer content="second **streamed**" />);

      await waitFor(() => {
        expect(container.querySelector('.prose')?.textContent).toContain('streamed');
        expect(button?.getAttribute('title')).toBe('Copy markdown');
      });
    });
  });

  describe('Markdown Parsing', () => {
    it('should render headers', async () => {
      const { container } = render(<MarkdownRenderer content="# Heading 1" />);
      await waitFor(() => {
        expect(container.textContent).toContain('Heading 1');
      });
    });

    it('should render bold text', async () => {
      const { container } = render(<MarkdownRenderer content="This is **bold** text" />);
      await waitFor(() => {
        expect(container.textContent).toContain('bold');
      });
    });

    it('should render italic text', async () => {
      const { container } = render(<MarkdownRenderer content="This is *italic* text" />);
      await waitFor(() => {
        expect(container.textContent).toContain('italic');
      });
    });

    it('should render links', async () => {
      const { container } = render(<MarkdownRenderer content="[Link text](https://example.com)" />);
      await waitFor(() => {
        expect(container.textContent).toContain('Link text');
      });
    });

    it('should render inline code', async () => {
      const { container } = render(<MarkdownRenderer content="Use `npm install`" />);
      await waitFor(() => {
        expect(container.textContent).toContain('npm install');
      });
    });

    it('should render unordered lists', async () => {
      const { container } = render(<MarkdownRenderer content="- Item 1\n- Item 2\n- Item 3" />);
      await waitFor(() => {
        expect(container.textContent).toContain('Item 1');
        expect(container.textContent).toContain('Item 2');
        expect(container.textContent).toContain('Item 3');
      });
    });

    it('should render ordered lists', async () => {
      const { container } = render(<MarkdownRenderer content="1. First\n2. Second\n3. Third" />);
      await waitFor(() => {
        expect(container.textContent).toContain('First');
        expect(container.textContent).toContain('Second');
        expect(container.textContent).toContain('Third');
      });
    });

    it('should render blockquotes', async () => {
      const { container } = render(<MarkdownRenderer content="> This is a quote" />);
      await waitFor(() => {
        expect(container.textContent).toContain('This is a quote');
      });
    });

    it('should render paragraphs', async () => {
      const { container } = render(<MarkdownRenderer content="Hello World" />);
      await waitFor(() => {
        expect(container.textContent).toContain('Hello World');
      });
    });
  });

  describe('Code Blocks', () => {
    it('should render code blocks', async () => {
      const { container } = render(<MarkdownRenderer content={'```\nconst x = 1;\n```'} />);
      await waitFor(() => {
        expect(container.textContent).toContain('const x = 1');
      });
    });

    it('should render code blocks with language', async () => {
      const { container } = render(
        <MarkdownRenderer content={'```javascript\nconst x = 1;\n```'} />
      );
      await waitFor(() => {
        expect(container.textContent).toContain('const x = 1');
      });
    });

    it('should highlight code blocks', async () => {
      const { container } = render(
        <MarkdownRenderer content={'```javascript\nconst x = 1;\n```'} />
      );
      await waitFor(() => {
        const keyword = container.querySelector('.hljs-keyword');
        expect(keyword?.textContent).toBe('const');
      });
    });

    it('should highlight tilde code fences', async () => {
      const { container } = render(<MarkdownRenderer content={'~~~ts\nconst x = 1;\n~~~'} />);
      await waitFor(() => {
        const keyword = container.querySelector('.hljs-keyword');
        expect(keyword?.textContent).toBe('const');
      });
    });

    it('should highlight indented code fences', async () => {
      const { container } = render(<MarkdownRenderer content={'  ```ts\nconst x = 1;\n  ```'} />);
      await waitFor(() => {
        const keyword = container.querySelector('.hljs-keyword');
        expect(keyword?.textContent).toBe('const');
      });
    });

    it('should auto-detect unlabeled code fences', async () => {
      const { container } = render(<MarkdownRenderer content={'```\nconst x = 1;\n```'} />);
      await waitFor(() => {
        const code = container.querySelector('pre code.hljs');
        expect(code?.textContent).toContain('const x = 1');
        expect(code?.querySelector('.hljs-attr, .hljs-keyword')).toBeTruthy();
      });
    });

    it('should highlight indented code blocks', async () => {
      const { container } = render(<MarkdownRenderer content={'    const x = 1;'} />);
      await waitFor(() => {
        const code = container.querySelector('pre code.hljs');
        expect(code?.textContent).toBe('const x = 1;\n');
        expect(code?.querySelector('.hljs-attr, .hljs-keyword')).toBeTruthy();
      });
    });

    it('should not treat indented code as list fence', async () => {
      const { container } = render(
        <MarkdownRenderer
          content={'    - ```html\n    <div>inside</div>\n    ```\n<div>outside</div>'}
        />
      );
      await waitFor(() => {
        const indentedCode = container.querySelector('pre code.hljs');
        expect(indentedCode?.textContent).toContain('- ```html');
        expect(indentedCode?.textContent).toContain('<div>inside</div>');
        const fencedCodes = container.querySelectorAll('pre code.language-html');
        expect(fencedCodes).toHaveLength(1);
        expect(fencedCodes[0]?.textContent).toBe('<div>outside</div>\n');
      });
    });

    it('should render unregistered languages without blanking content', async () => {
      const { container } = render(<MarkdownRenderer content={'```custom-tag\nvalue\n```'} />);
      await waitFor(() => {
        const code = container.querySelector('pre code.language-custom-tag');
        expect(code?.textContent).toContain('value');
      });
    });

    it('should preserve markdown around unknown language fences', async () => {
      const { container } = render(
        <MarkdownRenderer content={'**before**\n\n```foo\nvalue\n```\n\n_after_'} />
      );
      await waitFor(() => {
        expect(container.querySelector('strong')?.textContent).toBe('before');
        expect(container.querySelector('em')?.textContent).toBe('after');
        expect(container.querySelector('pre code.language-foo')?.textContent).toBe('value\n');
      });
    });

    it('should highlight tsx fences', async () => {
      const { container } = render(
        <MarkdownRenderer content={'```tsx\nconst el = <Component />;\n```'} />
      );
      await waitFor(() => {
        const code = container.querySelector('pre code.language-tsx');
        expect(code?.textContent).toContain('<Component />');
        expect(code?.querySelector('.hljs-keyword')?.textContent).toBe('const');
      });
    });

    it('should highlight code fences nested in list items', async () => {
      const { container } = render(
        <MarkdownRenderer content={'- Example:\n    ```ts\n    const x = 1;\n    ```'} />
      );
      await waitFor(() => {
        const code = container.querySelector('li pre code.language-ts.hljs');
        expect(code?.textContent).toBe('const x = 1;\n');
        expect(code?.querySelector('.hljs-keyword')?.textContent).toBe('const');
      });
    });

    it('should highlight code fences opened after list markers', async () => {
      const { container } = render(<MarkdownRenderer content={'- ```ts\n  const x = 1;\n  ```'} />);
      await waitFor(() => {
        const code = container.querySelector('li pre code.language-ts.hljs');
        expect(code?.textContent).toBe('const x = 1;\n');
        expect(code?.querySelector('.hljs-keyword')?.textContent).toBe('const');
      });
    });

    it('should highlight nested list fences under wide parent markers', async () => {
      const { container } = render(
        <MarkdownRenderer content={'100. outer\n     - ```ts\n       const x = 1;\n       ```'} />
      );
      await waitFor(() => {
        const code = container.querySelector('li pre code.language-ts.hljs');
        expect(code?.textContent).toBe('const x = 1;\n');
        expect(code?.querySelector('.hljs-keyword')?.textContent).toBe('const');
      });
    });

    it('should highlight tab-indented list fence closers', async () => {
      const { container } = render(
        <MarkdownRenderer content={'-\t```ts\n\tconst x = 1;\n\t```'} />
      );
      await waitFor(() => {
        const code = container.querySelector('li pre code.language-ts.hljs');
        expect(code?.textContent).toBe('const x = 1;\n');
        expect(code?.querySelector('.hljs-keyword')?.textContent).toBe('const');
      });
    });

    it('should highlight blockquoted code fences', async () => {
      const { container } = render(<MarkdownRenderer content={'> ```ts\n> const x = 1;\n> ```'} />);
      await waitFor(() => {
        const code = container.querySelector('blockquote pre code.language-ts.hljs');
        expect(code?.textContent).toBe('const x = 1;\n');
        expect(code?.querySelector('.hljs-keyword')?.textContent).toBe('const');
      });
    });

    it('should highlight nested blockquoted code fences', async () => {
      const { container } = render(
        <MarkdownRenderer content={'> > ```ts\n> > const x = 1;\n> > ```'} />
      );
      await waitFor(() => {
        const code = container.querySelector('blockquote blockquote pre code.language-ts.hljs');
        expect(code?.textContent).toBe('const x = 1;\n');
        expect(code?.querySelector('.hljs-keyword')?.textContent).toBe('const');
      });
    });

    it('should highlight code fences opened after blockquoted list markers', async () => {
      const { container } = render(
        <MarkdownRenderer content={'> - ```ts\n>   const x = 1;\n>   ```'} />
      );
      await waitFor(() => {
        const code = container.querySelector('blockquote li pre code.language-ts.hljs');
        expect(code?.textContent).toBe('const x = 1;\n');
        expect(code?.querySelector('.hljs-keyword')?.textContent).toBe('const');
      });
    });

    it('should highlight blockquoted indented code blocks', async () => {
      const { container } = render(<MarkdownRenderer content={'>     const x = 1;'} />);
      await waitFor(() => {
        const code = container.querySelector('blockquote pre code.hljs');
        expect(code?.textContent).toBe('const x = 1;\n');
        expect(code?.querySelector('.hljs-attr, .hljs-keyword')).toBeTruthy();
      });
    });

    it('should not rewrite raw HTML inside blockquoted indented code blocks', async () => {
      const { container } = render(<MarkdownRenderer content={'>     <div />'} />);
      await waitFor(() => {
        const code = container.querySelector('blockquote pre code');
        expect(code?.textContent).toBe('<div />\n');
        expect(code?.querySelector('code')).toBeFalsy();
        expect(container.querySelector('.prose div')).toBeFalsy();
      });
    });

    it('should preserve fenced code in nested blockquotes', async () => {
      const { container } = render(
        <MarkdownRenderer content={'> > ```html\n> > <div>hi</div>\n> > ```'} />
      );
      await waitFor(() => {
        const codes = container.querySelectorAll('blockquote blockquote pre code.language-html');
        expect(codes).toHaveLength(1);
        expect(codes[0]?.textContent).toBe('<div>hi</div>\n');
        expect(codes[0]?.textContent).not.toContain('```');
      });
    });
  });

  describe('LaTeX Support', () => {
    it('should not parse single dollar currency as math', async () => {
      const { container } = render(<MarkdownRenderer content="costs $5 now and $10 later" />);
      await waitFor(() => {
        expect(container.textContent).toContain('costs $5 now and $10 later');
        expect(container.querySelector('.katex')).toBeFalsy();
      });
    });

    it('should render inline double-dollar math with KaTeX', async () => {
      const { container } = render(<MarkdownRenderer content={'Euler is $$e^{i\\pi}+1=0$$'} />);
      await waitFor(() => {
        const math = container.querySelector('.katex');
        expect(math?.textContent).toContain('e');
      });
    });

    it('should render block math with KaTeX', async () => {
      const { container } = render(<MarkdownRenderer content={'$$\n\\frac{1}{2}\n$$'} />);
      await waitFor(() => {
        const math = container.querySelector('.katex-display');
        expect(math?.textContent).toContain('1');
        expect(math?.textContent).toContain('2');
      });
    });

    it('should preserve markdown when math rendering fails', async () => {
      const { container } = render(
        <MarkdownRenderer content={'**Readable** $$\\notacommand$$ _text_'} />
      );
      await waitFor(() => {
        expect(container.querySelector('strong')?.textContent).toBe('Readable');
        expect(container.querySelector('em')?.textContent).toBe('text');
        expect(container.textContent).toContain('\\notacommand');
      });
    });
  });

  describe('Mermaid Support', () => {
    it('should hand valid mermaid code blocks to Mermaid renderer', async () => {
      const { container } = render(
        <MarkdownRenderer content={'```mermaid\ngraph TD\n  A-->B\n```'} />
      );
      await waitFor(() => {
        const mermaid = container.querySelector('.mermaid');
        expect(mermaid).toBeTruthy();
        expect(mermaid?.textContent).toContain('A');
        expect(mermaidRunMock).toHaveBeenCalled();
      });
    });

    it('should preserve mermaid code blocks when parsing fails', async () => {
      mermaidParseMock.mockRejectedValueOnce(new Error('invalid mermaid'));
      const { container } = render(
        <MarkdownRenderer content={'```mermaid\ngraph TD;\n  A--\n```'} />
      );
      await waitFor(() => {
        const code = container.querySelector('pre code.language-mermaid');
        expect(code?.textContent).toContain('A--');
        expect(mermaidRunMock).not.toHaveBeenCalled();
      });
    });

    it('should restore mermaid code blocks when rendering fails', async () => {
      mermaidRunMock.mockRejectedValueOnce(new Error('render failed'));
      const { container } = render(
        <MarkdownRenderer content={'```mermaid\ngraph TD\n  A-->B\n```'} />
      );
      await waitFor(() => {
        const code = container.querySelector('pre code.language-mermaid');
        expect(code?.textContent).toContain('A-->B');
        expect(container.querySelector('.mermaid')).toBeFalsy();
      });
    });
  });

  describe('Tables', () => {
    it('should render tables', async () => {
      const tableContent = `| Header 1 | Header 2 |
|----------|----------|
| Cell 1   | Cell 2   |`;

      const { container } = render(<MarkdownRenderer content={tableContent} />);
      await waitFor(() => {
        expect(container.textContent).toContain('Header 1');
        expect(container.textContent).toContain('Cell 1');
      });
    });

    it('should wrap tables for scrolling', async () => {
      const tableContent = `| Header 1 | Header 2 |
|----------|----------|
| Cell 1   | Cell 2   |`;

      const { container } = render(<MarkdownRenderer content={tableContent} />);
      await waitFor(() => {
        expect(container.querySelector('.prose-table-wrapper table')).toBeTruthy();
      });
    });
  });

  describe('Paragraph Margins', () => {
    it('should remove top margin from first paragraph', async () => {
      const { container } = render(<MarkdownRenderer content="Hello World" />);
      await waitFor(() => {
        const paragraphs = container.querySelectorAll('p');
        expect(paragraphs.length).toBeGreaterThan(0);
        const firstP = paragraphs[0] as HTMLElement;
        expect(firstP.style.marginTop).toMatch(/^0(px)?$/);
      });
    });

    it('should remove bottom margin from last paragraph', async () => {
      const { container } = render(<MarkdownRenderer content="Hello World" />);
      await waitFor(() => {
        const paragraphs = container.querySelectorAll('p');
        expect(paragraphs.length).toBeGreaterThan(0);
        const lastP = paragraphs[paragraphs.length - 1] as HTMLElement;
        expect(lastP.style.marginBottom).toMatch(/^0(px)?$/);
      });
    });
  });

  describe('GFM Support', () => {
    it('should support line breaks', async () => {
      const { container } = render(<MarkdownRenderer content="Line 1\nLine 2" />);
      await waitFor(() => {
        const content = container.innerHTML;
        expect(content).toContain('Line 1');
        expect(content).toContain('Line 2');
      });
    });

    it('should support strikethrough', async () => {
      const { container } = render(<MarkdownRenderer content="~~deleted~~" />);
      await waitFor(() => {
        expect(container.textContent).toContain('deleted');
      });
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty content', () => {
      const { container } = render(<MarkdownRenderer content="" />);
      const div = container.querySelector('.prose');
      expect(div).toBeTruthy();
    });

    it('should handle very long content', async () => {
      const longContent = 'x'.repeat(10000);
      const { container } = render(<MarkdownRenderer content={longContent} />);
      await waitFor(() => {
        expect(container.textContent?.length).toBeGreaterThan(1000);
      });
    });

    it('should handle special characters', async () => {
      const { container } = render(<MarkdownRenderer content={'Special: <>&"\''} />);
      await waitFor(() => {
        expect(container.textContent).toContain('Special');
      });
    });

    it('should preserve raw HTML examples safely', async () => {
      const { container } = render(<MarkdownRenderer content={'Example:\n\n<div>hello</div>'} />);
      await waitFor(() => {
        const code = container.querySelector('pre code.language-html');
        expect(code?.textContent).toContain('<div>hello</div>');
        expect(code?.querySelector('.hljs-tag')).toBeTruthy();
        expect(container.querySelector('.prose > div')).toBeFalsy();
      });
    });

    it('should preserve nested same-line raw HTML examples safely', async () => {
      const { container } = render(
        <MarkdownRenderer content={'Example:\n\n<div><span>hello</span></div>'} />
      );
      await waitFor(() => {
        const code = container.querySelector('pre code.language-html');
        expect(code?.textContent).toContain('<div><span>hello</span></div>');
        expect(container.querySelector('.prose > div')).toBeFalsy();
      });
    });

    it('should not rewrite raw HTML examples inside fenced code', async () => {
      const { container } = render(<MarkdownRenderer content={'```html\n<div>hello</div>\n```'} />);
      await waitFor(() => {
        const codes = container.querySelectorAll('pre code.language-html');
        expect(codes).toHaveLength(1);
        expect(codes[0]?.textContent).toBe('<div>hello</div>\n');
      });
    });

    it('should allow closing fence indentation before escaping later raw HTML examples', async () => {
      const { container } = render(
        <MarkdownRenderer content={'```html\n<div>inside</div>\n  ```\n<div>outside</div>'} />
      );
      await waitFor(() => {
        const codes = container.querySelectorAll('pre code.language-html');
        expect(codes).toHaveLength(2);
        expect(codes[0]?.textContent).toBe('<div>inside</div>\n');
        expect(codes[1]?.textContent).toBe('<div>outside</div>\n');
      });
    });

    it('should preserve list-nested closing fence indentation before escaping later raw HTML', async () => {
      const { container } = render(
        <MarkdownRenderer
          content={'- Example:\n    ```html\n    <div>inside</div>\n    ```\n<div>outside</div>'}
        />
      );
      await waitFor(() => {
        const nestedCode = container.querySelector('li pre code.language-html');
        const codes = container.querySelectorAll('pre code.language-html');
        expect(codes).toHaveLength(2);
        expect(nestedCode?.textContent).toBe('<div>inside</div>\n');
        expect(codes[1]?.textContent).toBe('<div>outside</div>\n');
      });
    });

    it('should preserve blockquoted list fence closures before escaping later raw HTML', async () => {
      const { container } = render(
        <MarkdownRenderer
          content={'> - ```html\n>   <div>inside</div>\n>   ```\n<div>outside</div>'}
        />
      );
      await waitFor(() => {
        const nestedCode = container.querySelector('blockquote li pre code.language-html');
        const codes = container.querySelectorAll('pre code.language-html');
        expect(codes).toHaveLength(2);
        expect(nestedCode?.textContent).toBe('<div>inside</div>\n');
        expect(codes[1]?.textContent).toBe('<div>outside</div>\n');
      });
    });

    it('should preserve multi-line raw HTML examples safely', async () => {
      const { container } = render(
        <MarkdownRenderer content={'Example:\n\n<div>\n  hello\n</div>'} />
      );
      await waitFor(() => {
        const code = container.querySelector('pre code.language-html');
        expect(code?.textContent).toBe('<div>\n  hello\n</div>\n');
        expect(container.querySelector('.prose > div')).toBeFalsy();
      });
    });

    it('should preserve raw HTML declarations safely', async () => {
      const { container } = render(
        <MarkdownRenderer content={'Example:\n\n<!DOCTYPE html>\n<html>\n</html>'} />
      );
      await waitFor(() => {
        const codes = container.querySelectorAll('pre code.language-html');
        expect(codes).toHaveLength(2);
        expect(codes[0]?.textContent).toBe('<!DOCTYPE html>\n');
        expect(codes[1]?.textContent).toBe('<html>\n</html>\n');
      });
    });

    it('should preserve standalone raw HTML comments safely', async () => {
      const { container } = render(
        <MarkdownRenderer content={'Example:\n\n<!-- note -->\n<div>hi</div>'} />
      );
      await waitFor(() => {
        const codes = container.querySelectorAll('pre code.language-html');
        expect(codes).toHaveLength(2);
        expect(codes[0]?.textContent).toContain('<!-- note');
        expect(codes[1]?.textContent).toBe('<div>hi</div>\n');
      });
    });

    it('should preserve multiline raw HTML comments safely', async () => {
      const { container } = render(
        <MarkdownRenderer content={'Example:\n\n<!--\nnote\n-->\n<div>hi</div>'} />
      );
      await waitFor(() => {
        const codes = container.querySelectorAll('pre code.language-html');
        expect(codes).toHaveLength(2);
        expect(codes[0]?.textContent).toContain('<!--\nnote');
        expect(codes[0]?.textContent).toContain('-->\n');
        expect(codes[1]?.textContent).toBe('<div>hi</div>\n');
      });
    });

    it('should preserve multiline raw HTML comments inside lists', async () => {
      const { container } = render(<MarkdownRenderer content={'- <!--\n  note\n  -->'} />);
      await waitFor(() => {
        const codes = container.querySelectorAll('li pre code.language-html');
        expect(codes).toHaveLength(1);
        expect(codes[0]?.textContent).toContain('<!--\nnote');
        expect(codes[0]?.textContent).toContain('-->\n');
      });
    });

    it('should preserve multi-line raw HTML with opening-line text safely', async () => {
      const { container } = render(<MarkdownRenderer content={'Example:\n\n<div>Hello\n</div>'} />);
      await waitFor(() => {
        const codes = container.querySelectorAll('pre code.language-html');
        expect(codes).toHaveLength(1);
        expect(codes[0]?.textContent).toBe('<div>Hello\n</div>\n');
        expect(container.querySelector('.prose > div')).toBeFalsy();
      });
    });

    it('should preserve split-opening raw HTML examples safely', async () => {
      const { container } = render(
        <MarkdownRenderer content={'Example:\n\n<div\n  class="card"\n>\n  hi\n</div>'} />
      );
      await waitFor(() => {
        const codes = container.querySelectorAll('pre code.language-html');
        expect(codes).toHaveLength(1);
        expect(codes[0]?.textContent).toBe('<div\n  class="card"\n>\n  hi\n</div>\n');
        expect(container.querySelector('.prose > div')).toBeFalsy();
      });
    });

    it('should process closes on split-tag completion lines', async () => {
      const { container } = render(<MarkdownRenderer content={'Example:\n\n<div\n></div>'} />);
      await waitFor(() => {
        const codes = container.querySelectorAll('pre code.language-html');
        expect(codes).toHaveLength(1);
        expect(codes[0]?.textContent).toBe('<div\n></div>\n');
        expect(container.querySelector('.prose > div')).toBeFalsy();
      });
    });

    it('should preserve nested same-tag raw HTML examples safely', async () => {
      const { container } = render(
        <MarkdownRenderer content={'Example:\n\n<div>\n  <div>\n    child\n  </div>\n</div>'} />
      );
      await waitFor(() => {
        const codes = container.querySelectorAll('pre code.language-html');
        expect(codes).toHaveLength(1);
        expect(codes[0]?.textContent).toBe('<div>\n  <div>\n    child\n  </div>\n</div>\n');
        expect(container.querySelector('.prose > div')).toBeFalsy();
      });
    });

    it('should preserve same-line nested raw HTML closes safely', async () => {
      const { container } = render(
        <MarkdownRenderer content={'Example:\n\n<div>\n  <div>child</div>\n</div>'} />
      );
      await waitFor(() => {
        const codes = container.querySelectorAll('pre code.language-html');
        expect(codes).toHaveLength(1);
        expect(codes[0]?.textContent).toBe('<div>\n  <div>child</div>\n</div>\n');
        expect(container.querySelector('.prose > div')).toBeFalsy();
      });
    });

    it('should preserve multiline raw HTML with nested child close on opening line', async () => {
      const { container } = render(
        <MarkdownRenderer content={'Example:\n\n<div><span>hi</span>\n</div>'} />
      );
      await waitFor(() => {
        const codes = container.querySelectorAll('pre code.language-html');
        expect(codes).toHaveLength(1);
        expect(codes[0]?.textContent).toBe('<div><span>hi</span>\n</div>\n');
        expect(container.querySelector('.prose > div')).toBeFalsy();
      });
    });

    it('should preserve multiline raw HTML with same-tag child close on opening line', async () => {
      const { container } = render(
        <MarkdownRenderer content={'Example:\n\n<div><div>child</div>\n</div>'} />
      );
      await waitFor(() => {
        const codes = container.querySelectorAll('pre code.language-html');
        expect(codes).toHaveLength(1);
        expect(codes[0]?.textContent).toBe('<div><div>child</div>\n</div>\n');
        expect(container.querySelector('.prose > div')).toBeFalsy();
      });
    });

    it('should count same-tag opens on the first raw HTML line', async () => {
      const { container } = render(
        <MarkdownRenderer content={'Example:\n\n<div><div>\nchild\n</div>\n</div>'} />
      );
      await waitFor(() => {
        const codes = container.querySelectorAll('pre code.language-html');
        expect(codes).toHaveLength(1);
        expect(codes[0]?.textContent).toBe('<div><div>\nchild\n</div>\n</div>\n');
        expect(container.querySelector('.prose > div')).toBeFalsy();
      });
    });

    it('should collect multiline raw HTML with self-closing children on opening line', async () => {
      const { container } = render(
        <MarkdownRenderer content={'Example:\n\n<div><img />\n</div>'} />
      );
      await waitFor(() => {
        const codes = container.querySelectorAll('pre code.language-html');
        expect(codes).toHaveLength(1);
        expect(codes[0]?.textContent).toBe('<div><img />\n</div>\n');
        expect(container.querySelector('.prose > div')).toBeFalsy();
      });
    });

    it('should not close outer raw HTML blocks on self-closing child tags', async () => {
      const { container } = render(
        <MarkdownRenderer content={'Example:\n\n<div>\n  <img />\n</div>'} />
      );
      await waitFor(() => {
        const codes = container.querySelectorAll('pre code.language-html');
        expect(codes).toHaveLength(1);
        expect(codes[0]?.textContent).toBe('<div>\n  <img />\n</div>\n');
        expect(container.querySelector('.prose > div')).toBeFalsy();
      });
    });

    it('should ignore closing tags inside quoted attributes when tracking raw HTML depth', async () => {
      const { container } = render(
        <MarkdownRenderer content={'Example:\n\n<div>\n  <span title="</div>"></span>\n</div>'} />
      );
      await waitFor(() => {
        const codes = container.querySelectorAll('pre code.language-html');
        expect(codes).toHaveLength(1);
        expect(codes[0]?.textContent).toBe('<div>\n  <span title="</div>"></span>\n</div>\n');
        expect(container.querySelector('.prose > div')).toBeFalsy();
      });
    });

    it('should ignore tags inside comments when tracking raw HTML depth', async () => {
      const { container } = render(
        <MarkdownRenderer content={'Example:\n\n<div>\n  <!-- <div> -->\n</div>'} />
      );
      await waitFor(() => {
        const codes = container.querySelectorAll('pre code.language-html');
        expect(codes).toHaveLength(1);
        expect(codes[0]?.textContent).toContain('<!-- <div>');
        expect(codes[0]?.textContent).toContain('</div>\n');
        expect(container.querySelector('.prose > div')).toBeFalsy();
      });
    });

    it('should ignore tags inside multiline comments when tracking raw HTML depth', async () => {
      const { container } = render(
        <MarkdownRenderer content={'Example:\n\n<div>\n<!--\n<div>\n-->\n</div>'} />
      );
      await waitFor(() => {
        const codes = container.querySelectorAll('pre code.language-html');
        expect(codes).toHaveLength(1);
        expect(codes[0]?.textContent).toContain('<div>\n<!--\n<div>');
        expect(codes[0]?.textContent).toContain('-->\n</div>\n');
        expect(container.querySelector('.prose > div')).toBeFalsy();
      });
    });

    it('should process tags after multiline comment endings', async () => {
      const { container } = render(
        <MarkdownRenderer content={'Example:\n\n<div>\n<!--\nnote\n--> </div>'} />
      );
      await waitFor(() => {
        const codes = container.querySelectorAll('pre code.language-html');
        expect(codes).toHaveLength(1);
        expect(codes[0]?.textContent).toContain('<div>\n<!--\nnote');
        expect(codes[0]?.textContent).toContain('--> </div>\n');
        expect(container.querySelector('.prose > div')).toBeFalsy();
      });
    });

    it('should not loop when standalone multiline comments end before raw HTML', async () => {
      const { container } = render(
        <MarkdownRenderer content={'Example:\n\n<!--\nnote\n--> <div>hi</div>'} />
      );
      await waitFor(() => {
        const codes = container.querySelectorAll('pre code.language-html');
        expect(codes).toHaveLength(1);
        expect(codes[0]?.textContent).toContain('<!--\nnote');
        expect(codes[0]?.textContent).toContain('--> <div>hi</div>\n');
        expect(container.querySelector('.prose > div')).toBeFalsy();
      });
    });

    it('should collect later unclosed sibling tags on the opening line', async () => {
      const { container } = render(
        <MarkdownRenderer content={'Example:\n\n<div></div><span>\ntext\n</span>'} />
      );
      await waitFor(() => {
        const codes = container.querySelectorAll('pre code.language-html');
        expect(codes).toHaveLength(1);
        expect(codes[0]?.textContent).toBe('<div></div><span>\ntext\n</span>\n');
        expect(container.querySelector('.prose > div')).toBeFalsy();
      });
    });

    it('should ignore comparison operators in JSX expression props before sibling tags', async () => {
      const { container } = render(
        <MarkdownRenderer content={'Example:\n\n<Button value={a>b} /><div>\ntext\n</div>'} />
      );
      await waitFor(() => {
        const codes = container.querySelectorAll('pre code.language-html');
        expect(codes).toHaveLength(1);
        expect(codes[0]?.textContent).toBe('<Button value={a>b} /><div>\ntext\n</div>\n');
        expect(container.querySelector('.prose > div')).toBeFalsy();
      });
    });

    it('should not rewrite raw HTML examples inside longer fenced code', async () => {
      const { container } = render(
        <MarkdownRenderer content={'````markdown\n```html\n<div>hello</div>\n```\n````'} />
      );
      await waitFor(() => {
        const codes = container.querySelectorAll('pre code.language-markdown');
        expect(codes).toHaveLength(1);
        expect(codes[0]?.textContent).toBe('```html\n<div>hello</div>\n```\n');
      });
    });

    it('should not rewrite raw HTML examples inside indented fenced code', async () => {
      const { container } = render(
        <MarkdownRenderer content={'  ```html\n<div>hello</div>\n  ```'} />
      );
      await waitFor(() => {
        const codes = container.querySelectorAll('pre code.language-html');
        expect(codes).toHaveLength(1);
        expect(codes[0]?.textContent).toBe('<div>hello</div>\n');
      });
    });

    it('should not rewrite raw HTML examples inside tilde fenced code', async () => {
      const { container } = render(<MarkdownRenderer content={'~~~html\n<div>hello</div>\n~~~'} />);
      await waitFor(() => {
        const codes = container.querySelectorAll('pre code.language-html');
        expect(codes).toHaveLength(1);
        expect(codes[0]?.textContent).toBe('<div>hello</div>\n');
      });
    });

    it('should not rewrite raw HTML examples inside list-nested fenced code', async () => {
      const { container } = render(
        <MarkdownRenderer content={'- Example:\n    ```html\n    <div>hi</div>\n    ```'} />
      );
      await waitFor(() => {
        const codes = container.querySelectorAll('li pre code.language-html');
        expect(codes).toHaveLength(1);
        expect(codes[0]?.textContent).toBe('<div>hi</div>\n');
        expect(container.querySelector('li pre code.language-html code')).toBeFalsy();
      });
    });

    it('should not rewrite raw HTML examples inside fences opened after list markers', async () => {
      const { container } = render(
        <MarkdownRenderer content={'- ```html\n  <div>hi</div>\n  ```'} />
      );
      await waitFor(() => {
        const codes = container.querySelectorAll('li pre code.language-html');
        expect(codes).toHaveLength(1);
        expect(codes[0]?.textContent).toBe('<div>hi</div>\n');
        expect(container.querySelector('li pre code.language-html code')).toBeFalsy();
      });
    });

    it('should close list fences with legal extra indentation before escaping later HTML', async () => {
      const { container } = render(
        <MarkdownRenderer content={'- ```html\n  <div>inside</div>\n   ```\n<div>outside</div>'} />
      );
      await waitFor(() => {
        const codes = container.querySelectorAll('pre code.language-html');
        expect(codes).toHaveLength(2);
        expect(codes[0]?.textContent).toBe('<div>inside</div>\n');
        expect(codes[1]?.textContent).toBe('<div>outside</div>\n');
        expect(container.querySelector('.prose > div')).toBeFalsy();
      });
    });

    it('should preserve raw HTML examples inside list continuations', async () => {
      const { container } = render(<MarkdownRenderer content={'- Example:\n    <div>hi</div>'} />);
      await waitFor(() => {
        const codes = container.querySelectorAll('li pre code.language-html');
        expect(codes).toHaveLength(1);
        expect(codes[0]?.textContent).toBe('<div>hi</div>\n');
        expect(container.querySelector('.prose > div')).toBeFalsy();
      });
    });

    it('should preserve raw HTML examples that start after list markers', async () => {
      const { container } = render(<MarkdownRenderer content={'- <div>\n  hi\n  </div>'} />);
      await waitFor(() => {
        const codes = container.querySelectorAll('li pre code.language-html');
        expect(codes).toHaveLength(1);
        expect(codes[0]?.textContent).toBe('<div>\nhi\n</div>\n');
        expect(container.querySelector('.prose > div')).toBeFalsy();
      });
    });

    it('should preserve raw HTML examples inside wide-indented nested lists', async () => {
      const { container } = render(
        <MarkdownRenderer content={'100. outer\n     - <div>\n       hi\n       </div>'} />
      );
      await waitFor(() => {
        const codes = container.querySelectorAll('li pre code.language-html');
        expect(codes).toHaveLength(1);
        expect(codes[0]?.textContent).toBe('<div>\nhi\n</div>\n');
        expect(container.querySelector('.prose > div')).toBeFalsy();
      });
    });

    it('should preserve raw HTML examples inside blockquoted lists', async () => {
      const { container } = render(<MarkdownRenderer content={'> - <div>\n>   hi\n>   </div>'} />);
      await waitFor(() => {
        const codes = container.querySelectorAll('blockquote li pre code.language-html');
        expect(codes).toHaveLength(1);
        expect(codes[0]?.textContent).toBe('<div>\nhi\n</div>\n');
        expect(container.querySelector('.prose > div')).toBeFalsy();
      });
    });

    it('should preserve raw HTML examples inside blockquotes', async () => {
      const { container } = render(<MarkdownRenderer content={'> <div>hi</div>'} />);
      await waitFor(() => {
        const codes = container.querySelectorAll('blockquote pre code.language-html');
        expect(codes).toHaveLength(1);
        expect(codes[0]?.textContent).toBe('<div>hi</div>\n');
        expect(container.querySelector('.prose > div')).toBeFalsy();
      });
    });

    it('should preserve blockquoted comments without counting tags inside them', async () => {
      const { container } = render(
        <MarkdownRenderer content={'> <div>\n> <!--\n> <div>\n> -->\n> </div>'} />
      );
      await waitFor(() => {
        const codes = container.querySelectorAll('blockquote pre code.language-html');
        expect(codes).toHaveLength(1);
        expect(codes[0]?.textContent).toContain('<div>\n<!--\n<div>');
        expect(codes[0]?.textContent).toContain('-->\n</div>\n');
        expect(container.querySelector('.prose > div')).toBeFalsy();
      });
    });

    it('should preserve blockquoted split JSX component examples safely', async () => {
      const { container } = render(
        <MarkdownRenderer content={'> <Button\n>   label="Save"\n> />'} />
      );
      await waitFor(() => {
        const codes = container.querySelectorAll('blockquote pre code.language-html');
        expect(codes).toHaveLength(1);
        expect(codes[0]?.textContent).toBe('<Button\n  label="Save"\n/>\n');
        expect(container.querySelector('.prose button')).toBeFalsy();
      });
    });

    it('should not rewrite raw HTML examples inside blockquoted fenced code', async () => {
      const { container } = render(
        <MarkdownRenderer content={'> ```html\n> <div>hi</div>\n> ```'} />
      );
      await waitFor(() => {
        const codes = container.querySelectorAll('blockquote pre code.language-html');
        expect(codes).toHaveLength(1);
        expect(codes[0]?.textContent).toBe('<div>hi</div>\n');
        expect(container.querySelector('blockquote pre code.language-html code')).toBeFalsy();
      });
    });

    it('should keep later raw HTML after blockquoted fenced code protected separately', async () => {
      const { container } = render(
        <MarkdownRenderer content={'> ```html\n> <div>inside</div>\n> ```\n<div>outside</div>'} />
      );
      await waitFor(() => {
        const quotedCode = container.querySelector('blockquote pre code.language-html');
        const codes = container.querySelectorAll('pre code.language-html');
        expect(codes).toHaveLength(2);
        expect(quotedCode?.textContent).toBe('<div>inside</div>\n');
        expect(codes[1]?.textContent).toBe('<div>outside</div>\n');
      });
    });

    it('should preserve self-closing raw HTML examples safely', async () => {
      const { container } = render(
        <MarkdownRenderer content={'Example:\n\n<input type="text" />'} />
      );
      await waitFor(() => {
        const code = container.querySelector('pre code.language-html');
        expect(code?.textContent).toContain('<input type="text" />');
        expect(container.querySelector('.prose > input')).toBeFalsy();
      });
    });

    it('should preserve split void-element raw HTML examples safely', async () => {
      const { container } = render(
        <MarkdownRenderer content={'Example:\n\n<img\n  src="/x.png"\n/>'} />
      );
      await waitFor(() => {
        const codes = container.querySelectorAll('pre code.language-html');
        expect(codes).toHaveLength(1);
        expect(codes[0]?.textContent).toBe('<img\n  src="/x.png"\n/>\n');
        expect(container.querySelector('.prose > img')).toBeFalsy();
      });
    });

    it('should keep split void-element raw HTML examples open through quoted comparisons', async () => {
      const { container } = render(
        <MarkdownRenderer content={'Example:\n\n<img\n  alt=">"\n/>'} />
      );
      await waitFor(() => {
        const codes = container.querySelectorAll('pre code.language-html');
        expect(codes).toHaveLength(1);
        expect(codes[0]?.textContent).toBe('<img\n  alt=">"\n/>\n');
        expect(container.querySelector('.prose > img')).toBeFalsy();
      });
    });

    it('should preserve split self-closing component examples safely', async () => {
      const { container } = render(
        <MarkdownRenderer content={'Example:\n\n<Button\n  label="Save"\n/>'} />
      );
      await waitFor(() => {
        const codes = container.querySelectorAll('pre code.language-html');
        expect(codes).toHaveLength(1);
        expect(codes[0]?.textContent).toBe('<Button\n  label="Save"\n/>\n');
        expect(container.querySelector('.prose > button')).toBeFalsy();
      });
    });

    it('should preserve split self-closing component examples with quoted comparison attributes', async () => {
      const { container } = render(
        <MarkdownRenderer content={'Example:\n\n<Button title="1 > 0"\n/>'} />
      );
      await waitFor(() => {
        const codes = container.querySelectorAll('pre code.language-html');
        expect(codes).toHaveLength(1);
        expect(codes[0]?.textContent).toBe('<Button title="1 > 0"\n/>\n');
        expect(container.querySelector('.prose > button')).toBeFalsy();
      });
    });

    it('should preserve inline raw HTML examples safely', async () => {
      const { container } = render(
        <MarkdownRenderer content={'Use <input type="text" /> for the name'} />
      );
      await waitFor(() => {
        const code = container.querySelector('p code');
        expect(code?.textContent).toBe('<input type="text" />');
        expect(container.textContent).toContain('Use <input type="text" /> for the name');
        expect(container.querySelector('.prose input')).toBeFalsy();
      });
    });

    it('should keep prose lines with leading tags inline', async () => {
      const { container } = render(
        <MarkdownRenderer content={'<input type="text" /> is the field to use'} />
      );
      await waitFor(() => {
        const code = container.querySelector('p code');
        expect(code?.textContent).toBe('<input type="text" />');
        expect(container.querySelector('pre code.language-html')).toBeFalsy();
        expect(container.textContent).toContain('<input type="text" /> is the field to use');
      });
    });

    it('should keep non-void leading-tag prose inline', async () => {
      const { container } = render(<MarkdownRenderer content={'<span>foo</span> is the label'} />);
      await waitFor(() => {
        const codes = container.querySelectorAll('p code');
        expect(codes).toHaveLength(2);
        expect(codes[0]?.textContent).toBe('<span>');
        expect(codes[1]?.textContent).toBe('</span>');
        expect(container.querySelector('pre code.language-html')).toBeFalsy();
        expect(container.textContent).toContain('<span>foo</span> is the label');
      });
    });

    it('should keep leading multi-tag prose inline', async () => {
      const { container } = render(
        <MarkdownRenderer content={'<span>foo</span> <strong>bar</strong> is the label'} />
      );
      await waitFor(() => {
        const codes = container.querySelectorAll('p code');
        expect(codes).toHaveLength(4);
        expect(codes[0]?.textContent).toBe('<span>');
        expect(codes[1]?.textContent).toBe('</span>');
        expect(codes[2]?.textContent).toBe('<strong>');
        expect(codes[3]?.textContent).toBe('</strong>');
        expect(container.querySelector('pre code.language-html')).toBeFalsy();
        expect(container.textContent).toContain(
          '<span>foo</span> <strong>bar</strong> is the label'
        );
      });
    });

    it('should preserve inline raw HTML examples with comparison attributes safely', async () => {
      const { container } = render(
        <MarkdownRenderer content={'Use <input value="1 > 0" /> here'} />
      );
      await waitFor(() => {
        const code = container.querySelector('p code');
        expect(code?.textContent).toBe('<input value="1 > 0" />');
        expect(container.textContent).toContain('Use <input value="1 > 0" /> here');
        expect(container.querySelector('.prose input')).toBeFalsy();
      });
    });

    it('should preserve inline raw HTML examples with spaced attribute equals safely', async () => {
      const { container } = render(<MarkdownRenderer content={'Use <input value = "x" /> here'} />);
      await waitFor(() => {
        const code = container.querySelector('p code');
        expect(code?.textContent).toBe('<input value = "x" />');
        expect(container.textContent).toContain('Use <input value = "x" /> here');
        expect(container.querySelector('.prose input')).toBeFalsy();
      });
    });

    it('should preserve inline raw HTML examples with backticks in attributes safely', async () => {
      const { container } = render(<MarkdownRenderer content={'Use <input value="`" /> here'} />);
      await waitFor(() => {
        const code = container.querySelector('p code');
        expect(code?.textContent).toBe('<input value="`" />');
        expect(container.textContent).toContain('Use <input value="`" /> here');
        expect(container.querySelector('.prose input')).toBeFalsy();
      });
    });

    it('should preserve backticks inside quoted tags with comparison attributes safely', async () => {
      const { container } = render(
        <MarkdownRenderer content={'Use <input title="> `x" /> here'} />
      );
      await waitFor(() => {
        const code = container.querySelector('p code');
        expect(code?.textContent).toBe('<input title="> `x" />');
        expect(container.textContent).toContain('Use <input title="> `x" /> here');
        expect(container.querySelector('.prose input')).toBeFalsy();
      });
    });

    it('should preserve inline JSX expression props safely', async () => {
      const { container } = render(<MarkdownRenderer content={'Use <Button count={1} /> here'} />);
      await waitFor(() => {
        const code = container.querySelector('p code');
        expect(code?.textContent).toBe('<Button count={1} />');
        expect(container.textContent).toContain('Use <Button count={1} /> here');
        expect(container.querySelector('.prose button')).toBeFalsy();
      });
    });

    it('should preserve nested inline JSX expression props safely', async () => {
      const { container } = render(
        <MarkdownRenderer content={"Use <Button style={{ color: 'red' }} /> here"} />
      );
      await waitFor(() => {
        const code = container.querySelector('p code');
        expect(code?.textContent).toBe("<Button style={{ color: 'red' }} />");
        expect(container.textContent).toContain("Use <Button style={{ color: 'red' }} /> here");
        expect(container.querySelector('.prose button')).toBeFalsy();
      });
    });

    it('should preserve dotted inline JSX component names safely', async () => {
      const { container } = render(<MarkdownRenderer content={'Use <Dialog.Root open /> here'} />);
      await waitFor(() => {
        const code = container.querySelector('p code');
        expect(code?.textContent).toBe('<Dialog.Root open />');
        expect(container.textContent).toContain('Use <Dialog.Root open /> here');
        expect(container.querySelector('.prose dialog-root')).toBeFalsy();
      });
    });

    it('should preserve inline JSX spread props safely', async () => {
      const { container } = render(<MarkdownRenderer content={'Use <Button {...props} /> here'} />);
      await waitFor(() => {
        const code = container.querySelector('p code');
        expect(code?.textContent).toBe('<Button {...props} />');
        expect(container.textContent).toContain('Use <Button {...props} /> here');
        expect(container.querySelector('.prose button')).toBeFalsy();
      });
    });

    it('should preserve deeply nested inline JSX expression props safely', async () => {
      const { container } = render(
        <MarkdownRenderer content={"Use <Button config={{ theme: { color: 'red' } }} /> here"} />
      );
      await waitFor(() => {
        const code = container.querySelector('p code');
        expect(code?.textContent).toBe("<Button config={{ theme: { color: 'red' } }} />");
        expect(container.textContent).toContain(
          "Use <Button config={{ theme: { color: 'red' } }} /> here"
        );
        expect(container.querySelector('.prose button')).toBeFalsy();
      });
    });

    it('should escape indented HTML after paragraph text inline', async () => {
      const { container } = render(<MarkdownRenderer content={'Text\n    <input />'} />);
      await waitFor(() => {
        expect(container.querySelector('pre code.language-html')).toBeFalsy();
        expect(container.textContent).toContain('<input />');
        expect(container.querySelector('.prose input')).toBeFalsy();
      });
    });

    it('should preserve inline HTML comment examples safely', async () => {
      const { container } = render(<MarkdownRenderer content={'Use <!-- TODO --> here'} />);
      await waitFor(() => {
        const code = container.querySelector('p code');
        expect(code?.textContent).toBe('<!-- TODO -->');
        expect(container.textContent).toContain('Use <!-- TODO --> here');
      });
    });

    it('should preserve XML processing instruction examples safely', async () => {
      const { container } = render(<MarkdownRenderer content={'<?xml version="1.0"?>'} />);
      await waitFor(() => {
        const code = container.querySelector('pre code.language-html');
        expect(code?.textContent).toBe('<?xml version="1.0"?>\n');
      });
    });

    it('should preserve CDATA examples safely', async () => {
      const { container } = render(<MarkdownRenderer content={'<![CDATA[x]]>'} />);
      await waitFor(() => {
        const code = container.querySelector('pre code.language-html');
        expect(code?.textContent).toBe('<![CDATA[x]]>\n');
      });
    });

    it('should reset inline code spans at new list items', async () => {
      const { container } = render(
        <MarkdownRenderer content={'- Use `foo\n- <input />\n- done'} />
      );
      await waitFor(() => {
        expect(container.querySelector('.prose input')).toBeFalsy();
        expect(container.textContent).toContain('done');
      });
    });

    it('should handle tabbed list HTML continuations', async () => {
      const { container } = render(<MarkdownRenderer content={'-\t<div>\n\t</div>'} />);
      await waitFor(() => {
        const code = container.querySelector('pre code.language-html');
        expect(code?.textContent).toBe('<div>\n</div>\n');
      });
    });

    it('should reset code spans for blockquoted list items', async () => {
      const { container } = render(
        <MarkdownRenderer content={'> - Use `foo\n> - <input />\n> - done'} />
      );
      await waitFor(() => {
        expect(container.querySelector('.prose input')).toBeFalsy();
        expect(container.textContent).toContain('done');
      });
    });

    it('should reset code spans at heading boundaries', async () => {
      const { container } = render(<MarkdownRenderer content={'# Use `foo\n<input />'} />);
      await waitFor(() => {
        expect(container.querySelector('h1')).toBeTruthy();
        expect(container.querySelector('.prose input')).toBeFalsy();
      });
    });

    it('should preserve earlier multiline code spans during retry', async () => {
      const { container } = render(<MarkdownRenderer content={'`\n<input />\n`\n\nthen `oops '} />);
      await waitFor(() => {
        const codes = container.querySelectorAll('code');
        let foundInput = false;
        codes.forEach((c) => {
          if (c.textContent?.includes('<input />')) foundInput = true;
        });
        expect(foundInput).toBe(true);
        expect(container.querySelector('.prose input')).toBeFalsy();
      });
    });

    it('should highlight wide-indented nested list fences', async () => {
      const { container } = render(
        <MarkdownRenderer content={'100. outer\n     - ```ts\n       const x = 1;\n       ```'} />
      );
      await waitFor(() => {
        const code = container.querySelector('pre code.hljs');
        expect(code?.textContent).toContain('const x = 1');
      });
    });

    it('should fence dotted JSX tags as HTML blocks', async () => {
      const { container } = render(
        <MarkdownRenderer content={'<Dialog.Root>\ncontent\n</Dialog.Root>'} />
      );
      await waitFor(() => {
        const code = container.querySelector('pre code.language-html');
        expect(code?.textContent).toBe('<Dialog.Root>\ncontent\n</Dialog.Root>\n');
        expect(container.querySelector('.prose > div')).toBeFalsy();
      });
    });

    it('should keep dotted component prose inline', async () => {
      const { container } = render(
        <MarkdownRenderer content={'<Dialog.Root>bar</Dialog.Root> label'} />
      );
      await waitFor(() => {
        expect(container.querySelector('pre code.language-html')).toBeFalsy();
        expect(container.textContent).toContain('label');
      });
    });

    it('should not fence indented paragraph continuations as lists', async () => {
      const { container } = render(<MarkdownRenderer content={'Text\n    - <input />'} />);
      await waitFor(() => {
        expect(container.querySelector('pre code.language-html')).toBeFalsy();
        expect(container.textContent).toContain('<input />');
        expect(container.querySelector('.prose input')).toBeFalsy();
      });
    });

    it('should reset code spans at setext heading boundaries', async () => {
      const { container } = render(<MarkdownRenderer content={'Use `foo\n---\n<input />'} />);
      await waitFor(() => {
        expect(container.querySelector('h2')).toBeTruthy();
        expect(container.querySelector('.prose input')).toBeFalsy();
      });
    });

    it('should reset code spans when blockquotes interrupt paragraphs', async () => {
      const { container } = render(<MarkdownRenderer content={'Use `foo\n> <input />'} />);
      await waitFor(() => {
        expect(container.querySelector('blockquote')).toBeTruthy();
        expect(container.querySelector('.prose input')).toBeFalsy();
      });
    });

    it('should reset code spans when fences interrupt paragraphs', async () => {
      const { container } = render(
        <MarkdownRenderer content={'Use `foo\n```html\ncode\n```\n<input />'} />
      );
      await waitFor(() => {
        expect(container.querySelector('pre code.language-html')).toBeTruthy();
        expect(container.querySelector('.prose input')).toBeFalsy();
      });
    });

    it('should keep one-word prose after leading tags inline', async () => {
      const { container } = render(
        <MarkdownRenderer content={'<span>foo</span> <strong>bar</strong> label'} />
      );
      await waitFor(() => {
        expect(container.querySelector('pre code.language-html')).toBeFalsy();
        expect(container.textContent).toContain('label');
      });
    });

    it('should preserve markdown autolinks while escaping inline HTML', async () => {
      const { container } = render(
        <MarkdownRenderer content={'See <https://example.com> and Email <user@example.com>'} />
      );
      await waitFor(() => {
        const links = container.querySelectorAll('a');
        expect(links).toHaveLength(2);
        expect(links[0]?.getAttribute('href')).toBe('https://example.com');
        expect(links[1]?.getAttribute('href')).toBe('mailto:user@example.com');
        expect(container.querySelector('p code')).toBeFalsy();
      });
    });

    it('should keep standalone autolinks as links', async () => {
      const { container } = render(
        <MarkdownRenderer content={'<https://example.com>\n\n<user@example.com>'} />
      );
      await waitFor(() => {
        const links = container.querySelectorAll('a');
        expect(links).toHaveLength(2);
        expect(links[0]?.getAttribute('href')).toBe('https://example.com');
        expect(links[1]?.getAttribute('href')).toBe('mailto:user@example.com');
        expect(container.querySelector('pre code.language-html')).toBeFalsy();
      });
    });

    it('should keep non-slash URI autolinks as links', async () => {
      const { container } = render(
        <MarkdownRenderer content={'<mailto:user@example.com>\n\n<urn:isbn:9780131103627>'} />
      );
      await waitFor(() => {
        const links = container.querySelectorAll('a');
        expect(links).toHaveLength(2);
        expect(links[0]?.getAttribute('href')).toBe('mailto:user@example.com');
        expect(links[1]?.getAttribute('href')).toBe('urn:isbn:9780131103627');
        expect(container.querySelector('pre code.language-html')).toBeFalsy();
      });
    });

    it('should preserve single-letter namespaced tags safely', async () => {
      const { container } = render(<MarkdownRenderer content={'Use <x:Foo> here'} />);
      await waitFor(() => {
        const code = container.querySelector('p code');
        expect(code?.textContent).toBe('<x:Foo>');
        expect(container.textContent).toContain('Use <x:Foo> here');
        expect(container.querySelector('.prose x\\:Foo')).toBeFalsy();
      });
    });

    it('should honor escaped backticks before inline raw HTML examples', async () => {
      const { container } = render(<MarkdownRenderer content={'Use \\` before <input />'} />);
      await waitFor(() => {
        const code = container.querySelector('p code');
        expect(code?.textContent).toBe('<input />');
        expect(container.textContent).toContain('Use ` before <input />');
        expect(container.querySelector('.prose input')).toBeFalsy();
      });
    });

    it('should not rewrite inline raw HTML examples inside code spans', async () => {
      const { container } = render(<MarkdownRenderer content={'Use `foo <input /> bar`'} />);
      await waitFor(() => {
        const code = container.querySelector('p code');
        expect(code?.textContent).toBe('foo <input /> bar');
        expect(container.querySelector('.prose input')).toBeFalsy();
      });
    });

    it('should match inline code delimiter lengths before escaping raw HTML', async () => {
      const { container } = render(<MarkdownRenderer content={'Use ``foo ` <input /> bar``'} />);
      await waitFor(() => {
        const code = container.querySelector('p code');
        expect(code?.textContent).toBe('foo ` <input /> bar');
        expect(container.querySelector('.prose input')).toBeFalsy();
      });
    });

    it('should honor escaped inline raw HTML examples', async () => {
      const { container } = render(<MarkdownRenderer content={'Use \\<input /> for the name'} />);
      await waitFor(() => {
        expect(container.textContent).toContain('Use <input /> for the name');
        expect(container.querySelector('p code')).toBeFalsy();
        expect(container.querySelector('.prose input')).toBeFalsy();
      });
    });

    it('should preserve multiline inline code spans with raw HTML examples', async () => {
      const { container } = render(<MarkdownRenderer content={'Use `foo\n<input />\nbar`'} />);
      await waitFor(() => {
        const code = container.querySelector('p code');
        expect(code?.textContent).toBe('foo <input /> bar');
        expect(container.querySelector('pre code.language-html')).toBeFalsy();
        expect(container.querySelector('.prose input')).toBeFalsy();
      });
    });

    it('should re-escape raw HTML after unmatched inline code spans', async () => {
      const { container } = render(<MarkdownRenderer content={'Use `foo\n<input />'} />);
      await waitFor(() => {
        const code = container.querySelector('pre code.language-html');
        expect(code?.textContent).toBe('<input />\n');
        expect(container.textContent).toContain('Use `foo');
        expect(container.textContent).toContain('<input />');
        expect(container.querySelector('.prose input')).toBeFalsy();
      });
    });

    it('should reset inline code spans at blank lines before raw HTML examples', async () => {
      const { container } = render(<MarkdownRenderer content={'Use `foo\n\n<input />\n`'} />);
      await waitFor(() => {
        const code = container.querySelector('pre code.language-html');
        expect(code?.textContent).toBe('<input />\n');
        expect(container.textContent).toContain('Use `foo');
        expect(container.textContent).toContain('<input />');
        expect(container.querySelector('.prose input')).toBeFalsy();
      });
    });

    it('should reset inline code spans on blockquote blank lines', async () => {
      const { container } = render(
        <MarkdownRenderer content={'> Use `foo\n>\n> <input />\n> `'} />
      );
      await waitFor(() => {
        const code = container.querySelector('pre code.language-html');
        expect(code?.textContent).toBe('<input />\n');
        expect(container.textContent).toContain('Use `foo');
        expect(container.textContent).toContain('<input />');
        expect(container.querySelector('.prose input')).toBeFalsy();
      });
    });

    it('should update inline code spans on indented paragraph continuations', async () => {
      const { container } = render(
        <MarkdownRenderer content={'Use `foo\n    bar`\nUse <input />'} />
      );
      await waitFor(() => {
        const inlineCode = container.querySelector('p code');
        expect(inlineCode?.textContent).toBe('foo     bar');
        const htmlCode = container.querySelectorAll('p code')[1];
        expect(htmlCode?.textContent).toBe('<input />');
        expect(container.textContent).toContain('Use <input />');
        expect(container.querySelector('.prose input')).toBeFalsy();
      });
    });

    it('should not rewrite indented code blocks with raw HTML examples', async () => {
      const { container } = render(<MarkdownRenderer content={'    return <div />;'} />);
      await waitFor(() => {
        const code = container.querySelector('pre code');
        expect(code?.textContent).toBe('return <div />;\n');
        expect(container.querySelector('p code')).toBeFalsy();
      });
    });

    it('should escape raw HTML examples in list continuations', async () => {
      const { container } = render(<MarkdownRenderer content={'- Example:\n    Use <input />'} />);
      await waitFor(() => {
        const code = container.querySelector('li code');
        expect(code?.textContent).toBe('<input />');
        expect(container.textContent).toContain('Use <input />');
        expect(container.querySelector('.prose input')).toBeFalsy();
      });
    });

    it('should preserve single-tag raw HTML examples safely', async () => {
      const { container } = render(<MarkdownRenderer content={'Example:\n\n<br>'} />);
      await waitFor(() => {
        const code = container.querySelector('pre code.language-html');
        expect(code?.textContent).toContain('<br>');
        expect(container.querySelector('.prose > br')).toBeFalsy();
      });
    });

    it('should preserve unmatched opening raw HTML tags safely', async () => {
      const { container } = render(<MarkdownRenderer content={'Example:\n\n<div>'} />);
      await waitFor(() => {
        const code = container.querySelector('pre code.language-html');
        expect(code?.textContent).toBe('<div>\n');
        expect(container.querySelector('.prose > div')).toBeFalsy();
      });
    });

    it('should not move prose between raw HTML examples into code fences', async () => {
      const { container } = render(
        <MarkdownRenderer content={'<div>one</div>\n\nexplanation\n\n<div>two</div>'} />
      );
      await waitFor(() => {
        const codes = container.querySelectorAll('pre code.language-html');
        expect(codes).toHaveLength(2);
        expect(codes[0]?.textContent).toContain('<div>one</div>');
        expect(codes[1]?.textContent).toContain('<div>two</div>');
        expect(container.textContent).toContain('explanation');
        expect(codes[0]?.textContent).not.toContain('explanation');
        expect(codes[1]?.textContent).not.toContain('explanation');
      });
    });

    it('should preserve raw HTML examples with embedded fence delimiters safely', async () => {
      const { container } = render(<MarkdownRenderer content={'<pre>\n```\n</pre>'} />);
      await waitFor(() => {
        const codes = container.querySelectorAll('pre code.language-html');
        expect(codes).toHaveLength(1);
        expect(codes[0]?.textContent).toBe('<pre>\n```\n</pre>\n');
      });
    });

    it('should handle content with newlines', async () => {
      const { container } = render(<MarkdownRenderer content="Line 1\n\nLine 2" />);
      await waitFor(() => {
        expect(container.textContent).toContain('Line 1');
        expect(container.textContent).toContain('Line 2');
      });
    });

    it('should escape script tags', async () => {
      const { container } = render(<MarkdownRenderer content={'<script>alert(1)</script>'} />);
      await waitFor(() => {
        expect(container.querySelector('script')).toBeFalsy();
        expect(container.textContent).toContain('alert(1)');
      });
    });

    it('should escape iframe tags', async () => {
      const { container } = render(
        <MarkdownRenderer content={'<iframe src="evil.com"></iframe>'} />
      );
      await waitFor(() => {
        expect(container.querySelector('iframe')).toBeFalsy();
        expect(container.textContent).toContain('evil.com');
      });
    });

    it('should escape event handler attributes', async () => {
      const { container } = render(
        <MarkdownRenderer content={'<div onclick="alert(1)">click</div>'} />
      );
      await waitFor(() => {
        expect(container.querySelector('.prose > div')).toBeFalsy();
        expect(container.textContent).toContain('click');
      });
    });

    it('should preserve --> sequences in rendered text', async () => {
      const { container } = render(<MarkdownRenderer content={'Note: --> end'} />);
      await waitFor(() => {
        expect(container.textContent).toContain('Note: --> end');
      });
    });

    it('renderPlainText escapes HTML and preserves line breaks', () => {
      const result = renderPlainText('a < b\nline 2');
      expect(result).toBe('<p>a &lt; b<br>line 2</p>');
    });
  });
});
