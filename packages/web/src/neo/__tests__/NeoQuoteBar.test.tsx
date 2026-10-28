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
  expect(bar.querySelector('.neo-quote-copy')).toBeNull();
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
    <NeoQuoteBar
      author="Neo"
      excerpt={'![a">b](https://example.com/x.png)'}
      onOpen={() => {}}
    />
  );
  const bar = app.container.querySelector('[data-quote-bar]') as HTMLElement;
  await waitFor(() => expect(bar.querySelector('[data-demoted-link]')).not.toBeNull());
  expect(bar.querySelector('a')).toBeNull();
  expect(bar.textContent ?? '').not.toContain('b">');
});

it('keeps the missing-original placeholder as plain italic text', () => {
  const app = render(<NeoQuoteBar author="Neo" onOpen={() => {}} />);
  const bar = app.container.querySelector('[data-quote-bar]') as HTMLElement;
  expect(bar.querySelector('strong')).toBeNull();
  expect(bar.textContent).toContain('Original message unavailable');
});
