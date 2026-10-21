import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArtifactHtmlDocument } from '../ArtifactHtmlDocument.tsx';

afterEach(cleanup);
const html = {
  document: '<!doctype html><html><head></head><body><h1>Untrusted title</h1></body></html>',
  scriptsRemoved: true,
  links: [{ text: 'Docs', href: 'https://example.com/docs' }],
};

describe('ArtifactHtmlDocument', () => {
  it('isolates the prepared document in a frame without any sandbox allowance or bridge', () => {
    const { container } = render(<ArtifactHtmlDocument html={html} />);
    const frame = container.querySelector('iframe')!;
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame.getAttribute('srcdoc')).toBe(html.document);
    expect(frame.hasAttribute('src')).toBe(false);
    expect(frame.hasAttribute('allow')).toBe(false);
    expect(screen.getByText('Scripts disabled')).toBeTruthy();
    expect(container.querySelector('h1')).toBeNull();
  });

  it('offers external links only as trusted host actions with explicit confirmation', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    render(<ArtifactHtmlDocument html={html} />);
    const link = screen.getByRole('button', { name: 'Docs' });
    expect(link.getAttribute('data-external-href')).toBe('https://example.com/docs');
    fireEvent.click(link);
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it('ignores invalid external protocols even from a malformed response', () => {
    render(
      <ArtifactHtmlDocument
        html={{ ...html, links: [{ text: 'Bad', href: 'javascript:alert(1)' }] }}
      />
    );
    expect(screen.queryByRole('button', { name: 'Bad' })).toBeNull();
  });
});
