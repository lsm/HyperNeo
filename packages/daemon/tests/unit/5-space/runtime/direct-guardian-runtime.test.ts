import { afterEach, beforeEach, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { runDirectGuardian } from '../../../../src/lib/space/runtime/direct-guardian-runtime';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { DirectTaskExecutionRepository } from '../../../../src/storage/repositories/direct-task-execution-repository';
import {
  DirectProcessOwnershipRepository,
  type DirectProcessLaunch,
} from '../../../../src/storage/repositories/direct-process-ownership-repository';

let dir: string;
let db: Database;
let ledger: DirectProcessOwnershipRepository;
let attempts: DirectTaskExecutionRepository;
let launch: DirectProcessLaunch;
let configPath: string;
let parents: ChildProcess[];
let ownedPids: number[];
let diagnostics: string;
const fixture = resolve(import.meta.dirname, '../../../helpers/direct-guardian-fixture.ts');
const bun = process.env.BUN_BINARY ?? 'bun';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'guardian-runtime-'));
  const dbPath = join(dir, 'db.sqlite');
  db = new Database(dbPath);
  runMigrations(db, () => {});
  createTables(db);
  const spaceId = new SpaceRepository(db).createSpace({
    name: 'Space',
    slug: 'space',
    workspacePath: dir,
  }).id;
  const taskId = new SpaceTaskRepository(db).createTask({
    spaceId,
    title: 'Task',
    description: '',
  }).id;
  attempts = new DirectTaskExecutionRepository(db);
  attempts.select(taskId);
  attempts.claim(taskId, 'attempt', 'worker');
  ledger = new DirectProcessOwnershipRepository(db);
  const identity = { attemptId: 'attempt', sessionId: 'worker', generation: 1 };
  ledger.manageAttempt(identity);
  attempts.activate('attempt', 'worker');
  launch = ledger.reserveLaunch(identity)!;
  configPath = join(dir, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({ dbPath, launch, command: bun, args: [fixture, 'sdk', configPath] })
  );
  diagnostics = '';
  parents = [];
  ownedPids = [];
});
afterEach(async () => {
  for (const parent of parents) parent.kill('SIGKILL');
  for (const pid of ownedPids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
async function until(predicate: () => boolean) {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Guardian condition timed out: ${diagnostics}`);
}
function startParent() {
  const child = spawn(bun, [fixture, 'parent', configPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  parents.push(child);
  const events: Array<{ kind: string; pid?: number; data?: string }> = [];
  let errors = '';
  child.stderr!.on('data', (data) => {
    errors += data.toString();
    diagnostics += data.toString();
  });
  createInterface({ input: child.stdout! }).on('line', (line) => {
    const event = JSON.parse(line);
    events.push(event);
    diagnostics += `${line}\n`;
    if (typeof event.pid === 'number') ownedPids.push(event.pid);
  });
  return { child, events, errors: () => errors };
}
async function startRoot() {
  const parent = startParent();
  await until(() => parent.events.some(({ kind }) => kind === 'ready'));
  expect(ledger.authorizeLaunch(launch)).toBe(true);
  parent.child.stdin!.write('{"kind":"go"}\n');
  await until(() => parent.events.some(({ kind }) => kind === 'root_started'));
  await until(() =>
    parent.events.some(({ kind, data }) => kind === 'sdk_data' && data === 'sdk-stdio-roundtrip')
  );
  return parent;
}

test('daemon death before GO records never_started without launching SDK', async () => {
  const parent = startParent();
  await until(() => parent.events.some(({ kind }) => kind === 'ready'));
  parent.child.kill('SIGKILL');
  await until(() => ledger.get(launch)?.state === 'never_started');
  expect(() => readFileSync(`${configPath}.spawns`)).toThrow();
});

test('daemon death after GO stops the actual SDK root and persists its exit receipt', async () => {
  const parent = await startRoot();
  await until(() =>
    parent.events.some(({ kind, data }) => kind === 'sdk_data' && data === 'sdk-stdio-roundtrip')
  );
  parent.child.stdin!.write('{"kind":"go"}\n');
  parent.child.kill('SIGKILL');
  await until(() => ledger.get(launch)?.state === 'exited');
  const root = parent.events.find(({ kind }) => kind === 'root_started')!;
  expect(() => process.kill(root.pid!, 0)).toThrow();
  expect(readFileSync(`${configPath}.spawns`, 'utf8').trim().split('\n')).toHaveLength(1);
});

test('guardian loss cannot create a root-exit receipt', async () => {
  const parent = await startRoot();
  const owner = parent.events.find(({ kind }) => kind === 'owner')!;
  const root = parent.events.find(({ kind }) => kind === 'root_started')!;
  process.kill(owner.pid!, 'SIGKILL');
  await until(() => parent.events.some(({ kind }) => kind === 'owner_exit'));
  expect(ledger.get(launch)?.state).toBe('authorized');
  expect(() => process.kill(root.pid!, 0)).not.toThrow();
});

test('terminal-write failure retains unknown state and retries the same receipt without respawn', async () => {
  const parent = await startRoot();
  db.exec(
    "CREATE TRIGGER reject_root_receipt BEFORE UPDATE OF state ON direct_task_process_launches WHEN NEW.state = 'exited' BEGIN SELECT RAISE(ABORT, 'receipt unavailable'); END;"
  );
  parent.child.kill('SIGKILL');
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(ledger.get(launch)?.state).toBe('authorized');
  db.exec('DROP TRIGGER reject_root_receipt');
  await until(() => ledger.get(launch)?.state === 'exited');
  expect(readFileSync(`${configPath}.spawns`, 'utf8').trim().split('\n')).toHaveLength(1);
});

test('a second guardian cannot claim an existing launch or send READY', async () => {
  const first = startParent();
  await until(() => first.events.some(({ kind }) => kind === 'ready'));
  const instance = ledger.get(launch)?.guardianInstance;
  const second = startParent();
  await until(() => second.events.some(({ kind }) => kind === 'owner_exit'));
  expect(second.events.some(({ kind }) => kind === 'ready')).toBe(false);
  expect(second.errors()).toContain('already has a guardian');
  expect(ledger.get(launch)?.guardianInstance).toBe(instance);
  first.child.kill('SIGKILL');
  await until(() => ledger.get(launch)?.state === 'never_started');
});

test('stop fence between authorization and GO prevents SDK launch', async () => {
  const parent = startParent();
  await until(() => parent.events.some(({ kind }) => kind === 'ready'));
  ledger.authorizeLaunch(launch);
  attempts.requestStop('attempt', 'worker', 'cancelled');
  parent.child.stdin!.write('{"kind":"go"}\n');
  await until(() => ledger.get(launch)?.state === 'never_started');
  expect(() => readFileSync(`${configPath}.spawns`)).toThrow();
});

test('wrong launch identity fails before READY or SDK construction', async () => {
  const replies = new PassThrough();
  let ready = false;
  replies.on('data', () => {
    ready = true;
  });
  await expect(
    runDirectGuardian(
      {
        dbPath: join(dir, 'db.sqlite'),
        launch: { ...launch, token: 'wrong' },
        command: bun,
        args: [],
      },
      new PassThrough(),
      replies,
      new PassThrough(),
      new PassThrough()
    )
  ).rejects.toThrow('unavailable');
  expect(ready).toBe(false);
  expect(ledger.get(launch)?.guardianInstance).toBeNull();
});
