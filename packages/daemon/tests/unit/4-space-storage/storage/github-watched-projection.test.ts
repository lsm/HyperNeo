import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import type { GitHubWatchedRepo } from '../../../../src/lib/external-events/github/github-repository';
import { mappedWatchedRow } from '../../helpers/github-watched-read-fixture';

type Project = (repo: GitHubWatchedRepo) => Record<string, unknown>;
async function projection(): Promise<Project> {
  const file = new URL(
    '../../../../src/lib/external-events/github/github-watched-projection.ts',
    import.meta.url
  );
  if (!existsSync(file)) throw new Error('Saved GitHub watched projection is unavailable');
  return (await import(file.href)).projectGitHubWatchedRepo;
}
describe('saved GitHub watched repository projection', () => {
  test('saves every public watched field while masking secret and excluding Space identity/cursor', async () => {
    const project = await projection();
    const expected: Record<string, unknown> = { ...mappedWatchedRow, webhookSecret: 'configured' };
    delete expected.spaceId;
    delete expected.pollCursor;
    const projected = project(mappedWatchedRow);
    expect(projected).toEqual(expected);
    expect(JSON.stringify(projected)).not.toContain('synthetic-webhook-only');
    expect(JSON.stringify(projected)).not.toContain('synthetic-etag');
    expect(projected).not.toHaveProperty('spaceId');
    expect(projected).not.toHaveProperty('pollCursor');
  });
  test('preserves absent versus configured secret and nullable field values without mutating input', async () => {
    const project = await projection();
    for (const secret of [null, '', 'synthetic-webhook-only']) {
      const input = Object.freeze({
        ...mappedWatchedRow,
        webhookSecret: secret,
        webhookActive: null,
        webhookLastError: null,
        webhookRemoteId: null,
      });
      const before = JSON.stringify(input);
      expect(project(input)).toMatchObject({
        webhookSecret: secret ? 'configured' : null,
        webhookActive: null,
        webhookLastError: null,
        webhookRemoteId: null,
        enabled: true,
        pollingEnabled: true,
      });
      expect(JSON.stringify(input)).toEqual(before);
    }
  });
  test('omits private cursor data even when it cannot be accessed', async () => {
    const project = await projection();
    const input = { ...mappedWatchedRow };
    Object.defineProperty(input, 'pollCursor', {
      get() {
        throw new Error('private cursor must not be projected');
      },
    });
    const result = project(input);
    expect(result).not.toHaveProperty('pollCursor');
    expect(result).toMatchObject({
      id: 'synthetic-one',
      owner: 'OwnerZ',
      repo: 'repo-z',
      createdAt: 17,
      updatedAt: 18,
      webhookSecret: 'configured',
    });
  });
});
