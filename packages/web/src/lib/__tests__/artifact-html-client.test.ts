import type { MessageHub } from '@hyperneo/shared';
import type { ArtifactFileMetadata } from '@hyperneo/shared/types/artifact-file';
import { describe, expect, it, vi } from 'vitest';
import { readArtifactHtml } from '../artifact-html-client.ts';

const metadata = {
  artifact: { artifactId: 'a1', kind: 'html', byteLength: 10 },
  sha256: 'a'.repeat(64),
} as ArtifactFileMetadata;
const prepared = {
  accepted: true,
  sha256: metadata.sha256,
  document: '<!doctype html><html><body>Safe</body></html>',
  scriptsRemoved: true,
  links: [{ text: 'Docs', href: 'https://example.com' }],
};
function hub(replies: unknown[]) {
  const request = vi.fn(async () => replies.shift());
  return { hub: { request } as unknown as MessageHub, request };
}

describe('readArtifactHtml', () => {
  it('uses the registered authorized HTML operation and pairs it to the saved hash', async () => {
    const { hub: h, request } = hub([prepared]);
    expect(await readArtifactHtml(h, metadata)).toEqual({
      state: 'ready',
      metadata,
      html: prepared,
      text: '',
    });
    expect(request.mock.calls).toHaveLength(1);
    expect(request).toHaveBeenCalledWith('operation.invoke', {
      name: 'artifact.file.html',
      input: { artifactId: 'a1' },
    });
  });

  it.each([
    { ...prepared, sha256: 'b'.repeat(64) },
    { ...prepared, links: 'bad' },
    { ...prepared, document: null },
    { ...prepared, scriptsRemoved: 'no' },
  ])('does not mount a malformed or mismatched document', async (result) => {
    expect(await readArtifactHtml(hub([result]).hub, metadata)).toEqual({ state: 'revoked' });
  });

  it('preserves source access when sanitization hits its depth limit', async () => {
    expect(
      await readArtifactHtml(hub([{ accepted: false, reason: 'size_limit' }]).hub, metadata)
    ).toEqual({ state: 'html_source', metadata });
  });

  it('maps access revocation without returning any document', async () => {
    expect(
      await readArtifactHtml(hub([{ accepted: false, reason: 'unavailable' }]).hub, metadata)
    ).toEqual({ state: 'revoked' });
  });
});
