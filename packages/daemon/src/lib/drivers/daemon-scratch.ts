import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import { getDataDir } from '../data-dir.ts';
import { workerWorkLocations } from '../work-locations.ts';
import { prepareWorkerSandbox, releaseWorkerSandbox } from './worker-sandbox.ts';

const token = randomUUID();
const day = 24 * 60 * 60 * 1000;
const Owner = z.strictObject({
  kind: z.literal('hyperneo-daemon-scratch-v1'),
  pid: z.number().int().positive(),
  token: z.string().uuid(),
  previousPids: z.array(z.number().int().positive()).default([]),
  childOwnerPids: z.array(z.number().int().positive()).default([]),
  createdAt: z.number().positive(),
  root: z.string().min(1),
  dev: z.number(),
  ino: z.number(),
});
const ownerDirectory = () => join(getDataDir(), 'work', 'scratch-owners');
const key = (root: string) => `${basename(workerWorkLocations(root).scratch)}.json`;

function dead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

async function readOwner(path: string) {
  const record = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!record?.isFile() || (process.getuid && record.uid !== process.getuid())) return null;
  try {
    const parsed = Owner.safeParse(JSON.parse(await readFile(path, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT')
      return null;
    throw error;
  }
}

export async function prepareDaemonWorkerSandbox(root: string) {
  const runtime = workerWorkLocations(root).scratch;
  await mkdir(dirname(runtime), { recursive: true });
  let created = false;
  try {
    await mkdir(runtime, { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const entry = await lstat(runtime);
  const directory = ownerDirectory();
  const path = join(directory, key(root));
  const registry = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const previous =
    registry?.isDirectory() && (!process.getuid || registry.uid === process.getuid())
      ? await readOwner(path)
      : null;
  const managed =
    previous?.root === root &&
    entry.isDirectory() &&
    previous.dev === entry.dev &&
    previous.ino === entry.ino;
  if (created || managed) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const container = await lstat(directory);
    if (!container.isDirectory() || (process.getuid && container.uid !== process.getuid()))
      throw new Error('Scratch registry must be an owned directory');
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporary,
        JSON.stringify({
          kind: 'hyperneo-daemon-scratch-v1',
          pid: process.pid,
          token,
          previousPids: managed
            ? [
                ...new Set(
                  [previous.pid, ...previous.previousPids].filter(
                    (pid) => pid !== process.pid && !dead(pid)
                  )
                ),
              ]
            : [],
          childOwnerPids: managed
            ? [...new Set([previous.pid, ...previous.previousPids, ...previous.childOwnerPids])]
            : [],
          createdAt: Date.now(),
          root,
          dev: entry.dev,
          ino: entry.ino,
        }),
        { flag: 'wx', mode: 0o600 }
      );
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }
  return prepareWorkerSandbox(root);
}

export async function collectDaemonScratch(
  staleOnly = true,
  children: readonly { pid: number; daemonPid: number }[] = [],
  onError: (error: unknown) => void = (error) => {
    throw error;
  }
): Promise<void> {
  const directory = ownerDirectory();
  const registry = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!registry?.isDirectory() || (process.getuid && registry.uid !== process.getuid())) return;
  for (const name of await readdir(directory)) {
    if (!/^hn-[a-f0-9]{12}\.json$/.test(name)) continue;
    const path = join(directory, name);
    try {
      const lease = await readOwner(path);
      if (!lease || key(lease.root) !== name) continue;
      if (
        staleOnly
          ? Date.now() - lease.createdAt <= day || !dead(lease.pid)
          : lease.pid !== process.pid || lease.token !== token
      )
        continue;
      if (lease.previousPids.some((pid) => !dead(pid))) continue;
      if (
        children.some(
          (child) =>
            (child.daemonPid === lease.pid ||
              lease.previousPids.includes(child.daemonPid) ||
              lease.childOwnerPids.includes(child.daemonPid)) &&
            !dead(child.pid)
        )
      )
        continue;
      const runtime = workerWorkLocations(lease.root).scratch;
      const entry = await lstat(runtime).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (entry && (!entry.isDirectory() || entry.dev !== lease.dev || entry.ino !== lease.ino))
        continue;
      if (entry) await releaseWorkerSandbox(lease.root);
      await unlink(path);
    } catch (error) {
      onError(error);
    }
  }
}
