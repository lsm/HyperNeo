// @ts-nocheck
import { cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import { SectionCard } from '../SectionCard';

describe('SectionCard', () => {
  afterEach(() => cleanup());

  it('renders the uppercase label heading and body', () => {
    const { container } = render(
      <SectionCard title="Details">
        <p>body content</p>
      </SectionCard>
    );
    const heading = container.querySelector('h3');
    expect(heading?.textContent).toBe('Details');
    expect(heading.className).toContain('uppercase');
    expect(container.textContent).toContain('body content');
  });

  it('omits the body wrapper when there are no children', () => {
    const { container } = render(<SectionCard title="Empty" />);
    expect(container.querySelector('.mt-3')).toBeNull();
  });
});
