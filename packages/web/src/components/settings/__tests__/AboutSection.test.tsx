import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/preact';
import { AboutSection } from '../AboutSection.tsx';

describe('AboutSection', () => {
  afterEach(() => {
    cleanup();
  });

  it('links GitHub to the HyperNeo repository', () => {
    render(<AboutSection />);
    const link = screen.getByRole('link', { name: /GitHub/ });
    expect(link.getAttribute('href')).toBe('https://github.com/lsm/HyperNeo');
  });

  it('labels the Anthropic docs link as upstream documentation', () => {
    render(<AboutSection />);
    const link = screen.getByRole('link', { name: /Claude Agent SDK docs \(upstream\)/ });
    expect(link.getAttribute('href')).toBe('https://docs.anthropic.com');
    expect(link.textContent).toContain('Anthropic / Claude Agent SDK docs (upstream)');
  });
});
