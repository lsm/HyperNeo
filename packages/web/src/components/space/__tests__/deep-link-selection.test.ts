import type { SpaceAgent } from '@hyperneo/shared';
import { describe, expect, it } from 'vitest';
import {
  decideDeepLink,
  deepLinkKey,
  type DeepLinkInput,
  type DeepLinkState,
  matchesSelectedHandle,
  findLinkTarget,
  gateHandlePresent,
  gateNotYetApplied,
  gateTargetPresent,
  type LinkedRequest,
  type MatchedRequest,
} from '../deep-link-selection';

const agent = (id: string, handle: string, spaceId = 'space-1') =>
  ({ id, handle, spaceId }) as SpaceAgent;

const state = (overrides: Partial<DeepLinkState> = {}): DeepLinkState => ({
  appliedLink: null,
  appliedAgentId: null,
  handledLink: null,
  selectedId: null,
  ...overrides,
});

const input = (overrides: Partial<DeepLinkInput> = {}): DeepLinkInput => ({
  spaceId: 'space-1',
  selectedHandle: 'alpha',
  agents: [agent('a1', 'alpha')],
  state: state(),
  ...overrides,
});

const KEY = deepLinkKey('space-1', 'alpha') as string;

describe('matchesSelectedHandle', () => {
  it('matches an exact handle', () => {
    expect(matchesSelectedHandle(agent('a1', 'alpha'), 'alpha')).toBe(true);
  });

  it('treats coordinator as an alias for the space manager', () => {
    expect(matchesSelectedHandle(agent('m', 'space-manager'), 'coordinator')).toBe(true);
  });

  it('does not alias an unrelated handle', () => {
    expect(matchesSelectedHandle(agent('a1', 'alpha'), 'coordinator')).toBe(false);
  });
});

describe('findLinkTarget', () => {
  it('ignores an agent belonging to another space', () => {
    expect(findLinkTarget(input({ agents: [agent('a1', 'alpha', 'space-9')] }))).toBeNull();
  });

  it('returns null when no handle is selected', () => {
    expect(findLinkTarget(input({ selectedHandle: null }))).toBeNull();
  });
});

describe('decideDeepLink', () => {
  it('forgets everything when there is no handle', () => {
    expect(decideDeepLink(input({ selectedHandle: null }))).toEqual({ kind: 'forget' });
  });

  it('applies a fresh match', () => {
    expect(decideDeepLink(input())).toEqual({ kind: 'apply', link: KEY, agentId: 'a1' });
  });

  it('stays idle once the same agent is applied', () => {
    const decision = decideDeepLink(
      input({ state: state({ appliedLink: KEY, appliedAgentId: 'a1', handledLink: KEY }) })
    );
    expect(decision).toEqual({ kind: 'idle' });
  });

  it('reapplies when the link resolves to a different agent', () => {
    const decision = decideDeepLink(
      input({
        agents: [agent('a2', 'alpha')],
        state: state({ appliedLink: KEY, appliedAgentId: 'a1', handledLink: KEY }),
      })
    );
    expect(decision).toEqual({ kind: 'apply', link: KEY, agentId: 'a2' });
  });

  it('clears once when the handle matches nothing', () => {
    expect(decideDeepLink(input({ agents: [] }))).toEqual({
      kind: 'clear',
      link: KEY,
      clearSelection: true,
    });
  });

  it('clears the selection when the applied agent disappears', () => {
    const decision = decideDeepLink(
      input({
        agents: [],
        state: state({
          appliedLink: KEY,
          appliedAgentId: 'a1',
          handledLink: KEY,
          selectedId: 'a1',
        }),
      })
    );
    expect(decision).toEqual({ kind: 'clear', link: KEY, clearSelection: true });
  });

  it('clears the selection when navigating to a different unmatched handle', () => {
    const decision = decideDeepLink(
      input({
        selectedHandle: 'ghost',
        agents: [agent('other', 'other')],
        state: state({
          appliedLink: KEY,
          appliedAgentId: 'a1',
          handledLink: KEY,
          selectedId: 'other',
        }),
      })
    );
    expect(decision).toEqual({
      kind: 'clear',
      link: deepLinkKey('space-1', 'ghost') as string,
      clearSelection: true,
    });
  });

  it('clears the selection when an unmatched link arrives from no link at all', () => {
    const decision = decideDeepLink(
      input({
        selectedHandle: 'ghost',
        agents: [agent('other', 'other')],
        state: state({ selectedId: 'other' }),
      })
    );
    expect(decision).toEqual({
      kind: 'clear',
      link: deepLinkKey('space-1', 'ghost') as string,
      clearSelection: true,
    });
  });

  it('keeps an unrelated manual selection when the applied agent disappears', () => {
    const decision = decideDeepLink(
      input({
        agents: [agent('other', 'other')],
        state: state({
          appliedLink: KEY,
          appliedAgentId: 'a1',
          handledLink: KEY,
          selectedId: 'other',
        }),
      })
    );
    expect(decision).toEqual({ kind: 'clear', link: KEY, clearSelection: false });
  });

  it('stays idle on later list changes while still unmatched', () => {
    const decision = decideDeepLink(
      input({ agents: [agent('z', 'zeta')], state: state({ handledLink: KEY }) })
    );
    expect(decision).toEqual({ kind: 'idle' });
  });

  it('treats a different space as a different link', () => {
    const decision = decideDeepLink(
      input({
        spaceId: 'space-2',
        agents: [agent('b1', 'alpha', 'space-2')],
        state: state({ appliedLink: KEY, appliedAgentId: 'a1', handledLink: KEY }),
      })
    );
    expect(decision).toEqual({
      kind: 'apply',
      link: deepLinkKey('space-2', 'alpha') as string,
      agentId: 'b1',
    });
  });
});

