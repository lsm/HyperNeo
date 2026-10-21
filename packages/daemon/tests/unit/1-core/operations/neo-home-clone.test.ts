import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NeoHomeRepository } from '../../../../src/lib/neo/home/repository.ts';
import { createNeoHomeOperations } from '../../../../src/lib/neo/home/operations.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import { spawnProcess } from '../../../../src/lib/runtime-spawn/index.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { createTestDb } from '../../../helpers/database.ts';

const human: OperationCaller = { source: 'rpc', principal: 'local' };
const neo: OperationCaller = { source: 'mcp', sessionId: 'neo:root', role: 'neo' };
let fixture: string, root: string, remote: string;
let db: Awaited<ReturnType<typeof createTestDb>>;
let home: NeoHomeRepository;
let previous: Map<string, string | undefined>;
async function git(cwd: string, ...args: string[]) {
  const child = spawnProcess(['git', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [text, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code) throw new Error(error);
  return text.trim();
}
async function call(input: unknown, caller = human) {
  const repo = new NeoRepository(db.getDatabase());
  const result = await invokeOperation(
    createOperationRegistry(
      createNeoHomeOperations(
        {
          repo,
          todos: new NeoAskTodoRepository(db.getDatabase()),
          defaultSessionId: () => neo.sessionId!,
        },
        home
      )
    ),
    'neo.home.init',
    input,
    caller
  );
  if (result.kind !== 'completed') throw new Error(result.message);
  return result.value;
}
beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'neo-home-clone-'));
  root = join(fixture, 'Neo');
  remote = join(fixture, 'remote.git');
  await mkdir(join(root, '.coordinators', 'second'), { recursive: true });
  await writeFile(
    join(root, '.coordinators', 'second', 'transcript.md'),
    'Private second-machine transcript'
  );
  const config = join(fixture, 'gitconfig');
  await writeFile(
    config,
    '[user]\n name = Synthetic Neo\n email = verify@example.invalid\n[commit]\n gpgsign = false\n'
  );
  previous = new Map(
    ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'].map((key) => [key, process.env[key]])
  );
  process.env.GIT_CONFIG_GLOBAL = config;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  const source = join(fixture, 'source');
  await mkdir(join(source, 'projects', 'shared'), { recursive: true });
  await writeFile(join(source, 'README.md'), '# Shared home\n');
  await writeFile(join(source, '.gitignore'), '.coordinators/\n');
  await writeFile(join(source, 'direction.md'), 'Human direction from the first machine\n');
  await writeFile(join(source, 'projects', 'shared', 'mandate.md'), 'Shared project mandate\n');
  await git(source, 'init', '--initial-branch=main', '--quiet');
  await git(source, 'add', '.');
  await git(source, 'commit', '-m', 'First machine home');
  await git(fixture, 'clone', '--bare', source, remote);
  db = await createTestDb();
  home = new NeoHomeRepository(root, new NeoRepository(db.getDatabase()));
});
afterEach(async () => {
  db?.close();
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(fixture, { recursive: true, force: true });
});

describe('Second-machine home configuration', () => {
  test('clones the selected shared history, configures origin/upstream and keeps local transcripts private', async () => {
    expect(await call({ remoteUrl: remote })).toMatchObject({ ok: true, path: root });
    expect(await git(root, 'rev-parse', 'HEAD')).toBe(
      await git(fixture, '--git-dir', remote, 'rev-parse', 'HEAD')
    );
    expect(await git(root, 'remote', 'get-url', 'origin')).toBe(remote);
    expect(await git(root, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/main');
    expect(await readFile(join(root, 'direction.md'), 'utf8')).toBe(
      'Human direction from the first machine\n'
    );
    expect(await readFile(join(root, 'projects', 'shared', 'mandate.md'), 'utf8')).toBe(
      'Shared project mandate\n'
    );
    expect(await readFile(join(root, '.coordinators', 'second', 'transcript.md'), 'utf8')).toBe(
      'Private second-machine transcript'
    );
    expect(await git(root, 'ls-files', '.coordinators')).toBe('');
    expect(await git(root, 'status', '--porcelain')).toBe('');
    expect((await readdir(fixture)).filter((name) => name.startsWith('.neo-clone-'))).toEqual([]);
  });
  test('remembers the same selection and refuses a different origin without changing files or history', async () => {
    expect(await call({ remoteUrl: remote })).toMatchObject({ ok: true });
    const head = await git(root, 'rev-parse', 'HEAD');
    expect(await call({ remoteUrl: remote })).toMatchObject({ ok: true });
    expect(await call({})).toMatchObject({ ok: true });
    expect(await call({ remoteUrl: join(fixture, 'another.git') })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('remote_exists'),
    });
    expect(await git(root, 'rev-parse', 'HEAD')).toBe(head);
    expect(await git(root, 'remote', 'get-url', 'origin')).toBe(remote);
  });
  test('requires the human to select the remote while root Neo can still initialize locally', async () => {
    expect(await call({ remoteUrl: remote }, neo)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('human_selection_required'),
    });
    expect(await readdir(root)).toEqual(['.coordinators']);
    expect(await call({}, neo)).toMatchObject({ ok: true });
  });
  test('never replaces a pre-existing curated document', async () => {
    await writeFile(join(root, 'notes.txt'), 'Human local notes');
    expect(await call({ remoteUrl: remote })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('home_exists'),
    });
    expect(await readFile(join(root, 'notes.txt'), 'utf8')).toBe('Human local notes');
    expect((await readdir(root)).sort()).toEqual(['.coordinators', 'notes.txt']);
  });
  test('an inaccessible or empty remote leaves the original home untouched', async () => {
    expect(await call({ remoteUrl: join(fixture, 'missing.git') })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('clone_failed'),
    });
    expect(await readdir(root)).toEqual(['.coordinators']);
    const empty = join(fixture, 'empty.git');
    await git(fixture, 'init', '--bare', empty);
    expect(await call({ remoteUrl: empty })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('empty_remote'),
    });
    expect(await readdir(root)).toEqual(['.coordinators']);
  });
});
