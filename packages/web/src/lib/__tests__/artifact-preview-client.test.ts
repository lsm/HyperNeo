import type { MessageHub } from '@hyperneo/shared';
import type { ArtifactFileMetadata } from '@hyperneo/shared/types/artifact-file';
import { describe, expect, it, vi } from 'vitest';
import { previewStateForRefusal, readArtifactPreview } from '../artifact-preview-client.ts';

const base64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

function metadata(kind: 'markdown' | 'html' = 'markdown', byteLength = 11): ArtifactFileMetadata {
  return {
    context: { kind: 'todo', id: 'todo-1' },
    artifact: { daemonId: 'd1', artifactId: 'a1', title: 'Report', kind, byteLength },
    sha256: 'f'.repeat(64),
    createdAt: 1,
    sourcePath: '/synthetic/report.md',
    producer: { adapter: 'hyperneo', id: 's1' },
    revision: { kind: 'worktree' },
  };
}

function hub(replies: Array<unknown | Error>) {
  const request = vi.fn(async (..._args: unknown[]) => {
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    return reply;
  });
  return { hub: { request } as unknown as MessageHub, request };
}

const read = (text: string, nextOffset: number, complete: boolean) => ({
  accepted: true,
  data: base64(text),
  nextOffset,
  byteLength: 11,
  sha256: 'f'.repeat(64),
  complete,
});

describe('readArtifactPreview', () => {
  it('reads every chunk of a Markdown snapshot into one text', async () => {
    const { hub: h, request } = hub([
      { accepted: true, metadata: metadata() },
      read('# Hé', 5, false),
      read('llo', 11, true),
    ]);
    expect(await readArtifactPreview(h, 'a1')).toEqual({
      state: 'ready',
      metadata: metadata(),
      text: '# Héllo',
    });
    expect(request.mock.calls.map((call) => call[1])).toEqual([
      { name: 'artifact.file.get', input: { artifactId: 'a1' } },
      { name: 'artifact.file.read', input: { artifactId: 'a1', offset: 0, maxBytes: 262144 } },
      { name: 'artifact.file.read', input: { artifactId: 'a1', offset: 5, maxBytes: 262144 } },
    ]);
  });

  it('stops at the preview limit without reading bytes', async () => {
    const big = metadata('markdown', 2 * 1024 * 1024 + 1);
    const { hub: h, request } = hub([{ accepted: true, metadata: big }]);
    expect(await readArtifactPreview(h, 'a1')).toEqual({ state: 'limit', metadata: big });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('shows formats this shell cannot preview yet as unsupported', async () => {
    const { hub: h } = hub([{ accepted: true, metadata: metadata('html') }]);
    expect(await readArtifactPreview(h, 'a1')).toEqual({
      state: 'unsupported',
      metadata: metadata('html'),
    });
  });

  it('treats an unavailable artifact, before or during the read, as revoked access', async () => {
    expect(
      await readArtifactPreview(hub([{ accepted: false, reason: 'unavailable' }]).hub, 'a1')
    ).toEqual({ state: 'revoked' });
    const midway = hub([
      { accepted: true, metadata: metadata() },
      read('# He', 4, false),
      { accepted: false, reason: 'unavailable' },
    ]);
    expect(await readArtifactPreview(midway.hub, 'a1')).toEqual({ state: 'revoked' });
  });

  it('asks for an updated daemon when the daemon has no artifact operations', async () => {
    const unknown = Object.assign(new Error('Unknown operation'), { code: 'METHOD_NOT_FOUND' });
    expect(await readArtifactPreview(hub([unknown]).hub, 'a1')).toEqual({ state: 'needs_update' });
  });

  it('reports a failed daemon request as an unavailable daemon', async () => {
    expect(await readArtifactPreview(hub([new Error('socket closed')]).hub, 'a1')).toEqual({
      state: 'daemon_unavailable',
    });
  });
});

describe('previewStateForRefusal', () => {
  it.each([
    ['outside_roots', 'forbidden'],
    ['sensitive_path', 'forbidden'],
    ['unsafe_path', 'forbidden'],
    ['size_limit', 'limit'],
    ['unsupported_type', 'unsupported'],
    ['owning_daemon_unavailable', 'daemon_unavailable'],
    ['safe_open_unavailable', 'daemon_unavailable'],
    ['unavailable', 'revoked'],
    ['source_changed', 'revoked'],
  ])('maps %s to the %s state', (reason, state) => {
    expect(previewStateForRefusal(reason)).toBe(state);
  });
});
