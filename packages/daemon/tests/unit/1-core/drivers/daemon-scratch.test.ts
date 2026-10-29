import { afterEach, beforeEach, expect, test } from 'bun:test';
import { vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  collectDaemonScratch,
  prepareDaemonWorkerSandbox,
} from '../../../../src/lib/drivers/daemon-scratch';
import { prepareWorkerSandbox } from '../../../../src/lib/drivers/worker-sandbox';
import { workerWorkLocations } from '../../../../src/lib/work-locations';

let run: string;
let root: string;
const marker = () =>
  join(run, 'data/work/scratch-owners', `${basename(workerWorkLocations(root).scratch)}.json`);
const runtime = () => workerWorkLocations(root).scratch;

beforeEach(() => {
  run = mkdtempSync(join(tmpdir(), 'daemon-scratch-test-'));
  root = join(run, 'worker');
  mkdirSync(join(root, '.git'), { recursive: true });
  vi.stubEnv('HYPERNEO_DATA_DIR', join(run, 'data'));
  vi.stubEnv('HOME', join(run, 'home'));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(run, { recursive: true, force: true });
});
function ageOwner(pid: number, age = 25 * 60 * 60 * 1000) {
  const owner = JSON.parse(readFileSync(marker(), 'utf8'));
  owner.pid = pid;
  owner.createdAt = Date.now() - age;
  writeFileSync(marker(), JSON.stringify(owner));
}
function deadPid() {
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  expect(child.status).toBe(0);
  return child.pid;
}

test('normal shutdown removes only freshly daemon-owned scratch', async () => {
  await prepareDaemonWorkerSandbox(root);
  writeFileSync(join(runtime(), 'temp'), 'synthetic');
  expect(existsSync(marker())).toBe(true);
  await collectDaemonScratch(false);
  expect(existsSync(runtime())).toBe(false);
  expect(existsSync(marker())).toBe(false);
});

test('existing unmarked Desktop scratch is never adopted or automatically removed', async () => {
  await prepareWorkerSandbox(root);
  writeFileSync(join(runtime(), 'retained'), 'desktop');
  await prepareDaemonWorkerSandbox(root);
  await collectDaemonScratch(false);
  await collectDaemonScratch();
  expect(existsSync(marker())).toBe(false);
  expect(readFileSync(join(runtime(), 'retained'), 'utf8')).toBe('desktop');
});

test('startup reclaims old scratch with a positively dead owner', async () => {
  await prepareDaemonWorkerSandbox(root);
  ageOwner(deadPid());
  await collectDaemonScratch();
  expect(existsSync(runtime())).toBe(false);
  expect(existsSync(marker())).toBe(false);
});

test('startup preserves old scratch with a live owner', async () => {
  await prepareDaemonWorkerSandbox(root);
  ageOwner(process.pid);
  await collectDaemonScratch();
  expect(existsSync(runtime())).toBe(true);
});

test('startup preserves recent scratch even after its owner exits', async () => {
  await prepareDaemonWorkerSandbox(root);
  ageOwner(deadPid(), 1000);
  await collectDaemonScratch();
  expect(existsSync(runtime())).toBe(true);
});

test('permission-denied liveness probes are not proof of a dead owner', async () => {
  await prepareDaemonWorkerSandbox(root);
  ageOwner(12345);
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('denied'), { code: 'EPERM' });
  });
  await collectDaemonScratch();
  expect(existsSync(runtime())).toBe(true);
});

test('replacement directories cannot inherit a previous owner record', async () => {
  await prepareDaemonWorkerSandbox(root);
  ageOwner(deadPid());
  renameSync(runtime(), `${runtime()}.saved`);
  mkdirSync(runtime());
  writeFileSync(join(runtime(), 'retained'), 'replacement');
  await collectDaemonScratch();
  expect(readFileSync(join(runtime(), 'retained'), 'utf8')).toBe('replacement');
});

test('a symlink replacing an owned runtime cannot authorize target deletion', async () => {
  await prepareDaemonWorkerSandbox(root);
  ageOwner(deadPid());
  renameSync(runtime(), `${runtime()}.saved`);
  const outside = join(run, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'retained'), 'outside');
  symlinkSync(outside, runtime());
  await collectDaemonScratch();
  expect(readFileSync(join(outside, 'retained'), 'utf8')).toBe('outside');
});

test('malformed owner records never authorize deletion', async () => {
  await prepareDaemonWorkerSandbox(root);
  writeFileSync(marker(), '{invalid');
  await collectDaemonScratch(false);
  expect(existsSync(runtime())).toBe(true);
});

test('a live recorded SDK child prevents reclamation after its daemon exits', async () => {
  await prepareDaemonWorkerSandbox(root);
  const oldDaemon = deadPid();
  ageOwner(oldDaemon);
  await collectDaemonScratch(true, [{ pid: process.pid, daemonPid: oldDaemon }]);
  expect(existsSync(runtime())).toBe(true);
});

test('normal shutdown retains scratch while a recorded SDK child is still live', async () => {
  await prepareDaemonWorkerSandbox(root);
  await collectDaemonScratch(false, [{ pid: process.pid, daemonPid: process.pid }]);
  expect(existsSync(runtime())).toBe(true);
});

test('resuming owned scratch refreshes its lease before it can be reaped', async () => {
  await prepareDaemonWorkerSandbox(root);
  ageOwner(deadPid());
  await prepareDaemonWorkerSandbox(root);
  await collectDaemonScratch();
  expect(existsSync(runtime())).toBe(true);
  expect(JSON.parse(readFileSync(marker(), 'utf8')).pid).toBe(process.pid);
});

test('lease renewal retains live previous owners', async () => {
  await prepareDaemonWorkerSandbox(root);
  ageOwner(process.ppid);
  await prepareDaemonWorkerSandbox(root);
  await collectDaemonScratch(false);
  expect(existsSync(runtime())).toBe(true);
});

test('lease renewal retains live SDK children of previous owners', async () => {
  await prepareDaemonWorkerSandbox(root);
  const oldDaemon = deadPid();
  ageOwner(oldDaemon);
  await prepareDaemonWorkerSandbox(root);
  await collectDaemonScratch(false, [{ pid: process.pid, daemonPid: oldDaemon }]);
  expect(existsSync(runtime())).toBe(true);
});
