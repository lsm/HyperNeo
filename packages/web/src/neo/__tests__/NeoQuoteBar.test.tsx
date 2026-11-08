import { cleanup, render, waitFor } from '@testing-library/preact';
import { afterEach, expect, it } from 'vitest';
import { NeoQuoteBar } from '../NeoQuoteBar.tsx';

afterEach(cleanup);

it('renders excerpt markdown in the tappable bar without nested links', async () => {
  const app = render(
    <NeoQuoteBar
      author="Neo"
      excerpt={'Quoted **bold** and `code` plus [the doc](https://example.com)'}
      onOpen={() => {}}
    />
  );
  const bar = app.container.querySelector('[data-quote-bar]') as HTMLElement;
  await waitFor(() => expect(bar.querySelector('strong')?.textContent).toBe('bold'));
  expect(bar.querySelector('code')?.textContent).toBe('code');
  expect(bar.textContent).toContain('the doc');
  expect(bar.textContent).not.toContain('**');
  expect(bar.querySelector('a')).toBeNull();
  expect(bar.querySelector('[data-demoted-link]')?.textContent).toBe('the doc');
  expect(bar.querySelector('.copy-button')).toBeNull();
});

it('renders real anchors in the static bar', async () => {
  const app = render(<NeoQuoteBar author="Neo" excerpt={'See [the doc](https://example.com)'} />);
  const bar = app.container.querySelector('[data-quote-bar]') as HTMLElement;
  await waitFor(() =>
    expect(bar.querySelector('a')?.getAttribute('href')).toBe('https://example.com')
  );
});

it('renders no nested buttons when the excerpt contains a code block', async () => {
  const app = render(
    <NeoQuoteBar
      author="Neo"
      excerpt={'Here is code:\n\n```ts\nconst x = 1;\n```'}
      onOpen={() => {}}
    />
  );
  const bar = app.container.querySelector('[data-quote-bar]') as HTMLElement;
  await waitFor(() => expect(bar.querySelector('code')?.textContent).toContain('const x'));
  expect(bar.querySelector('button')).toBeNull();
  expect(bar.querySelector('.code-block-wrapper')).toBeNull();
});

it('demotes image links whose alt text contains a > without leaking attribute text', async () => {
  const app = render(
    <NeoQuoteBar author="Neo" excerpt={'![a">b](https://example.com/x.png)'} onOpen={() => {}} />
  );
  const bar = app.container.querySelector('[data-quote-bar]') as HTMLElement;
  await waitFor(() => expect(bar.querySelector('[data-demoted-link]')).not.toBeNull());
  expect(bar.querySelector('a')).toBeNull();
  expect(bar.textContent ?? '').not.toContain('b">');
});

it('shows the new excerpt immediately when the quoted message changes', async () => {
  const app = render(<NeoQuoteBar author="Neo" excerpt={'**boldA**'} onOpen={() => {}} />);
  const bar = app.container.querySelector('[data-quote-bar]') as HTMLElement;
  await waitFor(() => expect(bar.querySelector('strong')?.textContent).toBe('boldA'));
  app.rerender(<NeoQuoteBar author="Neo" excerpt={'plainB'} onOpen={() => {}} />);
  expect(bar.textContent).toContain('plainB');
  expect(bar.textContent).not.toContain('boldA');
});

it('keeps the missing-original placeholder as plain italic text', () => {
  const app = render(<NeoQuoteBar author="Neo" onOpen={() => {}} />);
  const bar = app.container.querySelector('[data-quote-bar]') as HTMLElement;
  expect(bar.querySelector('strong')).toBeNull();
  expect(bar.textContent).toContain('Original message unavailable');
});

it('keeps ready markdown on the first render after a quote remount', async () => {
  const excerpt = '**History**\n' + 'Synthetic history line\n'.repeat(8);
  const first = render(<NeoQuoteBar author="You" excerpt={excerpt} onOpen={() => {}} />);
  await waitFor(() => expect(first.container.querySelector('strong')?.textContent).toBe('History'));
  first.unmount();
  const replacement = render(<NeoQuoteBar author="You" excerpt={excerpt} onOpen={() => {}} />);
  expect(replacement.container.querySelector('strong')?.textContent).toBe('History');
  expect(replacement.container.querySelector('.neo-quote-excerpt')).not.toBeNull();
});
