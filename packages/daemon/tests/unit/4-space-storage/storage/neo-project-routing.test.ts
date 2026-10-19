import { describe, expect, test } from 'bun:test';
import { neoRepoAlias } from '../../../../src/lib/neo/project-route-facts.ts';

describe('neoRepoAlias', () => {
  test('normalizes GitHub remote links without making them code identities', () => {
    expect(neoRepoAlias('git@github.com:LSM/HyperNeo.git')).toBe('repo:lsm/hyperneo\u0000');
    expect(neoRepoAlias('https://github.com/lsm/HyperNeo.git')).toBe('repo:lsm/hyperneo\u0000');
    expect(neoRepoAlias('/local/repo')).toBeNull();
  });
});
