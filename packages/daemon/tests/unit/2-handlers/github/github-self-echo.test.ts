import { describe, expect, it } from 'bun:test';
import {
  decideSelfEchoFilter,
  decideSelfEchoGate,
  resolveFilteredLogins,
} from '../../../../src/lib/external-events/github/github-self-echo';

describe('decideSelfEchoFilter', () => {
  it('drops an initiator that exactly matches a filtered login', () => {
    expect(
      decideSelfEchoFilter({
        initiatorLogin: 'alice',
        filteredLogins: ['alice'],
        enabled: true,
      })
    ).toBe('drop');
  });

  it('admits an initiator that is not in the filtered list', () => {
    expect(
      decideSelfEchoFilter({
        initiatorLogin: 'alice',
        filteredLogins: ['bob'],
        enabled: true,
      })
    ).toBe('admit');
  });

  it('matches filtered logins case-insensitively', () => {
    expect(
      decideSelfEchoFilter({
        initiatorLogin: 'Alice',
        filteredLogins: ['alice'],
        enabled: true,
      })
    ).toBe('drop');
    expect(
      decideSelfEchoFilter({
        initiatorLogin: 'alice',
        filteredLogins: ['ALICE'],
        enabled: true,
      })
    ).toBe('drop');
  });

  it('admits an empty or unknown initiator regardless of the filtered list', () => {
    expect(
      decideSelfEchoFilter({
        initiatorLogin: '',
        filteredLogins: [],
        enabled: true,
      })
    ).toBe('admit');
    expect(
      decideSelfEchoFilter({
        initiatorLogin: '',
        filteredLogins: ['alice'],
        enabled: true,
      })
    ).toBe('admit');
  });

  it('admits when disabled, even if the initiator matches', () => {
    expect(
      decideSelfEchoFilter({
        initiatorLogin: 'alice',
        filteredLogins: ['alice'],
        enabled: false,
      })
    ).toBe('admit');
  });
});

describe('decideSelfEchoGate', () => {
  it('drops an initiator matching the filtered login when enabled', () => {
    expect(
      decideSelfEchoGate({
        initiatorLogin: 'alice',
        filteredLogins: ['alice'],
        filterCurrentUser: true,
      })
    ).toBe('drop');
  });

  it('admits an initiator not in the filtered list when enabled', () => {
    expect(
      decideSelfEchoGate({
        initiatorLogin: 'alice',
        filteredLogins: ['bob'],
        filterCurrentUser: true,
      })
    ).toBe('admit');
  });

  it('admits when disabled even if the initiator matches', () => {
    expect(
      decideSelfEchoGate({
        initiatorLogin: 'alice',
        filteredLogins: ['alice'],
        filterCurrentUser: false,
      })
    ).toBe('admit');
  });
});

describe('resolveFilteredLogins', () => {
  it('returns the token login when filtering the current user is enabled', () => {
    expect(
      resolveFilteredLogins({
        filterCurrentUser: true,
        tokenLogin: 'alice',
      })
    ).toEqual(['alice']);
  });

  it('returns an empty array when filtering the current user is disabled', () => {
    expect(
      resolveFilteredLogins({
        filterCurrentUser: false,
        tokenLogin: 'alice',
      })
    ).toEqual([]);
  });

  it('returns an empty array when the token login is empty', () => {
    expect(
      resolveFilteredLogins({
        filterCurrentUser: true,
        tokenLogin: '',
      })
    ).toEqual([]);
  });
});
