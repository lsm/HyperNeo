import { describe, expect, it } from 'bun:test';
import {
  decideSelfEchoFilter,
  resolveFilteredLogins,
} from '../../../../src/lib/external-events/github/github-self-echo';

describe('decideSelfEchoFilter', () => {
  it('drops an actor that exactly matches a filtered login', () => {
    expect(
      decideSelfEchoFilter({
        actorLogin: 'alice',
        filteredLogins: ['alice'],
        enabled: true,
      })
    ).toBe('drop');
  });

  it('admits an actor that is not in the filtered list', () => {
    expect(
      decideSelfEchoFilter({
        actorLogin: 'alice',
        filteredLogins: ['bob'],
        enabled: true,
      })
    ).toBe('admit');
  });

  it('matches filtered logins case-insensitively', () => {
    expect(
      decideSelfEchoFilter({
        actorLogin: 'Alice',
        filteredLogins: ['alice'],
        enabled: true,
      })
    ).toBe('drop');
    expect(
      decideSelfEchoFilter({
        actorLogin: 'alice',
        filteredLogins: ['ALICE'],
        enabled: true,
      })
    ).toBe('drop');
  });

  it('admits an empty login against an empty filtered list', () => {
    expect(
      decideSelfEchoFilter({
        actorLogin: '',
        filteredLogins: [],
        enabled: true,
      })
    ).toBe('admit');
  });

  it('admits when disabled, even if the actor matches', () => {
    expect(
      decideSelfEchoFilter({
        actorLogin: 'alice',
        filteredLogins: ['alice'],
        enabled: false,
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
