import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const source = (path: string) => readFileSync(new URL(`../../../../src/lib/${path}`, import.meta.url), 'utf8');

describe('coding project identity boundary', () => {
  test('core persists opaque identity candidates without repository policy', () => {
    const mirror = source('neo/project-mirror.ts');
    expect(mirror).not.toContain('neoRepositoryIdentity');
    expect(mirror).not.toContain("alias.startsWith('repo:");
    expect(mirror).not.toContain("alias.startsWith('repository:");
    expect(mirror).toContain('persistNeoWorkspaceProjects');
    expect(source('neo/packs/coding/project-mirror.ts')).toContain('backfillNeoRepositoryIdentities');
  });

  test('cleanup consumes protection facts without interpreting repository aliases', () => {
    const cleanup = source('neo/project-cleanup.ts');
    expect(cleanup).not.toContain("alias.startsWith('repo:");
    expect(cleanup).not.toContain("alias.startsWith('repository:");
    expect(source('neo/packs/coding/project-cleanup.ts')).toContain('repository:');
  });
});
