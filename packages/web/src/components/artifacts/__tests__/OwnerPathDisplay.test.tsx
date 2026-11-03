import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import MarkdownRenderer from '../../chat/MarkdownRenderer.tsx';
import { ownerPathLabel } from '../../../lib/owner-path-label.ts';
import { FileReferenceCards } from '../FileReferenceCards.tsx';
import { systemState } from '../../../lib/state.ts';
import type { Signal } from '@preact/signals';
import type { SystemState } from '@hyperneo/shared';
const ownerState = systemState as Signal<SystemState | null>;
import { artifactPreviewStack, closeArtifactPreview } from '../../../lib/artifact-preview-store.ts';
import { copyToClipboard } from '../../../lib/utils.ts';

vi.mock('../../../lib/utils.ts', () => ({ copyToClipboard: vi.fn() }));
const previous = ownerState.value;
it('keeps bare PR filenames and relative paths as prose instead of current-file cards', () => {
  render(
    <FileReferenceCards
      source={{ kind: 'publication', id: 'p' }}
      text={
        'CLAUDE.md `docs/guide.md` [Relative](guide.md) file:relative.md `/home/owner/reports/current.md` `~/reports/home.md`'
      }
    />
  );
  expect(screen.queryByRole('button', { name: 'Open current file: CLAUDE.md' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Open current file: guide.md' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Open current file: relative.md' })).toBeNull();
  expect(screen.getAllByRole('button')).toHaveLength(2);
});
const home = '/home/owner';
const path = `${home}/reports/current.md`;
beforeEach(() => {
  ownerState.value = { homeDirectory: home } as never;
  vi.mocked(copyToClipboard).mockResolvedValue(true);
});
afterEach(() => {
  cleanup();
  closeArtifactPreview();
  ownerState.value = previous;
  vi.clearAllMocks();
});

it('shortens recognized display labels while clicks, links and quote copies retain identity', async () => {
  const open = vi.fn();
  render(
    <MarkdownRenderer
      class="neo-markdown"
      content={`> \`${path}\`\n\n[Report](file://${path})\n\n${path}\n\n\`\`\`text\n${path}\n\`\`\``}
      references={[path, `file://${path}`]}
      onReference={open}
    />
  );
  const label = (
    await screen.findAllByRole('link', { name: 'Open preview: ~/reports/current.md' })
  )[0];
  expect(label.textContent).toBe('~/reports/current.md');
  fireEvent.click(label);
  expect(open).toHaveBeenLastCalledWith(path);
  expect(screen.getByRole('link', { name: 'Report' }).getAttribute('href')).toBe(`file://${path}`);
  fireEvent.click(screen.getByRole('button', { name: 'Copy quote' }));
  await waitFor(() => expect(copyToClipboard).toHaveBeenLastCalledWith(path));
  expect(document.querySelector('pre')?.textContent).toContain(path);
});

it('refreshes cached display after owner metadata changes without guessing another home', async () => {
  render(
    <MarkdownRenderer
      content={`\`${path}\` \`${home}-other/report.md\` \`/home/other/report.md\``}
      references={[path]}
    />
  );
  await screen.findByText('~/reports/current.md');
  expect(screen.getByText(`${home}-other/report.md`)).toBeTruthy();
  expect(screen.getByText('/home/other/report.md')).toBeTruthy();
  act(() => {
    ownerState.value = { homeDirectory: '/home/other' } as never;
  });
  await screen.findByText(path);
  expect(screen.queryByText('~/reports/current.md')).toBeNull();
  act(() => {
    ownerState.value = null;
  });
  await screen.findByText('/home/other/report.md');
});

it('shortens file-card tooltips but preserves their exact encoded reference target', () => {
  const reference = `file://${home}/current%20report.md`;
  render(
    <FileReferenceCards
      text={`[Current](${reference})`}
      source={{ kind: 'publication', id: 'p' }}
    />
  );
  const card = screen.getByRole('button', { name: 'Open current file: current report.md' });
  expect(card.getAttribute('title')).toBe('~/current report.md');
  fireEvent.click(card);
  expect(artifactPreviewStack.value.at(-1)).toMatchObject({
    reference,
    source: { kind: 'publication', id: 'p' },
  });
});

it('leaves a known remote owner untouched and never adds an interaction to display-only text', async () => {
  const view = render(<MarkdownRenderer content={`\`${path}\``} />);
  expect(await screen.findByText('~/reports/current.md')).toBeTruthy();
  expect(screen.queryByRole('link')).toBeNull();
  view.rerender(<MarkdownRenderer content={`\`${path}\``} referenceHome={null} />);
  expect(await screen.findByText(path)).toBeTruthy();
  view.unmount();
  render(
    <FileReferenceCards
      text={path}
      source={{ kind: 'publication', id: 'remote' }}
      ownerHome={null}
    />
  );
  expect(screen.getByTitle(path)).toBeTruthy();
});

it.each([
  ['/home/owner/report.md', '/home/owner/', '~/report.md'],
  ['/home/owner-other/report.md', '/home/owner', '/home/owner-other/report.md'],
  ['/home/owner', '/home/owner', '~'],
  ['/report.md', '/', '~/report.md'],
])('uses the exact owner boundary for %s', (path, home, expected) => {
  expect(ownerPathLabel(path, home)).toBe(expected);
});

it('preserves inline code and emphasis inside path links', async () => {
  const clicked = vi.fn();
  const url = `file://${path}`;
  const { container } = render(
    <MarkdownRenderer
      class="neo-markdown"
      content={`> [\`${path}\`](${url}) and [**${path}**](${url})\n\n[**/home/owner**/reports/current.md](${url})`}
      references={[url]}
      onReference={clicked}
    />
  );
  const links = await screen.findAllByRole('link', { name: '~/reports/current.md', exact: true });
  expect(links).toHaveLength(2);
  expect(container.querySelector('a code')?.textContent).toBe('~/reports/current.md');
  expect(container.querySelector('a strong')?.textContent).toBe('~/reports/current.md');
  const mixed = container.querySelectorAll('a')[2];
  expect(mixed.textContent).toBe(path);
  expect(mixed.querySelector('strong')?.textContent).toBe('/home/owner');
  fireEvent.click(links[0]);
  expect(clicked).toHaveBeenCalledWith(url);
  fireEvent.click(await screen.findByRole('button', { name: 'Copy quote', exact: true }));
  expect(copyToClipboard).toHaveBeenLastCalledWith(`${path} and ${path}`);
});
