import type { MessageHub } from '@hyperneo/shared';
import { describe, expect, it, vi } from 'vitest';
import { resolveArtifactReference } from '../artifact-reference-client.ts';

const source = { kind: 'publication' as const, id: 'p1', revisionId: 'r1' };
const pr = {
  url: 'https://github.com/acme/demo/pull/7',
  repository: 'github.com/acme/demo',
  number: 7,
  title: 'Synthetic PR',
  body: 'Body',
  state: 'OPEN' as const,
  headSha: 'a'.repeat(40),
  checks: 'passing' as const,
  review: 'none' as const,
  changedFiles: 1,
  files: [{ path: 'docs/a.md', additions: 1, deletions: 0 }],
  filesTruncated: false,
};

function hub(reply: unknown) {
  const request = vi.fn(async (..._args: unknown[]) => {
    if (reply instanceof Error) throw reply;
    return reply;
  });
  return { hub: { request } as unknown as MessageHub, request };
}

describe('resolveArtifactReference', () => {
  it('asks the daemon to resolve the exact stored reference', async () => {
    const { hub: h, request } = hub({ accepted: true, artifact: { artifactId: 'a1' } });
    const file = { path: 'docs/a.md', headSha: 'a'.repeat(40) };
    expect(await resolveArtifactReference(h, { source, reference: pr.url, file })).toEqual({
      kind: 'artifact',
      artifactId: 'a1',
    });
    expect(request.mock.calls[0][1]).toEqual({
      name: 'artifact.reference.resolve',
      input: {
        sourceMessageOrCard: source,
        reference: pr.url,
        file,
        requestId: expect.any(String),
      },
    });
  });

  it('keeps one retry ID for the same tap but gives a new tap its own identity', async () => {
    const { hub: h, request } = hub({ accepted: true, artifact: { artifactId: 'a1' } });
    const target = { source, reference: 'docs/a.md' };
    await resolveArtifactReference(h, target);
    await resolveArtifactReference(h, target);
    const first = request.mock.calls[0][1] as { input: { requestId: string } };
    const retry = request.mock.calls[1][1] as { input: { requestId: string } };
    expect(first.input.requestId).toMatch(/^[a-f0-9-]{36}$/);
    expect(retry.input.requestId).toBe(first.input.requestId);
    await resolveArtifactReference(h, { ...target });
    const next = request.mock.calls[2][1] as { input: { requestId: string } };
    expect(next.input.requestId).not.toBe(first.input.requestId);
  });

  it('returns a PR summary for a PR link', async () => {
    expect(
      await resolveArtifactReference(hub({ accepted: true, pr }).hub, { source, reference: pr.url })
    ).toEqual({ kind: 'pr', pr });
  });

  it('offers the authorized contexts when the reference is ambiguous', async () => {
    const choices = [
      { kind: 'todo', id: 't1' },
      { kind: 'ask', id: 'a1' },
    ];
    const result = await resolveArtifactReference(
      hub({ accepted: false, reason: 'ambiguous_context', choices }).hub,
      { source, reference: 'docs/a.md' }
    );
    expect(result).toEqual({ kind: 'choices', choices });
  });

  it.each([
    [{ accepted: false, reason: 'sensitive_path' }, 'forbidden'],
    [{ accepted: false, reason: 'size_limit', actualBytes: 9, limitBytes: 1 }, 'limit'],
    [{ accepted: false, reason: 'owning_daemon_unavailable' }, 'daemon_unavailable'],
    [{ accepted: false, reason: 'unavailable' }, 'revoked'],
    [new Error('socket closed'), 'daemon_unavailable'],
    [Object.assign(new Error('Unknown operation'), { code: 'METHOD_NOT_FOUND' }), 'needs_update'],
  ])('shows %j as the %s state', async (reply, state) => {
    expect(
      await resolveArtifactReference(hub(reply).hub, { source, reference: 'docs/a.md' })
    ).toEqual({ kind: 'state', state });
  });
});
