import { fireEvent, render, waitFor, cleanup } from '@testing-library/preact';
import { afterEach, expect, it, vi } from 'vitest';
import MarkdownRenderer from '../MarkdownRenderer.tsx';
import { copyToClipboard } from '../../../lib/utils.ts';

vi.mock('../../../lib/utils.ts', () => ({ copyToClipboard: vi.fn() }));
afterEach(cleanup);

it('copies each Neo quote as plain text with paragraphs and nested quotes', async () => {
  vi.mocked(copyToClipboard).mockResolvedValue(true);
  const { container, getAllByRole } = render(
    <MarkdownRenderer
      class="neo-markdown"
      content={'> Hello **friend** and [team](https://example.com).\n>\n> Second `paragraph`.\n>\n> > Nested *reply*.\n\n> Another quote.'}
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
  const { getByRole, rerender } = render(
    <MarkdownRenderer class="neo-markdown" content={'> Draft'} />
  );
  await waitFor(() => expect(getByRole('button', { name: 'Copy quote' })).toBeTruthy());
  rerender(<MarkdownRenderer class="neo-markdown" content={'> Complete reply'} />);
  await waitFor(() => expect(getByRole('blockquote').textContent).toContain('Complete reply'));
  fireEvent.click(getByRole('button', { name: 'Copy quote' }));
  await waitFor(() => expect(copyToClipboard).toHaveBeenLastCalledWith('Complete reply'));
});
