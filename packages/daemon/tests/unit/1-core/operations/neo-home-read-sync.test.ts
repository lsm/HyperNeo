import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNeoHomeOperations } from '../../../../src/lib/neo/home/operations.ts';
import { NeoHomeRepository } from '../../../../src/lib/neo/home/repository.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import { spawnProcess } from '../../../../src/lib/runtime-spawn/index.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { createTestDb } from '../../../helpers/database.ts';

let fixture: string, root: string, peer: string, remote: string;
let db: Awaited<ReturnType<typeof createTestDb>>;
let home: NeoHomeRepository;
let previous: Map<string, string | undefined>;
const human: OperationCaller = { source: 'rpc', principal: 'local' };
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
async function version(text: string) {
  await writeFile(join(peer, 'direction.md'), text);
  await writeFile(join(peer, 'mandate.md'), `Mandate ${text}`);
  await git(peer, 'add', '.');
  await git(peer, 'commit', '-m', text);
  await git(peer, 'push', 'origin', 'main');
}
async function read(
  path = 'direction.md',
  caller: OperationCaller = {
    source: 'mcp',
    sessionId: 'neo:root',
    role: 'neo',
  }
) {
  const repo = new NeoRepository(db.getDatabase());
  const registry = createOperationRegistry(
    createNeoHomeOperations(
      {
        repo,
        todos: new NeoAskTodoRepository(db.getDatabase()),
        defaultSessionId: () => 'neo:root',
      },
      home
    )
  );
  const result = await invokeOperation(registry, 'neo.home.read', { path }, caller);
  if (result.kind !== 'completed') throw new Error(result.message);
  return result.value as { ok: boolean; reason?: string; content?: string };
}
async function pulls() {
  return (await readFile(join(fixture, 'pulls'), 'utf8').catch(() => ''))
    .trim()
    .split('\n')
    .filter(Boolean).length;
}
beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'neo-home-read-sync-'));
  root = join(fixture, 'Neo');
  peer = join(fixture, 'peer');
  remote = join(fixture, 'remote.git');
  previous = new Map(
    ['PATH', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'].map((key) => [key, process.env[key]])
  );
  process.env.GIT_CONFIG_GLOBAL = join(fixture, 'gitconfig');
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  await writeFile(
    process.env.GIT_CONFIG_GLOBAL,
    '[user]\n name = Synthetic Neo\n email = test@example.invalid\n[commit]\n gpgsign = false\n'
  );
  await mkdir(peer);
  await git(peer, 'init', '--initial-branch=main', '--quiet');
  await writeFile(join(peer, 'direction.md'), 'Initial');
  await writeFile(join(peer, 'mandate.md'), 'Initial mandate');
  await writeFile(join(peer, '.gitignore'), '.coordinators/\n.claude/\nworktrees/\n');
  await git(peer, 'add', '.');
  await git(peer, 'commit', '-m', 'Initial');
  await git(fixture, 'clone', '--bare', peer, remote);
  await git(peer, 'remote', 'add', 'origin', remote);
  db = await createTestDb();
  home = new NeoHomeRepository(root, new NeoRepository(db.getDatabase()));
  expect(await home.init(remote)).toMatchObject({ ok: true });
  await mkdir(join(fixture, 'bin'));
  const shim = join(fixture, 'bin', 'git');
  await writeFile(
    shim,
    `#!/bin/sh\nfor arg do\n if [ "$arg" = fetch ]; then printf 'pull\\n' >> '${fixture}/pulls'; fi\ndone\nexec /usr/bin/git "$@"\n`
  );
  await chmod(shim, 0o755);
  process.env.PATH = `${join(fixture, 'bin')}:${process.env.PATH}`;
});
afterEach(async () => {
  db?.close();
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(fixture, { recursive: true, force: true });
});

