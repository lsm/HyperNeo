import { fireEvent, render, waitFor, cleanup } from '@testing-library/preact';
import { afterEach, expect, it, vi } from 'vitest';
import MarkdownRenderer from '../MarkdownRenderer.tsx';
import { copyToClipboard } from '../../../lib/utils.ts';
import { locale } from '../../../lib/i18n/index.ts';

vi.mock('../../../lib/utils.ts', () => ({ copyToClipboard: vi.fn() }));
afterEach(() => {
  cleanup();
  locale.value = 'en';
});

it('uses the same copy control and feedback as code blocks while localizing the quote label', async () => {
  vi.mocked(copyToClipboard).mockResolvedValue(true);
  locale.value = 'zh-Hans';
  const app = render(
    <MarkdownRenderer class="neo-markdown" content={'> Original **text**.\n\n```text\nCode\n```'} />
  );
  await waitFor(() => expect(app.getByRole('button', { name: '复制引用' })).toBeTruthy());
  const quote = app.getByRole('button', { name: '复制引用' });
  const code = app.getByRole('button', { name: 'Copy code' });
  expect(quote.className).toBe(code.className);
  expect(quote.parentElement?.className).toBe(code.parentElement?.className);
  fireEvent.click(quote);
  await waitFor(() => expect(copyToClipboard).toHaveBeenLastCalledWith('Original text.'));
  await waitFor(() => expect(quote.getAttribute('title')).toBe('Copied!'));
  expect(quote.textContent).toBe(code.textContent);
  expect(quote.querySelector('[aria-live]')).toBeNull();
  locale.value = 'en';
  await waitFor(() => expect(app.getByRole('button', { name: 'Copy quote' })).toBeTruthy(), {
    timeout: 2000,
  });
  fireEvent.click(app.getByRole('button', { name: 'Copy quote' }));
  await waitFor(() => expect(copyToClipboard).toHaveBeenLastCalledWith('Original text.'));
});

it('copies highlighted code with its line breaks, blank lines, and indentation intact', async () => {
  vi.mocked(copyToClipboard).mockResolvedValue(true);
  const code = '    def f():\n        return 1\n\n\n    def g():\n        return 2';
  const app = render(
    <MarkdownRenderer
      class="neo-markdown"
      content={`> \`\`\`python\n${code
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')}\n> \`\`\``}
    />
  );
  await waitFor(() => expect(app.container.querySelector('.hljs-keyword')).toBeTruthy());
  fireEvent.click(app.getByRole('button', { name: 'Copy quote' }));
  await waitFor(() => expect(copyToClipboard).toHaveBeenLastCalledWith(code));
});

it('copies a rendered math formula once as readable source', async () => {
  vi.mocked(copyToClipboard).mockResolvedValue(true);
  const app = render(
    <MarkdownRenderer
      class="neo-markdown"
      content={'> Formula:\n>\n> $$x^2 + y^2 = z^2$$\n>\n> End.'}
    />
  );
  await waitFor(() => expect(app.container.querySelector('.katex')).toBeTruthy());
  fireEvent.click(app.getByRole('button', { name: 'Copy quote' }));
  await waitFor(() =>
    expect(copyToClipboard).toHaveBeenLastCalledWith('Formula:\n\nx^2 + y^2 = z^2\n\nEnd.')
  );
});

it('keeps paragraph boundaries around multiline display math', async () => {
  vi.mocked(copyToClipboard).mockResolvedValue(true);
  const app = render(
    <MarkdownRenderer
      class="neo-markdown"
      content={'> Formula:\n>\n> $$\n> x^2 + y^2 = z^2\n> $$\n>\n> End.'}
    />
  );
  await waitFor(() => expect(app.container.querySelector('.katex-display')).toBeTruthy());
  fireEvent.click(app.getByRole('button', { name: 'Copy quote' }));
  await waitFor(() =>
    expect(copyToClipboard).toHaveBeenLastCalledWith('Formula:\n\nx^2 + y^2 = z^2\n\nEnd.')
  );
});

it('keeps line breaks, lists, entities, and code without copying other controls', async () => {
  vi.mocked(copyToClipboard).mockResolvedValue(true);
  const app = render(
    <MarkdownRenderer
      class="neo-markdown"
      content={
        '> 你好 &amp; team\n> next line\n>\n> - First\n> - Second\n>\n> ```text\n> exact code\n> ```'
      }
    />
  );
  await waitFor(() => expect(app.getByRole('button', { name: 'Copy quote' })).toBeTruthy());
  fireEvent.click(app.getByRole('button', { name: 'Copy quote' }));
  await waitFor(() =>
    expect(copyToClipboard).toHaveBeenLastCalledWith(
      '你好 & team\nnext line\n\nFirst\nSecond\n\nexact code'
    )
  );
});

it('shows the shared Copied title only after success and clears it', async () => {
  const copy = vi.mocked(copyToClipboard).mockResolvedValueOnce(false).mockResolvedValue(true);
  const app = render(<MarkdownRenderer class="neo-markdown" content={'> Copy this'} />);
  await waitFor(() => expect(app.getByRole('button', { name: 'Copy quote' })).toBeTruthy());
  const button = app.getByRole('button', { name: 'Copy quote' });
  fireEvent.click(button);
  await waitFor(() => expect(copy).toHaveBeenLastCalledWith('Copy this'));
  expect(button.getAttribute('title')).toBe('Copy quote');
  fireEvent.click(button);
  await waitFor(() => expect(button.getAttribute('title')).toBe('Copied!'));
  await waitFor(() => expect(button.getAttribute('title')).toBe('Copy quote'), { timeout: 2000 });
});

it('copies each Neo quote as plain text with paragraphs and nested quotes', async () => {
  vi.mocked(copyToClipboard).mockResolvedValue(true);
  const { container, getAllByRole } = render(
    <MarkdownRenderer
      class="neo-markdown"
      content={
        '> Hello **friend** and [team](https://example.com).\n>\n> Second `paragraph`.\n>\n> > Nested *reply*.\n\n> Another quote.'
      }
    />
  );
  await waitFor(() => expect(container.querySelectorAll('blockquote')).toHaveLength(3));
  const buttons = getAllByRole('button', { name: 'Copy quote', exact: true });
  expect(buttons).toHaveLength(3);
  fireEvent.click(buttons[0]);
  await waitFor(() =>
    expect(copyToClipboard).toHaveBeenLastCalledWith(
      'Hello friend and team.\n\nSecond paragraph.\n\nNested reply.'
    )
  );
  await waitFor(() => expect(buttons[0].getAttribute('title')).toBe('Copied!'));
  fireEvent.click(buttons[1]);
  await waitFor(() => expect(copyToClipboard).toHaveBeenLastCalledWith('Nested reply.'));
  fireEvent.click(buttons[2]);
  await waitFor(() => expect(copyToClipboard).toHaveBeenLastCalledWith('Another quote.'));
});

it('copies updated streamed text without accumulating controls', async () => {
  vi.mocked(copyToClipboard).mockResolvedValue(true);
  const { container, getByRole, rerender } = render(
    <MarkdownRenderer class="neo-markdown" content={'> Draft'} />
  );
  await waitFor(() => expect(getByRole('button', { name: 'Copy quote' })).toBeTruthy());
  rerender(<MarkdownRenderer class="neo-markdown" content={'> Complete reply'} />);
  await waitFor(() =>
    expect(container.querySelector('blockquote')?.textContent).toContain('Complete reply')
  );
  fireEvent.click(getByRole('button', { name: 'Copy quote' }));
  await waitFor(() => expect(copyToClipboard).toHaveBeenLastCalledWith('Complete reply'));
});
