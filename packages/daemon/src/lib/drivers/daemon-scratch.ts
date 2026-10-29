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
  if (created) {
    const entry = await lstat(runtime);
    const directory = ownerDirectory();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (!(await lstat(directory)).isDirectory())
      throw new Error('Scratch registry must be a directory');
    const path = join(directory, key(root));
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporary,
        JSON.stringify({
          kind: 'hyperneo-daemon-scratch-v1',
          pid: process.pid,
          token,
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
  children: readonly { pid: number; daemonPid: number }[] = []
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
    const record = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!record?.isFile() || (process.getuid && record.uid !== process.getuid())) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT')
        continue;
      throw error;
    }
    const owner = Owner.safeParse(parsed);
    if (!owner.success || key(owner.data.root) !== name) continue;
    const lease = owner.data;
    if (
      staleOnly
        ? Date.now() - lease.createdAt <= day || !dead(lease.pid)
        : lease.pid !== process.pid || lease.token !== token
    )
      continue;
    if (children.some((child) => child.daemonPid === lease.pid && !dead(child.pid))) continue;
    const runtime = workerWorkLocations(lease.root).scratch;
    const entry = await lstat(runtime).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (entry && (!entry.isDirectory() || entry.dev !== lease.dev || entry.ino !== lease.ino))
      continue;
    if (entry) await releaseWorkerSandbox(lease.root);
    await unlink(path);
  }
}
