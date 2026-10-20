import { createHash, randomUUID } from 'node:crypto';
import {
  constants,
  linkSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import fs, { link, unlink } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { secretName } from '../secret-file-name.ts';

export const HANDOFF_CHUNK_BYTES = 256 * 1024;
export const HandoffName = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\w][\w .-]*$/)
  .refine((s) => s !== '.' && s !== '..' && !secretName(s), 'invalid_or_secret_filename');
export const HandoffReference = z.strictObject({
  artifactId: z.string().regex(/^[a-f0-9]{64}$/),
  daemonId: z.uuid(),
  sessionId: z.string().min(1).max(200),
  name: HandoffName,
  byteLength: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  path: z.string(),
});
type Reference = z.infer<typeof HandoffReference>;

function directory(dataDir: string, parts: string[]): string {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  let path = realpathSync(dataDir);
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || part.includes(sep))
      throw new Error('invalid_path');
    path = join(path, part);
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (!lstatSync(path).isDirectory() || realpathSync(path) !== path)
      throw new Error('invalid_path');
  }
  return path;
}

export function handoffDraftDirectory(dataDir: string, sessionId: string): string {
  if (!sessionId || sessionId.length > 200) throw new Error('invalid_session');
  return directory(dataDir, ['handoffs', encodeURIComponent(sessionId), 'drafts']);
}

async function daemonIdentity(dataDir: string, create = false): Promise<string> {
  const path = join(realpathSync(dataDir), 'handoffs', '.daemon-id');
  if (create) {
    const staged = join(realpathSync(dataDir), 'handoffs', `.identity-${randomUUID()}`);
    writeFileSync(staged, randomUUID(), { flag: 'wx', mode: 0o600, flush: true });
    try {
      linkSync(staged, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    } finally {
      unlinkSync(staged);
    }
  }
  const { file, initial } = await regularFile(dataDir, path);
  try {
    if (initial.size !== 36) throw new Error('invalid_daemon_identity');
    const buffer = Buffer.alloc(36);
    const { bytesRead } = await file.read(buffer, 0, 36, 0);
    return z.uuid().parse(buffer.subarray(0, bytesRead).toString());
  } finally {
    await file.close();
  }
}

function artifactPath(
  dataDir: string,
  ref: Pick<Reference, 'sessionId' | 'sha256' | 'name'>
): string {
  return join(
    realpathSync(dataDir),
    'handoffs',
    encodeURIComponent(ref.sessionId),
    'published',
    ref.sha256,
    ref.name
  );
}

async function regularFile(dataDir: string, path: string) {
  const root = realpathSync(dataDir);
  const rel = relative(root, path);
  if (rel.startsWith('..') || resolve(path) !== path || realpathSync(path) !== path)
    throw new Error('invalid_path');
  const initial = lstatSync(path);
  if (!initial.isFile() || initial.nlink !== 1) throw new Error('regular_unlinked_file_required');
  const file = await fs.open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const actual = await file.stat();
    if (
      actual.ino !== initial.ino ||
      actual.dev !== initial.dev ||
      actual.nlink !== 1 ||
      realpathSync(path) !== path
    )
      throw new Error('file_changed');
    return { file, initial: actual };
  } catch (error) {
    await file.close();
    throw error;
  }
}

export function publishedHandoffPath(dataDir: string, raw: string): boolean {
  try {
    if (raw.split(/[\\/]/).includes('..')) return false;
    const root = realpathSync(dataDir);
    const path = resolve(raw);
    const parts = relative(root, path).split(sep);
    if (
      !(
        parts.length === 5 &&
        parts[0] === 'handoffs' &&
        !!parts[1] &&
        parts[2] === 'published' &&
        /^[a-f0-9]{64}$/.test(parts[3]) &&
        HandoffName.safeParse(parts[4]).success
      )
    )
      return false;
    const stat = lstatSync(path);
    return stat.isFile() && stat.nlink === 1 && realpathSync(path) === path;
  } catch {
    return false;
  }
}

