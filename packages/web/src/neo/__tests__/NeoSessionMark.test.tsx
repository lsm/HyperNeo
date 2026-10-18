import { cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import { NeoSessionMark } from '../NeoCardParts.tsx';
import { neoSessionKind } from '../work-driver.ts';

afterEach(cleanup);

describe('neoSessionKind', () => {
  it('reads the session kind from the adapter first, then from the link', () => {
    expect(neoSessionKind('codex-desktop', 'claude://x')).toBe('codex');
    expect(neoSessionKind('space', null)).toBe('hyperneo');
    expect(neoSessionKind(null, 'claude://claude.ai/epitaxy/local_1')).toBe('claude');
    expect(neoSessionKind(null, 'https://claude.ai/code/session_1')).toBe('claude');
    expect(neoSessionKind(null, 'codex://threads/1')).toBe('codex');
    expect(neoSessionKind(null, 'ghapp://session/1')).toBe('copilot');
    expect(neoSessionKind(null, '/session/neo:1')).toBe('hyperneo');
    expect(neoSessionKind('opencode', 'https://example.com')).toBeNull();
  });
});

describe('NeoSessionMark', () => {
  it('draws the HyperNeo mark for HyperNeo and Neo sessions and nothing for unknown ones', () => {
    const { container, rerender } = render(<NeoSessionMark kind="hyperneo" />);
    expect(container.querySelectorAll('svg rect')).toHaveLength(3);
    rerender(<NeoSessionMark kind="claude" />);
    expect(container.querySelector('svg path')).toBeTruthy();
    rerender(<NeoSessionMark kind={null} />);
    expect(container.querySelector('svg')).toBeNull();
  });
});