describe('gateHandlePresent', () => {
  it.each([
    ['a handle is selected', 'alpha', 'value'],
    ['no handle is selected', null, 'reason'],
    ['the handle is an empty string', '', 'reason'],
  ])('yields a %s arm when %s', (_label, handle, arm) => {
    const outcome = gateHandlePresent(input({ selectedHandle: handle as string | null }));
    expect(arm in outcome).toBe(true);
    if ('reason' in outcome) expect(outcome.reason).toEqual({ kind: 'forget' });
    else expect(outcome.value.link).toBe(deepLinkKey('space-1', handle as string));
  });
});

describe('gateTargetPresent', () => {
  const linked = (overrides: Partial<DeepLinkState> = {}, agents = [agent('a1', 'alpha')]) =>
    ({ input: input({ agents, state: state(overrides) }), link: KEY }) as LinkedRequest;

  it.each([
    ['a match exists', {}, [agent('a1', 'alpha')], 'value', undefined],
    ['nothing matches and nothing was handled', {}, [], 'reason', 'clear'],
    [
      'the same unmatched link was already cleared',
      { handledLink: KEY, appliedLink: null },
      [],
      'reason',
      'idle',
    ],
    [
      'the applied agent vanished',
      { handledLink: KEY, appliedLink: KEY, appliedAgentId: 'a1', selectedId: 'a1' },
      [],
      'reason',
      'clear',
    ],
  ])('yields %s', (_label, st, agents, arm, kind) => {
    const outcome = gateTargetPresent(linked(st as Partial<DeepLinkState>, agents as never));
    expect(arm in outcome).toBe(true);
    if ('reason' in outcome) expect(outcome.reason.kind).toBe(kind);
  });
});

describe('gateNotYetApplied', () => {
  const matched = (overrides: Partial<DeepLinkState> = {}) =>
    ({
      input: input({ state: state(overrides) }),
      link: KEY,
      target: agent('a1', 'alpha'),
    }) as MatchedRequest;

  it.each([
    ['nothing applied yet', {}, 'value'],
    ['a different link is applied', { appliedLink: 'other', appliedAgentId: 'a1' }, 'value'],
    [
      'the same link resolved to another agent',
      { appliedLink: KEY, appliedAgentId: 'zz' },
      'value',
    ],
    ['the same link and agent are applied', { appliedLink: KEY, appliedAgentId: 'a1' }, 'reason'],
  ])('yields a %s arm when %s', (_label, st, arm) => {
    const outcome = gateNotYetApplied(matched(st as Partial<DeepLinkState>));
    expect(arm in outcome).toBe(true);
    if ('reason' in outcome) expect(outcome.reason).toEqual({ kind: 'idle' });
  });
});
