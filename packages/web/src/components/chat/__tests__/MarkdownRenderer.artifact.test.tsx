import { cleanup, render, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import MarkdownRenderer from '../MarkdownRenderer';

afterEach(cleanup);

const document = [
  '# Report',
  '',
  'See [setup](#setup), [the site](https://example.com/docs) and [secrets](../../.env).',
  '',
  '![remote](https://example.com/pixel.png) ![local](./chart.png) ![inline](data:image/png;base64,iVBORw0KGgo=)',
  '',
  '<script>window.__artifactSentinel = 1</script>',
  '',
  'Inline <img src="https://example.com/track.png" onerror="window.__artifactSentinel = 2"> html.',
].join('\n');

async function renderArtifact(content = document) {
  const view = render(<MarkdownRenderer content={content} artifactLinks />);
  await waitFor(() =>
    expect(view.container.querySelector('.prose')?.childElementCount).toBeGreaterThan(0)
  );
  return view.container;
}

describe('MarkdownRenderer artifact links', () => {
  it('keeps fragments, and shows external links as host actions without an href', async () => {
    const container = await renderArtifact();
    const anchors = Array.from(container.querySelectorAll('a'));
    expect(anchors.map((anchor) => anchor.getAttribute('href'))).toEqual(['#setup', null]);
    const site = anchors[1];
    expect(site.textContent).toBe('the site');
    expect(site.getAttribute('data-external-href')).toBe('https://example.com/docs');
  });

  it('renders a relative link as inert text', async () => {
    const container = await renderArtifact();
    const refused = container.querySelector('[data-refused-link]');
    expect(refused?.tagName).toBe('SPAN');
    expect(refused?.textContent).toBe('secrets');
    expect(refused?.getAttribute('title')).toBe('This link is not available in the preview');
  });

  it('loads no remote or relative images, only embedded raster ones', async () => {
    const container = await renderArtifact();
    const sources = Array.from(container.querySelectorAll('img')).map((img) =>
      img.getAttribute('src')
    );
    expect(sources).toEqual(['data:image/png;base64,iVBORw0KGgo=']);
    expect(container.textContent).toContain('[image: remote]');
    expect(container.textContent).toContain('[image: local]');
  });

  it('keeps raw HTML inert', async () => {
    const container = await renderArtifact();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('[onerror]')).toBeNull();
    expect((window as { __artifactSentinel?: number }).__artifactSentinel).toBeUndefined();
  });

  it('does not leak artifact rendering into chat rendering of the same text', async () => {
    await renderArtifact('[the site](https://example.com/docs)');
    cleanup();
    const chat = render(<MarkdownRenderer content="[the site](https://example.com/docs)" />);
    await waitFor(() =>
      expect(chat.container.querySelector('a')?.getAttribute('href')).toBe(
        'https://example.com/docs'
      )
    );
  });

  it('does not serve a chat render of "artifact:<text>" to the artifact render of <text>', async () => {
    const link = '[spoof](https://example.com/spoof)';
    const chat = render(<MarkdownRenderer content={`artifact:${link}`} />);
    await waitFor(() => expect(chat.container.querySelector('a')).toBeTruthy());
    cleanup();
    const container = await renderArtifact(link);
    const anchor = container.querySelector('a');
    expect(anchor?.getAttribute('href')).toBeNull();
    expect(anchor?.getAttribute('data-external-href')).toBe('https://example.com/spoof');
  });
});
