import { join } from 'node:path';
import { ARTIFACT_DEFAULT_LIMITS, type ArtifactRef } from '@hyperneo/shared/types/artifact-file';
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
import { prepareArtifactHtml, type ArtifactHtmlAsset } from './html-preview.ts';
import { ArtifactBundleSchema, artifactBundleLimit, bindArtifactBundle } from './bundle.ts';

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

function authorizesContext(db: Database, context: ArtifactContext, caller: OperationCaller) {
  const daemonId = new ArtifactFileReadRepository(db).daemonId();
  const binding = daemonId ? loadRegistrationBinding(db, daemonId, context) : null;
  return !!binding && 'value' in authorizeArtifactCaller(binding, caller);
}

export type ArtifactRefReader = (artifactId: string, caller: OperationCaller) => ArtifactRef | null;

export function createArtifactRefReader(database: () => Database): ArtifactRefReader {
  return (artifactId, caller) => {
    const row = new ArtifactFileReadRepository(database()).get(artifactId);
    return row && authorizesContext(database(), rowContext(row), caller)
      ? (JSON.parse(row.receipt).artifact as ArtifactRef)
      : null;
  };
}

export function createArtifactReadOperations(
  database: () => Database,
  data = getDataDir(),
  readChunk = readArtifactChunk
) {
  const repo = () => new ArtifactFileReadRepository(database());
  function authorizeContext(context: ArtifactContext, caller: OperationCaller) {
    return authorizesContext(database(), context, caller)
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
  async function html(row: StoredArtifactFile, caller: OperationCaller) {
    if (JSON.parse(row.receipt).artifact.kind !== 'html')
      return { accepted: false as const, reason: 'unsupported_type' as const };
    if (row.byte_length > ARTIFACT_DEFAULT_LIMITS.documentPreviewBytes)
      return { accepted: false as const, reason: 'size_limit' as const };
    const stored = JSON.parse(row.receipt).bundle;
    const manifest =
      stored === undefined
        ? { success: true as const, data: [] }
        : ArtifactBundleSchema.safeParse(stored);
    if (!manifest.success) return unavailable();
    const bound = bindArtifactBundle(database(), rowContext(row), manifest.data);
    if ('reason' in bound) return bound.reason;
    const limit = artifactBundleLimit(
      row.byte_length,
      bound.value,
      ARTIFACT_DEFAULT_LIMITS.documentPreviewBytes
    );
    if (limit) return limit;
    async function full(snapshot: StoredArtifactFile) {
      const chunks: Buffer[] = [];
      for (let offset = 0; ; ) {
        const chunk = await readChunk(
          join(data, 'artifacts'),
          snapshot,
          offset,
          ARTIFACT_DEFAULT_LIMITS.readBytes
        );
        if (!chunk.accepted) return { reason: chunk };
        chunks.push(Buffer.from(chunk.data, 'base64'));
        offset = chunk.nextOffset;
        if (chunk.complete) return { value: Buffer.concat(chunks) };
      }
    }
    const source = await full(row);
    if ('reason' in source) return source.reason;
    const assets = new Map<string, ArtifactHtmlAsset>();
    for (const asset of bound.value) {
      const content = await full(asset.row);
      if ('reason' in content) return content.reason;
      assets.set(
        asset.path,
        asset.mediaType === 'text/css'
          ? { kind: 'css', data: new TextDecoder().decode(content.value) }
          : {
              kind: 'image',
              data: `data:${asset.mediaType};base64,${content.value.toString('base64')}`,
            }
      );
    }
    if (!('value' in authorizeRow(row, caller))) return unavailable();
    const prepared = prepareArtifactHtml(new TextDecoder().decode(source.value), assets);
    if (
      stored !== undefined &&
      prepared &&
      Buffer.byteLength(prepared.document) > ARTIFACT_DEFAULT_LIMITS.documentPreviewBytes
    )
      return { accepted: false as const, reason: 'size_limit' as const };
    return prepared
      ? { accepted: true as const, sha256: row.sha256, ...prepared }
      : { accepted: false as const, reason: 'size_limit' as const };
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
  const preview = (superpipe({})('artifact-file-html') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(load, 'input', 'result:access')
    .pipe(authorizeRow, ['access', 'caller'], 'result:access')
    .pipe(html, ['access', 'caller'], 'access')
    .endAsync('access') as (
    input: { artifactId: string },
    caller: OperationCaller
  ) => Promise<unknown>;
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
    defineOperation({
      name: 'artifact.file.html',
      description:
        'Get a currently authorized registered HTML snapshot (at most 2 MiB) as an inert preview document: parsed and rebuilt from an element/attribute allowlist, with no scripts, handlers, forms, frames, SVG/MathML, remote loads or authored meta/base, and the host CSP first in head. Render it only in an opaque-origin sandboxed frame. Web links come back separately in links for the host to offer outside the frame; scriptsRemoved says to show the scripts-disabled notice.',
      inputSchema: ArtifactReadInputSchema.pick({ artifactId: true }),
      resultSchema: z.union([
        ArtifactRefusalSchema,
        z.strictObject({
          accepted: z.literal(true),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          document: z.string(),
          links: z.array(z.strictObject({ text: z.string().max(200), href: z.string() })).max(200),
          scriptsRemoved: z.boolean(),
        }),
      ]),
      policy: { safetyClass: 'read' },
      execute: preview,
    }),
  ];
}
