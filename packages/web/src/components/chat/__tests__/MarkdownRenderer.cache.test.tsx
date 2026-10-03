import { render, waitFor } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';

const compiles = vi.hoisted(() => ({ count: 0 }));

vi.mock('rehype-stringify', async (importOriginal) => {
  const original = (await importOriginal<typeof import('rehype-stringify')>()).default;
  function countingRehypeStringify(this: { compiler: unknown }, ...args: unknown[]) {
    (original as (...a: unknown[]) => void).apply(this, args);
    const compiler = this.compiler as (...a: unknown[]) => unknown;
    this.compiler = (...compilerArgs: unknown[]) => {
      compiles.count += 1;
      return compiler(...compilerArgs);
    };
  }
  return { default: countingRehypeStringify };
});

import MarkdownRenderer from '../MarkdownRenderer';

describe('MarkdownRenderer render cache', () => {
  it('renders identical content once and serves remounts from the cache', async () => {
    const content = 'Cached **markdown** body';
    const first = render(<MarkdownRenderer content={content} />);
    await waitFor(() =>
      expect(first.container.querySelector('strong')?.textContent).toBe('markdown')
    );
    expect(compiles.count).toBe(1);
    first.unmount();

    const second = render(<MarkdownRenderer content={content} />);
    expect(second.container.querySelector('strong')?.textContent).toBe('markdown');
    expect(compiles.count).toBe(1);

    const other = render(<MarkdownRenderer content="Different *text*" />);
    await waitFor(() => expect(other.container.querySelector('em')?.textContent).toBe('text'));
    expect(compiles.count).toBe(2);
  });
});
