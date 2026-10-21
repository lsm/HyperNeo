import { join } from 'node:path';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { Database } from '../../storage/sqlite-compat.ts';
import {
  ArtifactFileReadRepository,
  type StoredArtifactFile,
} from '../../storage/repositories/artifact-file-read-repository.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import { getDataDir } from '../data-dir.ts';
import {
  ArtifactRefSchema,
  ArtifactRefusalSchema,
  ArtifactReadInputSchema,
  ArtifactReadResultSchema,
  ArtifactFileMetadataSchema,
} from './file-contracts.ts';
import { authorizeArtifactCaller, type ArtifactContext } from './file-policy.ts';
import { loadRegistrationBinding } from './registration-binding.ts';
import { readArtifactChunk } from './read-snapshot.ts';

const unavailable = () => ({ accepted: false as const, reason: 'unavailable' as const });
const ListInput = z.strictObject({
  context: z.strictObject({ kind: z.enum(['todo', 'ask']), id: z.string().min(1).max(200) }),
  cursor: ArtifactReadInputSchema.shape.artifactId.optional(),
  limit: z.number().int().min(1).max(50).default(20),
});
type List = z.infer<typeof ListInput>;
type ReadInput = z.infer<typeof ArtifactReadInputSchema>;
const rowContext = (row: StoredArtifactFile): ArtifactContext => ({
  kind: row.context_kind,
  id: row.context_id,
});

export function createArtifactReadOperations(
  database: () => Database,
  data = getDataDir(),
  readChunk = readArtifactChunk
) {
  const repo = () => new ArtifactFileReadRepository(database());
  function authorizeContext(context: ArtifactContext, caller: OperationCaller) {
    const daemonId = repo().daemonId();
    const binding = daemonId ? loadRegistrationBinding(database(), daemonId, context) : null;
    return binding && 'value' in authorizeArtifactCaller(binding, caller)
      ? { value: context }
      : { reason: unavailable() };
  }
  function load(input: { artifactId: string }) {
    const row = repo().get(input.artifactId);
    return row ? { value: row } : { reason: unavailable() };
  }
  function authorizeRow(row: StoredArtifactFile, caller: OperationCaller) {
    return 'value' in authorizeContext(rowContext(row), caller)
      ? { value: row }
      : { reason: unavailable() };
  }
  function metadata(row: StoredArtifactFile) {
    const receipt = JSON.parse(row.receipt);
    return {
      accepted: true as const,
      metadata: {
        context: rowContext(row),
        artifact: receipt.artifact,
        sha256: row.sha256,
        createdAt: row.created_at,
        sourcePath: row.source_path,
        producer: JSON.parse(row.producer_ref),
        ...(receipt.revision ? { revision: receipt.revision } : {}),
      },
    };
  }
  function listContext(input: List, caller: OperationCaller) {
    return authorizeContext(input.context, caller);
  }
  function page(context: ArtifactContext, input: List, caller: OperationCaller) {
    const rows = repo().list(context, input.cursor, input.limit + 1);
    if (!rows || !('value' in authorizeContext(context, caller))) return unavailable();
    return {
      accepted: true as const,
      artifacts: rows.slice(0, input.limit).map((row) => JSON.parse(row.receipt).artifact),
      nextCursor: rows.length > input.limit ? rows[input.limit - 1].artifact_id : null,
    };
  }
  async function bytes(row: StoredArtifactFile, input: ReadInput, caller: OperationCaller) {
    const result = await readChunk(join(data, 'artifacts'), row, input.offset, input.maxBytes);
    return 'value' in authorizeRow(row, caller) ? result : unavailable();
  }
  const get = (superpipe({})('artifact-file-get') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(load, 'input', 'result:access')
    .pipe(authorizeRow, ['access', 'caller'], 'result:access')
    .pipe(metadata, 'access', 'access')
    .endAsync('access') as (
    input: { artifactId: string },
    caller: OperationCaller
  ) => Promise<unknown>;
  const list = (superpipe({})('artifact-file-list') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(listContext, ['input', 'caller'], 'result:access')
    .pipe(page, ['access', 'input', 'caller'], 'access')
    .endAsync('access') as (input: List, caller: OperationCaller) => Promise<unknown>;
  const read = (superpipe({})('artifact-file-read') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(load, 'input', 'result:access')
    .pipe(authorizeRow, ['access', 'caller'], 'result:access')
    .pipe(bytes, ['access', 'input', 'caller'], 'access')
    .endAsync('access') as (input: ReadInput, caller: OperationCaller) => Promise<unknown>;
  return [
    defineOperation({
      name: 'artifact.file.get',
      description:
        'Get currently authorized metadata for a registered artifact ID. IDs and copied links grant no access. No file bytes or absolute source paths are returned.',
      inputSchema: ArtifactReadInputSchema.pick({ artifactId: true }),
      resultSchema: z.union([
        ArtifactRefusalSchema,
        z.strictObject({ accepted: z.literal(true), metadata: ArtifactFileMetadataSchema }),
      ]),
      policy: { safetyClass: 'read' },
      execute: get,
    }),
    defineOperation({
      name: 'artifact.file.list',
      description:
        'List registered references in an authorized work/ask context, with bounded cursor pagination. No global worker search or file bytes.',
      inputSchema: ListInput,
      resultSchema: z.union([
        ArtifactRefusalSchema,
        z.strictObject({
          accepted: z.literal(true),
          artifacts: z.array(ArtifactRefSchema).max(50),
          nextCursor: z.string().nullable(),
        }),
      ]),
      policy: { safetyClass: 'read' },
      execute: list,
    }),
    defineOperation({
      name: 'artifact.file.read',
      description:
        'Read at most 256 KiB decoded bytes from a currently authorized registered snapshot ID. Rechecks context authority and whole-file SHA-256 before returning a bounded base64 chunk. Continue at nextOffset until complete; no raw source path or public download endpoint.',
      inputSchema: ArtifactReadInputSchema,
      resultSchema: ArtifactReadResultSchema,
      policy: { safetyClass: 'read' },
      execute: read,
    }),
  ];
}