describe('Curated home reads within a Neo wake', () => {
  test('Neo tool reads refresh the same way as human reads without a runtime wake', async () => {
    await version('Peer one');
    expect(await read()).toMatchObject({ ok: true, content: 'Peer one' });
    await version('Peer two');
    expect(await read()).toMatchObject({ ok: true, content: 'Peer two' });
    expect(await pulls()).toBe(2);
  });
  test('a failed sync retries on the next read', async () => {
    await git(root, 'remote', 'set-url', 'origin', join(fixture, 'missing.git'));
    expect(await read()).toMatchObject({
      ok: false,
      reason: expect.stringContaining('sync_failed'),
    });
    await git(root, 'remote', 'set-url', 'origin', remote);
    await version('Available again');
    expect(await read()).toMatchObject({ ok: true, content: 'Available again' });
    expect(await pulls()).toBe(2);
  });
  test('human RPC reads each attempt a fresh sync', async () => {
    await version('Human first');
    expect(await read('direction.md', human)).toMatchObject({ content: 'Human first' });
    await version('Human second');
    expect(await read('direction.md', human)).toMatchObject({ content: 'Human second' });
    expect(await pulls()).toBe(2);
  });
  test('refuses to sync dirty remote-backed work without changing human edits or HEAD', async () => {
    await writeFile(join(root, 'direction.md'), 'Human uncommitted edit');
    const head = await git(root, 'rev-parse', 'HEAD');
    await version('Remote edit');
    const failed = await read();
    expect(failed).toMatchObject({ ok: false, reason: expect.stringContaining('sync_failed') });
    expect(await readFile(join(root, 'direction.md'), 'utf8')).toBe('Human uncommitted edit');
    expect(await git(root, 'rev-parse', 'HEAD')).toBe(head);
    expect(await pulls()).toBe(1);
    await writeFile(join(root, 'direction.md'), 'Initial');
    expect(await read()).toMatchObject({ content: 'Remote edit' });
  });
  test('revalidates a document replaced by a symlink during sync', async () => {
    const outside = join(fixture, 'outside.md');
    await writeFile(outside, 'Outside contents');
    await rm(join(peer, 'direction.md'));
    await symlink(outside, join(peer, 'direction.md'));
    await git(peer, 'add', '.');
    await git(peer, 'commit', '-m', 'Synthetic link');
    await git(peer, 'push', 'origin', 'main');
    expect(await read()).toMatchObject({
      ok: false,
      reason: expect.stringContaining('symbolic link'),
    });
    expect(await pulls()).toBe(1);
  });
  test('a missing local document can be supplied by the remote without initializing a new home', async () => {
    await writeFile(join(peer, 'new.md'), 'New document');
    await git(peer, 'add', '.');
    await git(peer, 'commit', '-m', 'New document');
    await git(peer, 'push', 'origin', 'main');
    expect(await read('new.md')).toMatchObject({ ok: true, content: 'New document' });
  });
  test('local-only human edits remain readable without a pull', async () => {
    await git(root, 'remote', 'remove', 'origin');
    await writeFile(join(root, 'direction.md'), 'Local only');
    expect(await read()).toMatchObject({ ok: true, content: 'Local only' });
    expect(await pulls()).toBe(0);
  });
  test('returns a rebase conflict without altering the local committed document', async () => {
    await writeFile(join(root, 'direction.md'), 'Local committed choice');
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'Local choice');
    const head = await git(root, 'rev-parse', 'HEAD');
    await version('Remote conflicting choice');
    const failed = await read();
    expect(failed).toMatchObject({ ok: false, reason: expect.stringContaining('conflict') });
    expect(await readFile(join(root, 'direction.md'), 'utf8')).toBe('Local committed choice');
    expect(await git(root, 'rev-parse', 'HEAD')).toBe(head);
    expect(await read('mandate.md')).toEqual(failed);
    expect(await pulls()).toBe(2);
  });
});

