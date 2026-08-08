import { render } from '@testing-library/preact';
import { describe, expect, it } from 'vitest';
import { ProviderLogo } from '../ProviderLogo.tsx';

describe('ProviderLogo', () => {
  it('renders the official DeepSeek mark instead of a monogram', () => {
    const { container } = render(<ProviderLogo provider="deepseek" class="h-4 w-4" />);
    const svg = container.querySelector('svg');

    expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(svg?.querySelector('path')?.getAttribute('d')).toContain('M23.748 4.651');
    expect(svg?.querySelector('text')).toBeNull();
  });
});
