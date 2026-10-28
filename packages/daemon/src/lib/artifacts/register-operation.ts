import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { ArtifactRef, ArtifactRefusal } from '@hyperneo/shared/types/artifact-file';
import type { Database } from '../../storage/sqlite-compat.ts';
import { gatewayFor } from '../../storage/db-gateway/db-gateway.ts';
import { artifactIdentityWrites } from '../../storage/repositories/artifact-file-identity-write.ts';
import { ArtifactFileRepository } from '../../storage/repositories/artifact-file-repository.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import { getDataDir } from '../data-dir.ts';
import { artifactCaptureOwner } from './capture-owner.ts';
import { ArtifactRefSchema, ArtifactRefusalSchema } from './file-contracts.ts';
import { admitArtifactCapture } from './file-policy.ts';
import { loadRegistrationBinding } from './registration-binding.ts';
import { withStoredArtifactDescriptor } from '../runtime-artifact-open.ts';
import { readSync } from 'node:fs';
import { ArtifactBundleSchema, artifactBundleLimit, bindArtifactBundle } from './bundle.ts';

export const RegisterArtifactInput = z.strictObject({
  requestId: z.string().min(1).max(200),
  context: z.strictObject({ kind: z.enum(['todo', 'ask']), id: z.string().min(1).max(200) }),
  path: z.string().min(1).max(4096),
  title: z.string().trim().min(1).max(200),
  bundle: ArtifactBundleSchema.optional(),
});
type Input = z.infer<typeof RegisterArtifactInput>;
const textKinds = new Map<string, ArtifactRef['kind']>([
  ['md', 'markdown'],
  ['markdown', 'markdown'],
  ['html', 'html'],
  ['htm', 'html'],
  ['json', 'json'],
  ['log', 'log'],
  ['txt', 'text'],
  ['css', 'text'],
]);
const instances = new WeakMap<Database, ReturnType<typeof registrationService>>();
const refused = (reason: ArtifactRefusal['reason']): ArtifactRefusal => ({
  accepted: false,
  reason,
});

export function storedKind(root: string, hash: string, path: string) {
  return withStoredArtifactDescriptor(root, hash, (fd) => {
    const head = Buffer.alloc(1024);
    const count = readSync(fd, head, 0, head.length, 0);
    const bytes = head.subarray(0, count);
    const extension = path.split('.').at(-1)?.toLowerCase();
    if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(extension ?? '')) {
      const magic = bytes.toString('hex');
      return (extension === 'png' && magic.startsWith('89504e470d0a1a0a')) ||
        (['jpg', 'jpeg'].includes(extension!) && magic.startsWith('ffd8ff')) ||
        (extension === 'gif' && /^GIF8[79]a/.test(bytes.toString())) ||
        (extension === 'webp' &&
          bytes.toString('ascii', 0, 4) === 'RIFF' &&
          bytes.toString('ascii', 8, 12) === 'WEBP')
        ? ('image' as const)
        : null;
    }
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true });
      if (bytes.includes(0)) return null;
      return textKinds.get(extension ?? '') ?? null;
    } catch {
      return null;
    }
  });
}