describe('Home sync conflict questions', () => {
  test('preserves both full versions in one revision-bound question across retries and restart', async () => {
    const local = `Human local choice\n${'Local text with trailing spaces  \n'.repeat(80)}`;
    const remoteText = `Other machine choice\n${'Remote full text\n'.repeat(80)}`;
    await writeFile(join(root, 'direction.md'), local);
    await git(root, 'add', 'direction.md');
    await git(root, 'commit', '-m', 'Human local choice');
    const localHead = await git(root, 'rev-parse', 'HEAD');
    await version(remoteText);
    const remoteHead = await git(peer, 'rev-parse', 'HEAD');
    const first = await read();
    expect(first).toMatchObject({ ok: false, reason: expect.stringContaining('conflict') });
    const store = new NeoAskTodoRepository(db.getDatabase());
    const questions = store.listAsks(undefined, 100).flatMap((ask) => store.listQuestions(ask.id));
    expect(questions).toHaveLength(1);
    const question = questions[0] as (typeof questions)[number] & { document: string };
    expect(question.text.length).toBeLessThan(1800);
    expect(question.text).toContain('direction.md');
    expect(question.text).toContain('Human local choice');
    expect(question.text).toContain('Other machine choice');
    expect(question.text).toContain('not apply');
    expect(question.confirm).toBeNull();
    expect(question.text).toContain('View full report before choosing');
    expect(question.document).toContain(local);
    expect(question.document).toContain(remoteText);
    expect(question.document).toContain(localHead);
    expect(question.document).toContain(remoteHead);
    expect(question.kind).toBe('choice');
    expect(await readFile(join(root, 'direction.md'), 'utf8')).toBe(local);
    expect(await git(root, 'rev-parse', 'HEAD')).toBe(localHead);
    expect(await git(root, 'status', '--porcelain')).toBe('');
    expect(await git(peer, 'rev-parse', 'HEAD')).toBe(remoteHead);
    await read('mandate.md');
    home = new NeoHomeRepository(root, new NeoRepository(db.getDatabase()));
    await read();
    store.answerQuestion(question, ['Keep local'], 'button', Date.now());
    await read();
    expect(
      store.listAsks(undefined, 100).flatMap((ask) => store.listQuestions(ask.id))
    ).toHaveLength(1);
    expect(store.getQuestion(question.id)).toMatchObject({
      state: 'answered',
      document: question.document,
    });
    expect(await readFile(join(root, 'direction.md'), 'utf8')).toBe(local);
    expect(await git(root, 'rev-parse', 'HEAD')).toBe(localHead);
  });
});

describe('Conflict document filenames', () => {
  test('keeps a leading-space path and both add/add versions intact', async () => {
    const path = ' notes.md';
    await writeFile(join(root, path), 'Local complete text\n');
    await git(root, 'add', '--', path);
    await git(root, 'commit', '-m', 'Local notes');
    await writeFile(join(peer, path), 'Remote complete text\n');
    await git(peer, 'add', '--', path);
    await git(peer, 'commit', '-m', 'Remote notes');
    await git(peer, 'push', 'origin', 'main');
    expect(await read()).toMatchObject({ ok: false, reason: expect.stringContaining('conflict') });
    const store = new NeoAskTodoRepository(db.getDatabase());
    const questions = store.listAsks(undefined, 100).flatMap((ask) => store.listQuestions(ask.id));
    expect(questions).toHaveLength(1);
    expect(questions[0].document).toContain('File: " notes.md"');
    expect(questions[0].document).toContain('Local complete text\n');
    expect(questions[0].document).toContain('Remote complete text\n');
    expect(await readFile(join(root, path), 'utf8')).toBe('Local complete text\n');
    expect(await git(root, 'status', '--porcelain')).toBe('');
  });
});

describe('Conflict snapshot failure recovery', () => {
  test('still aborts its own rebase when reading the fetched revision fails', async () => {
    await writeFile(join(root, 'direction.md'), 'Local preserved\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'Local preserved');
    const head = await git(root, 'rev-parse', 'HEAD');
    await version('Remote preserved');
    await writeFile(
      join(fixture, 'bin', 'git'),
      `#!/bin/sh\nfor arg do\n if [ "$arg" = FETCH_HEAD ]; then echo 'synthetic snapshot failure' >&2; exit 7; fi\ndone\nexec /usr/bin/git "$@"\n`
    );
    await expect(read()).rejects.toThrow('synthetic snapshot failure');
    expect(await readFile(join(root, 'direction.md'), 'utf8')).toBe('Local preserved\n');
    expect(await git(root, 'rev-parse', 'HEAD')).toBe(head);
    expect(await git(root, 'status', '--porcelain')).toBe('');
  });
});
