import { ARTIFACT_DEFAULT_LIMITS } from '@hyperneo/shared/types/artifact-file';
import { createHash } from 'node:crypto';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { Database } from '../../storage/sqlite-compat.ts';
import { readCardHandoffReferences } from '../../storage/repositories/card-handoff-source.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import { isLocalUser } from '../operations/caller.ts';
import { getDataDir } from '../data-dir.ts';
import { prepareLiveFileContent } from '../artifacts/live-file-content.ts';
import { HANDOFF_CHUNK_BYTES, PublicHandoffReference, readPublicHandoff } from './outbox.ts';

const sourceSchema = z.strictObject({
  kind: z.enum(['question', 'publication']),
  id: z.string().min(1).max(200),
});
const inputSchema = z
  .strictObject({
    source: sourceSchema,
    reference: PublicHandoffReference,
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
    maxBytes: z.number().int().min(1).max(HANDOFF_CHUNK_BYTES).default(HANDOFF_CHUNK_BYTES),
    version: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .refine(
    (input) => input.offset === 0 || !!input.version,
    'A continuation requires its content version'
  );
type Input = z.infer<typeof inputSchema>;
const refusal = (reason: string) => ({ accepted: false as const, reason });
const fields = [
  'type',
  'artifactId',
  'daemonId',
  'sessionId',
  'name',
  'byteLength',
  'sha256',
] as const;

function attached(input: Input, caller: OperationCaller, items: unknown): boolean {
  return (
    isLocalUser(caller) &&
    Array.isArray(items) &&
    items.some((item) => {
      const parsed = PublicHandoffReference.safeParse(item);
      return (
        parsed.success && fields.every((field) => parsed.data[field] === input.reference[field])
      );
    })
  );
}

export function createCardHandoffRead(
  database: () => Database,
  data = getDataDir(),
  readChunk = readPublicHandoff
) {
  const prepare = (input: Input, caller: OperationCaller, refs: unknown) =>
    attached(input, caller, refs) ? { value: input } : { reason: refusal('forbidden') };
  async function bytes(input: Input, caller: OperationCaller) {
    const extension = input.reference.name.split('.').at(-1)?.toLowerCase() ?? '';
    if (!['md', 'markdown', 'html', 'htm'].includes(extension)) return refusal('unsupported_type');
    if (input.reference.byteLength > ARTIFACT_DEFAULT_LIMITS.documentPreviewBytes)
      return refusal('size_limit');
    let content: Buffer;
    try {
      const part = await readChunk(data, input.reference, 0, input.reference.byteLength);
      if (part.kind !== 'read')
        return refusal(part.kind === 'tampered' ? 'file_changed' : 'owner_unavailable');
      content = Buffer.from(part.data, 'base64');
      if (
        !part.complete ||
        part.nextOffset !== input.reference.byteLength ||
        content.length !== input.reference.byteLength
      )
        return refusal('file_changed');
    } catch {
      return refusal('owner_unavailable');
    }
    if (!attached(input, caller, readCardHandoffReferences(database(), input.source)))
      return refusal('forbidden');
    const prepared = prepareLiveFileContent(content, extension);
    if ('reason' in prepared) return refusal(prepared.reason);
    const { bytes: preparedContent, ...metadata } = prepared.value;
    const version = createHash('sha256').update(preparedContent).digest('hex');
    if (input.version && input.version !== version) return refusal('file_changed');
    if (input.offset > preparedContent.length) return refusal('invalid_offset');
    const chunk = preparedContent.subarray(input.offset, input.offset + input.maxBytes);
    return {
      accepted: true as const,
      ...metadata,
      version,
      byteLength: preparedContent.length,
      nextOffset: input.offset + chunk.length,
      complete: input.offset + chunk.length === preparedContent.length,
      data: chunk.toString('base64'),
    };
  }
  const execute = (superpipe({})('card-handoff-read') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe((input: Input) => readCardHandoffReferences(database(), input.source), 'input', 'refs')
    .pipe(prepare, ['input', 'caller', 'refs'], 'result:read')
    .pipe(bytes, ['read', 'caller'], 'read')
    .endAsync('read') as (input: Input, caller: OperationCaller) => Promise<unknown>;
  return defineOperation({
    name: 'file.handoff.read',
    description:
      'Read a verified worker handoff attached to the exact stored question or publication; HTML is sanitized, and no internal file path is returned.',
    inputSchema,
    resultSchema: z.union([
      z.strictObject({
        accepted: z.literal(false),
        reason: z.enum([
          'forbidden',
          'unsupported_type',
          'size_limit',
          'file_changed',
          'owner_unavailable',
          'invalid_offset',
        ]),
      }),
      z.strictObject({
        accepted: z.literal(true),
        kind: z.enum(['markdown', 'html']),
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
