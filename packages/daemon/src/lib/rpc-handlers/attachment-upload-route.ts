import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, renameSync, unlinkSync } from 'node:fs';
import { mkdir, open, opendir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { UpgradeIdentity } from '../pairing/upgrade-auth.ts';
import { MAX_IMAGE_BASE64_SIZE } from '../session/message-persistence.ts';

const PATH_PREFIX = '/api/attachments/';
const MAX_IMAGE_BYTES = (MAX_IMAGE_BASE64_SIZE * 3) / 4;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const RETENTION_MS = 7 * 24 * SWEEP_INTERVAL_MS;
const HASH = /^[a-f0-9]{64}$/i;
const STAGED_NAME = /^(?:[a-f0-9]{64}|[a-f0-9-]{36}\.part)$/;
const IMAGE_SIGNATURES = new Map<string, (head: Buffer) => boolean>([
  ['image/jpeg', (head) => head.toString('hex', 0, 3) === 'ffd8ff'],
  ['image/png', (head) => head.toString('hex', 0, 8) === '89504e470d0a1a0a'],
  ['image/gif', (head) => /^GIF8[79]a/.test(head.toString('latin1', 0, 6))],
  [
    'image/webp',
    (head) => head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP',
  ],
]);

const response = (body: string | null, status: number) =>
  new Response(body, { status, headers: { 'Cache-Control': 'no-store' } });
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

export function createAttachmentUpload(
  directory: string,
  authenticate: (req: Request, remoteAddress: string | null) => Promise<UpgradeIdentity | null>
) {
  const active = new Set<string>();

  async function stage(req: Request, hash: string): Promise<Response> {
    if (!HASH.test(hash) || !req.body) return response('Invalid attachment', 400);
    const signature = IMAGE_SIGNATURES.get(req.headers.get('content-type')?.toLowerCase() ?? '');
    if (!signature) return response('Unsupported image media type', 415);
    if (Number(req.headers.get('content-length')) > MAX_IMAGE_BYTES)
      return response('Image exceeds size limit', 413);

    await mkdir(directory, { recursive: true, mode: 0o700 });
    const name = `${randomUUID()}.part`;
    const temporary = join(directory, name);
    const reader = req.body.getReader();
    const digest = createHash('sha256');
    const canonicalHash = hash.toLowerCase();
    let size = 0;
    let needsCleanup = false;
    active.add(name);
    try {
      const file = await open(temporary, 'wx+', 0o600);
      needsCleanup = true;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_IMAGE_BYTES) return response('Image exceeds size limit', 413);
          digest.update(value);
          await file.writeFile(value);
        }
        const head = Buffer.alloc(12);
        const { bytesRead } = await file.read(head, 0, head.length, 0);
        if (!signature(head.subarray(0, bytesRead)))
          return response('Image signature does not match media type', 415);
        if (digest.digest('hex') !== canonicalHash)
          return response('Image SHA-256 does not match', 422);
        const now = new Date();
        await file.utimes(now, now);
      } finally {
        await file.close();
      }
      renameSync(temporary, join(directory, canonicalHash));
      needsCleanup = false;
      return response(null, 204);
    } finally {
      try {
        if (needsCleanup) await rm(temporary, { force: true });
      } finally {
        active.delete(name);
        void reader.cancel().catch(() => {});
      }
    }
  }

  const upload = (superpipe({})('attachment-upload-http') as PipelineAPI)
    .input(['req', 'remoteAddress', 'hash'])
    .pipe(authenticate, ['req', 'remoteAddress'], 'device')
    .pipe(
      (device: UpgradeIdentity | null) =>
        device ? { value: device } : { reason: response('Device pairing required', 401) },
      'device',
      'result:response'
    )
    .pipe(stage, ['req', 'hash'], 'response')
    .endAsync('response') as (
    req: Request,
    remoteAddress: string | null,
    hash: string
  ) => Promise<Response>;

  async function sweep() {
    const cutoff = Date.now() - RETENTION_MS;
    const entries = await opendir(directory).catch((error: unknown) => {
      if (!missing(error)) throw error;
      return null;
    });
    if (!entries) return;
    for await (const { name } of entries) {
      if (!STAGED_NAME.test(name) || active.has(name)) continue;
      const path = join(directory, name);
      try {
        const entry = lstatSync(path);
        if (entry.isFile() && entry.mtimeMs <= cutoff) unlinkSync(path);
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
  }

  return {
    async handle(req: Request, remoteAddress: string | null) {
      const path = new URL(req.url).pathname;
      return req.method === 'PUT' && path.startsWith(PATH_PREFIX)
        ? upload(req, remoteAddress, path.slice(PATH_PREFIX.length))
        : null;
    },
    async startSweep(onError: (error: unknown) => void) {
      await sweep().catch(onError);
      let pending: Promise<void> | undefined;
      const timer = setInterval(() => {
        pending ??= sweep()
          .catch(onError)
          .finally(() => {
            pending = undefined;
          });
      }, SWEEP_INTERVAL_MS);
      timer.unref();
      return async () => {
        clearInterval(timer);
        await pending;
      };
    },
  };
}