export async function readHandoff(
  dataDir: string,
  ref: Reference,
  offset = 0,
  length = HANDOFF_CHUNK_BYTES
) {
  if (ref.daemonId !== (await daemonIdentity(dataDir))) return { kind: 'unavailable' as const };
  if (
    ref.artifactId !== ref.sha256 ||
    ref.path !== artifactPath(dataDir, ref) ||
    !publishedHandoffPath(dataDir, ref.path)
  )
    return { kind: 'rejected' as const, reason: 'invalid_reference' };
  const { file, initial } = await regularFile(dataDir, ref.path);
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(HANDOFF_CHUNK_BYTES);
  const selected: Buffer[] = [];
  let position = 0;
  try {
    while (position < initial.size) {
      const { bytesRead } = await file.read(
        buffer,
        0,
        Math.min(buffer.length, initial.size - position),
        position
      );
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      const from = Math.max(offset - position, 0);
      const to = Math.min(offset + length - position, bytesRead);
      if (to > from) selected.push(Buffer.from(buffer.subarray(from, to)));
      position += bytesRead;
    }
    const after = await file.stat();
    if (
      after.size !== initial.size ||
      after.mtimeMs !== initial.mtimeMs ||
      after.ctimeMs !== initial.ctimeMs ||
      after.nlink !== 1
    )
      return { kind: 'tampered' as const };
  } finally {
    await file.close();
  }
  if (position !== ref.byteLength || hash.digest('hex') !== ref.sha256)
    return { kind: 'tampered' as const };
  return {
    kind: 'read' as const,
    data: Buffer.concat(selected).toString('base64'),
    nextOffset: Math.min(offset + length, position),
    complete: offset + length >= position,
  };
}

export async function verifyPublishedHandoff(dataDir: string, path: string) {
  const parts = relative(realpathSync(dataDir), path).split(sep);
  const ref: Reference = {
    artifactId: parts[3],
    daemonId: await daemonIdentity(dataDir),
    sessionId: decodeURIComponent(parts[1]),
    name: parts[4],
    byteLength: lstatSync(path).size,
    sha256: parts[3],
    path,
  };
  return readHandoff(dataDir, ref, 0, 0);
}

export async function publishHandoff(dataDir: string, sessionId: string, name: string) {
  const draft = join(handoffDraftDirectory(dataDir, sessionId), HandoffName.parse(name));
  const staged = join(
    directory(dataDir, ['handoffs', encodeURIComponent(sessionId), '.staging']),
    randomUUID()
  );
  const { file, initial } = await regularFile(dataDir, draft);
  let created = false;
  try {
    const snapshot = await fs.open(staged, 'wx', 0o600);
    created = true;
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(HANDOFF_CHUNK_BYTES);
    let position = 0;
    try {
      while (position < initial.size) {
        const { bytesRead } = await file.read(
          buffer,
          0,
          Math.min(buffer.length, initial.size - position),
          position
        );
        if (!bytesRead) throw new Error('file_changed');
        hash.update(buffer.subarray(0, bytesRead));
        await snapshot.writeFile(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      const after = await file.stat();
      if (
        after.size !== initial.size ||
        after.mtimeMs !== initial.mtimeMs ||
        after.ctimeMs !== initial.ctimeMs ||
        after.nlink !== 1
      )
        throw new Error('file_changed');
      await snapshot.chmod(0o444);
      await snapshot.sync();
    } finally {
      await snapshot.close();
    }
    const sha256 = hash.digest('hex');
    const parent = directory(dataDir, [
      'handoffs',
      encodeURIComponent(sessionId),
      'published',
      sha256,
    ]);
    const ref: Reference = {
      artifactId: sha256,
      daemonId: await daemonIdentity(dataDir, true),
      sessionId,
      name,
      byteLength: position,
      sha256,
      path: join(parent, name),
    };
    try {
      await link(staged, ref.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    await unlink(staged);
    created = false;
    const committed = await fs.open(parent, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await committed.sync();
    } finally {
      await committed.close();
    }
    const persisted = await readHandoff(dataDir, ref, 0, 0);
    return persisted.kind === 'read' ? { kind: 'published' as const, reference: ref } : persisted;
  } finally {
    await file.close();
    if (created) await unlink(staged);
  }
}
