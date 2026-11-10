import {
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, isAbsolute, join } from 'node:path';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { getDataDir } from '../data-dir.ts';
import { isLocalUser } from '../operations/caller.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import { readProcessIdentity, type ProcessIdentity } from '../runtime-process-identity.ts';
import { sleep } from '../utils/sleep.ts';

const Record = z
  .object({
    pid: z.number().int().min(2).max(2147483647),
    startedAt: z
      .object({
        seconds: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        microseconds: z.number().int().min(0).max(999999),
      })
      .strict(),
    socket: z.string().min(1).refine(isAbsolute),
  })
  .strict();
type Driver = z.infer<typeof Record>;
const STOPPED = { state: 'stopped' as const };
const UNCONFIRMED = { state: 'stop_unconfirmed' as const };
type Options = {
  dataDir?: string;
  readIdentity?: (pid: number) => Promise<ProcessIdentity | null>;
};
function missing(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}
function pidGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}
function syncDirectory(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function latch(dataDir: string, worker: string): string {
  const desktop = join(dataDir, 'desktop');
  const directory = join(desktop, 'workers', worker);
  for (const path of [desktop, dirname(directory), directory]) {
    try {
      mkdirSync(path, { mode: 0o700 });
      syncDirectory(dirname(path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700)
      throw new Error('Invalid desktop record directory.');
  }
  try {
    const fd = openSync(
      join(directory, 'stopped'),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600
    );
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  syncDirectory(directory);
  return directory;
}
function recorded(directory: string): Driver {
  const fd = openSync(
    join(directory, 'driver.json'),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.nlink !== 1 ||
      stat.size > 16384
    )
      throw new Error('Invalid desktop driver record.');
    return Record.parse(JSON.parse(readFileSync(fd, 'utf8')));
  } finally {
    closeSync(fd);
  }
}
async function askApp(dataDir: string, worker: string) {
  await new Promise<void>((resolve) => {
    const client = createConnection(join(dataDir, 'desktop/control.sock'));
    const timer = setTimeout(finish, 200);
    function finish() {
      clearTimeout(timer);
      client.destroy();
      resolve();
    }
    client.once('connect', () => client.write(JSON.stringify({ action: 'stop', worker }) + '\n'));
    client.once('data', finish);
    client.once('end', finish);
    client.once('error', finish);
  }).catch(() => {});
}
function same(left: ProcessIdentity | null, right: ProcessIdentity): boolean {
  return left?.seconds === right.seconds && left.microseconds === right.microseconds;
}
async function stopDriver(worker: string, options: Options) {
  try {
    const dataDir = options.dataDir ?? getDataDir();
    const directory = latch(dataDir, worker);
    await askApp(dataDir, worker);
    const driver = recorded(directory);
    const readIdentity = options.readIdentity ?? readProcessIdentity;
    const signal = async (kind: 'SIGTERM' | 'SIGKILL') => {
      if (!same(await readIdentity(driver.pid), driver.startedAt)) return false;
      try {
        process.kill(driver.pid, kind);
        return true;
      } catch {
        return pidGone(driver.pid);
      }
    };
    if (!pidGone(driver.pid)) {
      if (!(await signal('SIGTERM'))) return UNCONFIRMED;
      await sleep(1000);
      if (!pidGone(driver.pid) && !(await signal('SIGKILL'))) return UNCONFIRMED;
    }
    for (let attempt = 0; attempt < 50; attempt++) {
      const current = recorded(directory);
      if (
        current.pid !== driver.pid ||
        current.socket !== driver.socket ||
        !same(current.startedAt, driver.startedAt)
      )
        return UNCONFIRMED;
      if (
        pidGone(driver.pid) &&
        missing(driver.socket) &&
        missing(join(directory, 'starting')) &&
        !missing(join(directory, 'stopped'))
      )
        return STOPPED;
      await sleep(20);
    }
  } catch {
    return UNCONFIRMED;
  }
  return UNCONFIRMED;
}
export function createDesktopStopOperation(options: Options = {}) {
  const stop = (superpipe({})('desktop.stop') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      (caller: OperationCaller) =>
        isLocalUser(caller) && (!caller.device || caller.device.kind === 'human')
          ? { value: true }
          : { reason: UNCONFIRMED },
      'caller',
      'result:outcome'
    )
    .pipe(
      (input: { worker: string }) => stopDriver(input.worker, options),
      ['input', 'outcome'],
      'outcome'
    )
    .endAsync('outcome');
  return defineOperation({
    name: 'desktop.stop',
    description: 'Stop the selected worker desktop driver and confirm cleanup.',
    inputSchema: z.object({ worker: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) }).strict(),
    resultSchema: z.object({ state: z.enum(['stopped', 'stop_unconfirmed']) }),
    policy: { safetyClass: 'human_only', caller: 'local_user' },
    execute: stop,
  });
}