async function registrationService(db: Database, data: string, home: string) {
  const daemonId = await gatewayFor(db).call(artifactIdentityWrites, 'ensure', randomUUID());
  const registry = new ArtifactFileRepository(db, daemonId);
  const root = join(data, 'artifacts');
  let lane = Promise.resolve();
  const policy = {
    daemonId: registry.daemonId,
    home,
    loadBinding: (context: Input['context']) =>
      loadRegistrationBinding(db, registry.daemonId, context, home),
  };
  async function prepare(input: Input, caller: OperationCaller) {
    const plan = await admitArtifactCapture(input.context, input.path, caller, policy);
    if ('accepted' in plan) return { reason: plan };
    if (!input.bundle) return { value: { ...plan, bundle: undefined } };
    const bound = bindArtifactBundle(db, input.context, input.bundle);
    if ('reason' in bound) return bound;
    const limit = artifactBundleLimit(0, bound.value);
    if (limit) return { reason: limit };
    return {
      value: {
        ...plan,
        bundle: [...input.bundle].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      },
    };
  }
  type Plan = Extract<Awaited<ReturnType<typeof prepare>>, { value: unknown }>['value'];
  async function capture(plan: Plan, input: Input, caller: OperationCaller) {
    const binding = policy.loadBinding(input.context);
    const producer = JSON.stringify(
      binding?.workerRef ?? {
        adapter: 'hyperneo',
        id: caller.sessionId ?? binding?.workerSessionId ?? binding?.neoSessionId ?? 'local',
      }
    );
    const fingerprint = (producerRef: string) =>
      createHash('sha256')
        .update(JSON.stringify([plan, producerRef, input.title]))
        .digest('hex');
    async function finish(receipt: () => unknown) {
      const current = await prepare(input, caller);
      return 'reason' in current ? current.reason : receipt();
    }
    const previous = registry.receipt(input.context, input.requestId);
    const owner = await artifactCaptureOwner(db, data);
    if (previous && previous.fingerprint === fingerprint(previous.producer_ref)) {
      const hash = await owner.hashSource(plan.root, plan.relativePath.split('/'));
      if (hash.accepted && hash.sha256 === previous.sha256)
        return finish(() => ({ accepted: true, artifact: JSON.parse(previous.receipt).artifact }));
      if (!hash.accepted && hash.reason === 'unsafe_path') {
        const absent = await fs.lstat(join(plan.root, plan.relativePath)).then(
          () => false,
          (error: NodeJS.ErrnoException) => error.code === 'ENOENT'
        );
        if (absent)
          return finish(() => ({
            accepted: true,
            artifact: JSON.parse(previous.receipt).artifact,
          }));
      }
      if (!hash.accepted) return hash;
    }
    const snapshot = await owner.capture(plan.root, plan.relativePath.split('/'));
    if (!snapshot.accepted) return snapshot;
    const kind = await storedKind(root, snapshot.sha256, plan.relativePath);
    if (!kind.accepted) return kind;
    if (!kind.value || (plan.bundle && kind.value !== 'html')) return refused('unsupported_type');
    if (plan.bundle) {
      const bound = bindArtifactBundle(db, input.context, plan.bundle);
      if ('reason' in bound) return bound.reason;
      const limit = artifactBundleLimit(snapshot.byteLength, bound.value);
      if (limit) return limit;
    }
    return finish(() =>
      registry.save(
        input.context,
        previous ? randomUUID() : input.requestId,
        fingerprint(producer),
        snapshot.sha256,
        {
          daemonId: registry.daemonId,
          artifactId: randomUUID(),
          title: input.title,
          kind: kind.value!,
          byteLength: snapshot.byteLength,
        },
        producer,
        plan.relativePath,
        { kind: 'worktree' },
        plan.bundle,
        input.requestId
      )
    );
  }
  const register = (superpipe({})('artifact-file-register') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(prepare, ['input', 'caller'], 'result:registration')
    .pipe(capture, ['registration', 'input', 'caller'], 'registration')
    .endAsync('registration') as (input: Input, caller: OperationCaller) => Promise<unknown>;
  return async (input: Input, caller: OperationCaller) => {
    const previous = lane;
    let release = () => {};
    lane = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await register(input, caller);
    } finally {
      release();
    }
  };
}

export function createArtifactRegistration(
  database: () => Database,
  data = getDataDir(),
  home = homedir()
) {
  return defineOperation({
    name: 'artifact.file.register',
    description:
      'Snapshot an explicitly chosen non-sensitive regular file anywhere on this daemon. Relative paths use the context workspace; use an absolute path when it is unavailable. Changed sources create new immutable revisions. Supply a stable requestId, context, path and short title. Optional HTML bundle entries map relative names to already registered CSS/raster IDs in this same context (64 entries including HTML, 64 MiB total); never crawl or fetch assets. Publishes only an immutable reference; source and stored bytes are retained. Credential/secret files, traversal and symlinks are blocked; snapshot sharing rights are unchanged.',
    inputSchema: RegisterArtifactInput,
    resultSchema: z.union([
      ArtifactRefusalSchema,
      z.strictObject({
        accepted: z.literal(false),
        reason: z.literal('size_limit'),
        actualBytes: z.number().int().nonnegative(),
        limitBytes: z.number().int().positive(),
      }),
      z.strictObject({ accepted: z.literal(true), artifact: ArtifactRefSchema }),
    ]),
    policy: { safetyClass: 'mutate' },
    async execute(input, caller) {
      const db = database();
      let service = instances.get(db);
      if (!service) {
        service = registrationService(db, data, home).catch((error) => {
          instances.delete(db);
          throw error;
        });
        instances.set(db, service);
      }
      return (await service)(input, caller);
    },
  });
}
