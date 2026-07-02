/**
 * Unit tests for ChannelResolver
 *
 * Covers:
 *   - canSend() by node name
 *   - getPermittedTargets() results
 *   - getChannels() accessor
 *   - isEmpty() for empty/non-empty topology
 */

import { describe, test, expect } from 'bun:test';
import { ChannelResolver } from '../../../../src/lib/space/runtime/channel-resolver.ts';
import type { WorkflowChannel } from '@hyperneo/shared';

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

function ch(from: string, to: string | string[], gateId?: string): WorkflowChannel {
  return { id: `ch-${from}-${Array.isArray(to) ? to.join('-') : to}`, from, to, gateId };
}

// ===========================================================================
// isEmpty / getChannels
// ===========================================================================

describe('ChannelResolver.isEmpty', () => {
  test('returns true when no channels declared', () => {
    const resolver = new ChannelResolver([]);
    expect(resolver.isEmpty()).toBe(true);
  });

  test('returns false when channels are declared', () => {
    const resolver = new ChannelResolver([ch('Code', 'Review')]);
    expect(resolver.isEmpty()).toBe(false);
  });
});

describe('ChannelResolver.getChannels', () => {
  test('returns a copy of the channels array', () => {
    const channels = [ch('Code', 'Review'), ch('Review', 'Code')];
    const resolver = new ChannelResolver(channels);
    const result = resolver.getChannels();
    expect(result).toHaveLength(2);
    // It's a shallow copy — mutations don't affect the resolver
    result.splice(0);
    expect(resolver.getChannels()).toHaveLength(2);
  });
});

// ===========================================================================
// canSend()
// ===========================================================================

describe('ChannelResolver.canSend', () => {
  test('returns true when a matching channel exists', () => {
    const resolver = new ChannelResolver([ch('Code', 'Review')]);
    expect(resolver.canSend('Code', 'Review')).toBe(true);
  });

  test('returns false when no channels declared', () => {
    const resolver = new ChannelResolver([]);
    expect(resolver.canSend('Code', 'Review')).toBe(false);
  });

  test('returns false in the reverse direction for a one-way channel', () => {
    const resolver = new ChannelResolver([ch('Code', 'Review')]);
    expect(resolver.canSend('Review', 'Code')).toBe(false);
  });

  test('both directions work when two one-way channels declared', () => {
    const resolver = new ChannelResolver([ch('Code', 'Review'), ch('Review', 'Code')]);
    expect(resolver.canSend('Code', 'Review')).toBe(true);
    expect(resolver.canSend('Review', 'Code')).toBe(true);
  });

  test('wildcard from matches any sender', () => {
    const resolver = new ChannelResolver([ch('*', 'Review')]);
    expect(resolver.canSend('Code', 'Review')).toBe(true);
    expect(resolver.canSend('QA', 'Review')).toBe(true);
  });

  test('fan-out channel matches each target', () => {
    const resolver = new ChannelResolver([ch('Code', ['Review', 'QA'])]);
    expect(resolver.canSend('Code', 'Review')).toBe(true);
    expect(resolver.canSend('Code', 'QA')).toBe(true);
    expect(resolver.canSend('Review', 'Code')).toBe(false);
  });

  test('wildcard to matches any target', () => {
    const resolver = new ChannelResolver([ch('Code', '*')]);
    expect(resolver.canSend('Code', 'Review')).toBe(true);
    expect(resolver.canSend('Code', 'Anything')).toBe(true);
    expect(resolver.canSend('Review', 'Code')).toBe(false);
  });

  test('channel with gate is still matched by canSend', () => {
    const resolver = new ChannelResolver([ch('Code', 'Review', 'my-gate')]);
    expect(resolver.canSend('Code', 'Review')).toBe(true);
  });
});

// ===========================================================================
// getPermittedTargets()
// ===========================================================================

describe('ChannelResolver.getPermittedTargets', () => {
  test('returns empty array when no channels declared', () => {
    const resolver = new ChannelResolver([]);
    expect(resolver.getPermittedTargets('Code')).toEqual([]);
  });

  test('returns target for a simple channel', () => {
    const resolver = new ChannelResolver([ch('Code', 'Review')]);
    expect(resolver.getPermittedTargets('Code')).toEqual(['Review']);
  });

  test('returns multiple targets for fan-out channel', () => {
    const resolver = new ChannelResolver([ch('Code', ['Review', 'QA'])]);
    const targets = resolver.getPermittedTargets('Code');
    expect(targets).toContain('Review');
    expect(targets).toContain('QA');
  });

  test('deduplicates targets across multiple channels to same node', () => {
    const resolver = new ChannelResolver([ch('Code', 'Review'), ch('Code', 'Review')]);
    expect(resolver.getPermittedTargets('Code')).toHaveLength(1);
    expect(resolver.getPermittedTargets('Code')[0]).toBe('Review');
  });

  test('returns empty for node with no outbound channels', () => {
    const resolver = new ChannelResolver([ch('Code', 'Review')]);
    expect(resolver.getPermittedTargets('Review')).toEqual([]);
  });
});
