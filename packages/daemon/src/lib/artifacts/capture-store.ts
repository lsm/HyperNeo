import type { ArtifactLimits } from '@hyperneo/shared/types/artifact-file';
import { createHash, randomUUID } from 'node:crypto';
import { constants, fstatSync, read, type Stats } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { withArtifactDescriptor, withStoredArtifactDescriptor } from '../runtime-artifact-open.ts';
import { ArtifactLimitsSchema } from './file-contracts.ts';
import { admitArtifactStorage } from './capture-admission.ts';

const readDescriptor = promisify(read);
async function syncDirectory(path: string) {
  const handle = await fs.open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function inventory(root: string) {
  const entries: { area: string; name: string; byteLength: number }[] = [];
  const inodes = new Set<string>();
  let retainedBytes = 0;
  for (const area of ['blobs', 'staging']) {
    for (const name of await fs.readdir(join(root, area))) {
      const stat = await fs.lstat(join(root, area, name));
      if (!stat.isFile()) throw new Error('artifact_store_not_regular');
      entries.push({ area, name, byteLength: stat.size });
      const key = `${stat.dev}:${stat.ino}`;
      if (!inodes.has(key)) {
        retainedBytes += stat.size;
        inodes.add(key);
      }
    }
  }
  return { entries, retainedBytes };
}

async function copyDescriptor(fd: number, initial: Stats, destination?: FileHandle) {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(256 * 1024);
  let position = 0;
  while (position < initial.size) {
    const { bytesRead } = await readDescriptor(
      fd,
      buffer,
      0,
      Math.min(buffer.length, initial.size - position),
      position
    );
    if (!bytesRead) return null;
    hash.update(buffer.subarray(0, bytesRead));
    if (destination) await destination.writeFile(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  const after = fstatSync(fd);
  return after.dev === initial.dev &&
    after.ino === initial.ino &&
    after.size === initial.size &&
    after.mtimeMs === initial.mtimeMs &&
    after.ctimeMs === initial.ctimeMs &&
    after.nlink === initial.nlink
    ? hash.digest('hex')
    : null;
}

export async function createArtifactCaptureStore(
  root: string,
  overrides: Partial<ArtifactLimits> = {}
) {
  const limits = ArtifactLimitsSchema.parse(overrides);
  for (const area of ['blobs', 'staging'])
    await fs.mkdir(join(root, area), { recursive: true, mode: 0o700 });
  let used = (await inventory(root)).retainedBytes;
  let reserved = 0;
  let commit = Promise.resolve();
  return {
    async inspect() {
      return {
        retainedBytes: used,
        reservedBytes: reserved,
        limitBytes: limits.retainedBytes,
        warning: used + reserved >= limits.retainedBytes * limits.warningRatio,
        entries: (await inventory(root)).entries,
      };
    },
    async hashSource(sourceRoot: string, segments: string[]) {
      const result = await withArtifactDescriptor(sourceRoot, segments, async (fd, initial) => {
        const admission = admitArtifactStorage(initial.size, limits, 0, 0);
        if (typeof admission !== 'number') return admission;
        const sha256 = await copyDescriptor(fd, initial);
        return sha256
          ? { accepted: true as const, sha256 }
          : { accepted: false as const, reason: 'source_changed' as const };
      });
      return result.accepted ? result.value : result;
    },
    async capture(sourceRoot: string, segments: string[]) {
      const result = await withArtifactDescriptor(sourceRoot, segments, async (fd, initial) => {
        const admission = admitArtifactStorage(initial.size, limits, used, reserved);
        if (typeof admission !== 'number') return admission;
        reserved += admission;
        const staged = join(root, 'staging', randomUUID());
        let added = 0;
        try {
          await syncDirectory(root);
          await syncDirectory(dirname(root));
          const snapshot = await fs.open(staged, 'wx', 0o600);
          let sha256: string | null;
          try {
            await syncDirectory(join(root, 'staging'));
            sha256 = await copyDescriptor(fd, initial, snapshot);
            if (sha256 === null)
              return { accepted: false as const, reason: 'source_changed' as const };
            await snapshot.chmod(0o444);
            await snapshot.sync();
          } finally {
            await snapshot.close();
          }
          const previousCommit = commit;
          let release = () => {};
          commit = new Promise<void>((resolve) => {
            release = resolve;
          });
          await previousCommit;
          try {
            const blob = join(root, 'blobs', sha256);
            try {
              await fs.link(staged, blob);
              added = initial.size;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
              const existing = await withStoredArtifactDescriptor(root, sha256, (fd, stat) =>
                stat.size === initial.size ? copyDescriptor(fd, stat) : null
              );
              if (!existing.accepted || existing.value !== sha256)
                throw new Error('artifact_blob_conflict');
            }
            await syncDirectory(join(root, 'blobs'));
            await fs.unlink(staged);
            await syncDirectory(join(root, 'staging'));
            return { accepted: true as const, sha256, byteLength: initial.size };
          } finally {
            release();
          }
        } finally {
          const leftover = await fs.lstat(staged).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
            return null;
          });
          used += Math.max(added, leftover?.size ?? 0);
          reserved -= admission;
        }
      });
      return result.accepted ? result.value : result;
    },
  };
}
