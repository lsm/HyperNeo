import { createHash } from 'node:crypto';
import { fstatSync, read, type BigIntStats } from 'node:fs';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { previewReferenceCandidates } from '@hyperneo/shared/types/artifact-reference';
import type { Database } from '../../storage/sqlite-compat.ts';
import { readPublicFileSource } from '../../storage/repositories/public-file-source.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import { isLocalUser } from '../operations/caller.ts';
import { withArtifactDescriptor } from '../runtime-artifact-open.ts';
import { resolveArtifactSource } from './file-policy.ts';

const inputSchema = z
  .strictObject({
    sourceMessageOrCard: z.strictObject({
      kind: z.enum(['message', 'publication', 'todo']),
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
const fileVersion = (stat: BigIntStats) => {
  return createHash('sha256')
    .update([stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.nlink].join(':'))
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
  async function bytes(
    plan: { root: string; relativePath: string; owner: unknown },
    input: Input,
    caller: OperationCaller
  ) {
    const extension = plan.relativePath.split('.').at(-1)?.toLowerCase() ?? '';
    if (!['md', 'markdown', 'txt', 'json', 'jsonl', 'log', 'csv', 'css'].includes(extension))
      return refusal('unsupported_type');
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
        if (size > 2097152) return refusal('size_limit');
        if (input.offset > size) return refusal('invalid_offset');
        const content = Buffer.alloc(size);
        for (let position = 0; position < content.length; ) {
          const { bytesRead } = await readBytes(
            fd,
            content,
            position,
            Math.min(262144, content.length - position),
            position
          );
          if (!bytesRead) return refusal('file_changed');
          position += bytesRead;
        }
        if (fileVersion(fstatSync(fd, { bigint: true })) !== version)
          return refusal('file_changed');
        try {
          new TextDecoder('utf-8', { fatal: true }).decode(content);
        } catch {
          return refusal('unsupported_type');
        }
        if (content.includes(0)) return refusal('unsupported_type');
        const chunk = content.subarray(input.offset, input.offset + input.maxBytes);
        return {
          accepted: true as const,
          kind: ['md', 'markdown'].includes(extension) ? 'markdown' : 'text',
          version,
          byteLength: content.length,
          nextOffset: input.offset + chunk.length,
          complete: input.offset + chunk.length === content.length,
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
      'Paired-human current text/Markdown read from an exact reference in a readable stored source. No registration or copy. Returns at most 256 KiB decoded bytes from a file of at most 2 MiB; continue with nextOffset and version. Reopen without version for current content. A changed version requires discarding partial bytes and reopening.',
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
        kind: z.enum(['text', 'markdown']),
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
