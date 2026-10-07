import { describe, expect, it } from 'vitest';
import { nextChatDisplayMode, resolveChatDisplayMode } from '../chat-display-mode.ts';

describe('resolveChatDisplayMode', () => {
  it('prefers the session choice, then the default, then compact', () => {
    expect(resolveChatDisplayMode('full', 'compact')).toBe('full');
    expect(resolveChatDisplayMode(undefined, 'full')).toBe('full');
    expect(resolveChatDisplayMode(undefined, undefined)).toBe('compact');
  });

  it('keeps a minimal choice', () => {
    expect(resolveChatDisplayMode('minimal', 'full')).toBe('minimal');
  });
});

describe('nextChatDisplayMode', () => {
  it('cycles through the offered modes', () => {
    expect(nextChatDisplayMode('full')).toBe('compact');
    expect(nextChatDisplayMode('compact')).toBe('minimal');
    expect(nextChatDisplayMode('minimal')).toBe('full');
  });
});
