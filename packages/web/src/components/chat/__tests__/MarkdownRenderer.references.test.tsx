import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MarkdownRenderer from '../MarkdownRenderer';
import { previewReferenceCandidates } from '@hyperneo/shared/types/artifact-reference';

afterEach(cleanup);

const content = [
  'Read [the design](docs/design/a.md), `evidence/report.html` and notes.md.',
  '',
  'The PR is https://github.com/acme/demo/pull/7 and [the site](https://example.com).',
  '',
  '```sh',
  'cat docs/design/a.md',
  '```',
].join('\n');
const references = [
  'docs/design/a.md',
  'evidence/report.html',
  'notes.md',
  'https://github.com/acme/demo/pull/7',
];

async function renderWith(onReference = vi.fn()) {
  const view = render(
    <MarkdownRenderer content={content} references={references} onReference={onReference} />
  );
  await waitFor(() => expect(screen.getByText('the design')).toBeTruthy());
  return { ...view, onReference };
}

describe('MarkdownRenderer preview references', () => {
  it('sends a spaced inline-code path as one complete reference', async () => {
    const text = 'Open `My notes.md`.';
    const onReference = vi.fn();
    render(
      <MarkdownRenderer
        content={text}
        references={previewReferenceCandidates(text).map((item) => item.reference)}
        onReference={onReference}
      />
    );
    const link = await screen.findByRole('link', { name: 'Open preview: My notes.md' });
    fireEvent.click(link);
    expect(onReference).toHaveBeenCalledWith('My notes.md');
  });
  it('opens a Markdown link, inline code path, bare path or PR link in the app', async () => {
    const { onReference } = await renderWith();
    for (const text of [
      'the design',
      'evidence/report.html',
      'notes.md',
      'https://github.com/acme/demo/pull/7',
    ])
      fireEvent.click(screen.getByText(text));
    expect(onReference.mock.calls.map((call) => call[0])).toEqual(references);
  });

  it('leaves other links and code blocks alone', async () => {
    const { container, onReference } = await renderWith();
    expect(screen.getByText('the site').getAttribute('href')).toBe('https://example.com');
    expect(container.querySelector('pre [data-preview-reference]')).toBeNull();
    expect(container.querySelector('pre')?.textContent).toContain('cat docs/design/a.md');
    expect(onReference).not.toHaveBeenCalled();
  });

  it('keeps the text selectable and labels each reference as a preview action', async () => {
    await renderWith();
    const bare = screen.getByText('notes.md');
    expect(bare.getAttribute('role')).toBe('link');
    expect(bare.getAttribute('aria-label')).toBe('Open preview: notes.md');
    expect(screen.getByText('Read', { exact: false }).textContent).toContain('notes.md.');
  });

  it('marks a bare path only as a whole token, not inside a longer name', async () => {
    const onReference = vi.fn();
    const { container } = render(
      <MarkdownRenderer
        content="Keep notes.md.bak and notes.md,draft aside; read (notes.md)."
        references={['notes.md']}
        onReference={onReference}
      />
    );
    await waitFor(() => expect(container.textContent).toContain('notes.md.bak'));
    const marked = Array.from(container.querySelectorAll('[data-preview-reference]'));
    expect(marked.map((element) => element.textContent)).toEqual(['notes.md']);
    expect(marked[0].parentElement?.textContent).toContain('(notes.md).');
  });
});
