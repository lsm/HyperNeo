import { createHash, randomUUID } from 'node:crypto';
import { fstatSync, read, type BigIntStats } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import {
  matchingVideoType,
  VIDEO_HEADER_BYTES,
  videoExtension,
} from '@hyperneo/shared/types/video-container';
import { previewReferenceCandidates } from '@hyperneo/shared/types/artifact-reference';
import type { Database } from '../../storage/sqlite-compat.ts';
import { readPublicFileSource } from '../../storage/repositories/public-file-source.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import { isLocalUser } from '../operations/caller.ts';
import { withArtifactDescriptor } from '../runtime-artifact-open.ts';
import { resolveArtifactSource } from './file-policy.ts';
import { liveFileByteLimit, prepareLiveFileContent } from './live-file-content.ts';

const inputSchema = z
  .strictObject({
    sourceMessageOrCard: z.strictObject({
      kind: z.enum(['message', 'publication', 'todo', 'question']),
      id: z.string().min(1).max(200),
      revisionId: z.string().min(1).max(200).optional(),
    }),
    reference: z.string().min(1).max(4096),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
    maxBytes: z.number().int().min(1).max(262144).default(262144),
    version: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .refine(
    (input) => input.offset === 0 || !!input.version,
    'A continuation requires its file version'
  );
type Input = z.infer<typeof inputSchema>;
const refusal = (reason = 'forbidden') => ({ accepted: false as const, reason });
const readEpoch = randomUUID();
const fileVersion = (stat: BigIntStats) => {
  return createHash('sha256')
    .update(
      [readEpoch, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.nlink].join(':')
    )
    .digest('hex');
};

export function createLiveFileRead(
  database: () => Database,
  home = homedir(),
  readBytes = promisify(read)
) {
  function prepare(input: Input, caller: OperationCaller) {
    const source = readPublicFileSource(database(), input.sourceMessageOrCard, caller);
    const candidate = source?.text
      .flatMap(previewReferenceCandidates)
      .find((item) => item.reference === input.reference);
    if (!source || !candidate) return { reason: refusal() };
    if (source.owner.daemon) return { reason: refusal('owner_unavailable') };
    if (candidate.kind !== 'local') return { reason: refusal('unsupported_type') };
    const path = candidate.path.startsWith('~/')
      ? `${home}/${candidate.path.slice(2)}`
      : candidate.path;
    const checked = resolveArtifactSource(source, path, { home });
    if ('reason' in checked)
      return {
        reason: refusal(
          checked.reason.reason === 'ambiguous_context' ? 'owner_unavailable' : 'forbidden'
        ),
      };
    return { value: { ...checked.value, owner: source.owner } };
  }
  async function range(fd: number, offset: number, length: number) {
    const content = Buffer.alloc(length);
    for (let position = 0; position < length; ) {
      const { bytesRead } = await readBytes(
        fd,
        content,
        position,
        Math.min(262144, length - position),
        offset + position
      );
      if (!bytesRead) return null;
      position += bytesRead;
    }
    return content;
  }
  async function video(fd: number, size: number, extension: string, input: Input) {
    const header = await range(fd, 0, Math.min(size, VIDEO_HEADER_BYTES));
    if (!header) return { reason: 'file_changed' };
    const mediaType = matchingVideoType(header, extension);
    if (!mediaType) return { reason: 'unsupported_type' };
    if (input.offset > size) return { reason: 'invalid_offset' };
    const chunk = await range(fd, input.offset, Math.min(input.maxBytes, size - input.offset));
    if (!chunk) return { reason: 'file_changed' };
    return {
      value: {
        kind: 'video' as const,
        mediaType,
        byteLength: size,
        nextOffset: input.offset + chunk.length,
        complete: input.offset + chunk.length === size,
        data: chunk.toString('base64'),
      },
    };
  }
  async function bytes(
    plan: { root: string; relativePath: string; owner: unknown },
    input: Input,
    caller: OperationCaller
  ) {
    const extension = plan.relativePath.split('.').at(-1)?.toLowerCase() ?? '';
    const limit = liveFileByteLimit(extension);
    if (limit === null) return refusal('unsupported_type');
    let missing = false;
    const result = await withArtifactDescriptor(
      plan.root,
      plan.relativePath.split('/'),
      async (fd) => {
        const initial = fstatSync(fd, { bigint: true });
        if (initial.nlink !== 1n) return refusal('file_changed');
        const size = Number(initial.size);
        const version = fileVersion(initial);
        if (input.version && input.version !== version) return refusal('file_changed');
        if (size > limit) return refusal('size_limit');
        if (videoExtension(extension)) {
          const prepared = await video(fd, size, extension, input);
          if (fileVersion(fstatSync(fd, { bigint: true })) !== version)
            return refusal('file_changed');
          return 'reason' in prepared
            ? refusal(prepared.reason)
            : {
                accepted: true as const,
                path: resolve(plan.root, plan.relativePath),
                version,
                ...prepared.value,
              };
        }
        const content = await range(fd, 0, size);
        if (!content) return refusal('file_changed');
        if (fileVersion(fstatSync(fd, { bigint: true })) !== version)
          return refusal('file_changed');
        const prepared = prepareLiveFileContent(content, extension);
        if ('reason' in prepared) return refusal(prepared.reason);
        const { bytes: document, ...metadata } = prepared.value;
        if (input.offset > document.length) return refusal('invalid_offset');
        const chunk = document.subarray(input.offset, input.offset + input.maxBytes);
        return {
          accepted: true as const,
          path: resolve(plan.root, plan.relativePath),
          ...metadata,
          version,
          byteLength: document.length,
          nextOffset: input.offset + chunk.length,
          complete: input.offset + chunk.length === document.length,
          data: chunk.toString('base64'),
        };
      },
      (errno) => {
        missing ||= errno === 2;
      }
    );
    const current = prepare(input, caller);
    if ('reason' in current || JSON.stringify(current.value) !== JSON.stringify(plan))
      return refusal();
    return result.accepted
      ? result.value
      : refusal(
          result.reason === 'safe_open_unavailable'
            ? result.reason
            : missing
              ? 'missing'
              : 'forbidden'
        );
  }
  const execute = (superpipe({})('file-reference-read') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      (caller: OperationCaller) =>
        isLocalUser(caller) ? { value: caller } : { reason: refusal() },
      'caller',
      'result:read'
    )
    .pipe(prepare, ['input', 'read'], 'result:read')
    .pipe(bytes, ['read', 'input', 'caller'], 'read')
    .endAsync('read') as (input: Input, caller: OperationCaller) => Promise<unknown>;
  return defineOperation({
    name: 'file.reference.read',
    description:
      'Paired-human current text/Markdown, sanitized HTML, raster image or video read from an exact reference in a readable stored source. No registration or copy. Successful reads include the owning daemon’s absolute path for ordinary question text. Returns at most 256 KiB decoded bytes from text/HTML of at most 2 MiB, raster images of at most 32 MiB/16 million pixels or MP4/modern QuickTime video of at most 16 MiB. Video reads validate a bounded matching container header and requested range through the same anchored descriptor. HTML is sanitized before chunking and must render in an opaque-origin sandbox, without scripts or automatic external assets. Continue with nextOffset and version. Reopen without version for current content. A changed version requires discarding partial bytes and reopening.',
    inputSchema,
    resultSchema: z.union([
      z.strictObject({
        accepted: z.literal(false),
        reason: z.enum([
          'forbidden',
          'missing',
          'owner_unavailable',
          'unsupported_type',
          'size_limit',
          'file_changed',
          'invalid_offset',
          'safe_open_unavailable',
        ]),
      }),
      z.strictObject({
        accepted: z.literal(true),
        path: z.string(),
        kind: z.enum(['text', 'markdown', 'html', 'image', 'video']),
        mediaType: z
          .enum([
            'image/png',
            'image/jpeg',
            'image/gif',
            'image/webp',
            'video/mp4',
            'video/quicktime',
          ])
          .optional(),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
        scriptsRemoved: z.boolean().optional(),
        links: z
          .array(z.strictObject({ text: z.string().max(200), href: z.string() }))
          .max(200)
          .optional(),
        version: z.string().regex(/^[a-f0-9]{64}$/),
        byteLength: z.number().int().nonnegative(),
        nextOffset: z.number().int().nonnegative(),
        complete: z.boolean(),
        data: z.string().max(349528),
      }),
    ]),
    policy: { safetyClass: 'read', caller: 'local_user' },
    execute,
  });
}
