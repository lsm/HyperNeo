import { fireEvent, render, waitFor, cleanup } from '@testing-library/preact';
import { afterEach, expect, it, vi } from 'vitest';
import MarkdownRenderer from '../MarkdownRenderer.tsx';
import { copyToClipboard } from '../../../lib/utils.ts';

vi.mock('../../../lib/utils.ts', () => ({ copyToClipboard: vi.fn() }));
afterEach(cleanup);

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

it('shows Copied only after success and clears the feedback', async () => {
  const copy = vi.mocked(copyToClipboard).mockResolvedValueOnce(false).mockResolvedValue(true);
  const app = render(<MarkdownRenderer class="neo-markdown" content={'> Copy this'} />);
  await waitFor(() => expect(app.getByRole('button', { name: 'Copy quote' })).toBeTruthy());
  fireEvent.click(app.getByRole('button', { name: 'Copy quote' }));
  await waitFor(() => expect(copy).toHaveBeenLastCalledWith('Copy this'));
  expect(app.queryByText('Copied')).toBeNull();
  fireEvent.click(app.getByRole('button', { name: 'Copy quote' }));
  await waitFor(() => expect(app.getByText('Copied')).toBeTruthy());
  await waitFor(() => expect(app.queryByText('Copied')).toBeNull(), { timeout: 2000 });
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
  await waitFor(() => expect(buttons[0].textContent).toContain('Copied'));
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
