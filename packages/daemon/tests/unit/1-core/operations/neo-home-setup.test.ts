import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNeoHomeOperations } from '../../../../src/lib/neo/home/operations.ts';
import { NeoHomeRepository } from '../../../../src/lib/neo/home/repository.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import type { OperationCaller } from '../../../../src/lib/operations/registry.ts';
import { spawnProcess } from '../../../../src/lib/runtime-spawn/index.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { createTestDb } from '../../../helpers/database.ts';

let fixture: string;
let root: string;
let oldConfig: string | undefined;
let db: Awaited<ReturnType<typeof createTestDb>>;
let repo: NeoRepository;
let home: NeoHomeRepository;
const git = async (...args: string[]) => {
  const child = spawnProcess(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const [text, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code) throw new Error(error);
  return text.trim();
};
const init = async (caller: OperationCaller = { source: 'rpc', principal: 'local' }) => {
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
  const result = await invokeOperation(registry, 'neo.home.init', {}, caller);
  if (result.kind !== 'completed') throw new Error(JSON.stringify(result));
  return result.value as {
    ok: boolean;
    reason?: string;
    path?: string;
    projects?: { id: string; homePath: string }[];
  };
};
beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'neo-home-setup-'));
  root = join(fixture, 'Neo');
  oldConfig = process.env.GIT_CONFIG_GLOBAL;
  await writeFile(
    join(fixture, 'gitconfig'),
    '[user]\n name = Verify Neo\n email = verify@example.invalid\n[commit]\n gpgsign = false\n'
  );
  process.env.GIT_CONFIG_GLOBAL = join(fixture, 'gitconfig');
  await mkdir(root);
  await git('init', '--quiet');
  await git('config', 'user.name', 'Verify Neo');
  await git('config', 'user.email', 'verify@example.invalid');
  await git('config', 'commit.gpgsign', 'false');
  db = await createTestDb();
  repo = new NeoRepository(db.getDatabase());
  home = new NeoHomeRepository(root, repo);
});
afterEach(async () => {
  db.close();
  if (oldConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = oldConfig;
  await rm(fixture, { recursive: true, force: true });
});

describe('Neo home setup', () => {
  test('reserves project paths without running project SQL through the main repository', async () => {
    repo.saveProject({ id: 'synthetic-home', title: 'Synthetic', summary: '', context: '' }, 0);
    const list = spyOn(repo, 'listProjects').mockImplementation(() => {
      throw new Error('project reservation used the main repository');
    });
    try {
      const result = await init();
      expect(result.ok).toBe(true);
      expect(result.projects).toHaveLength(1);
      const reserved = result.projects![0];
      expect(reserved.id).toBe('synthetic-home');
      expect(repo.getProject(reserved.id)?.homePath).toBe(reserved.homePath);
      expect(await readFile(join(root, 'direction.md'), 'utf8')).toBe('');
    } finally {
      list.mockRestore();
    }
  });
  test('initializes a local repository once and keeps coordinator transcripts untracked', async () => {
    await mkdir(join(root, '.coordinators', 'neo'), { recursive: true });
    await writeFile(join(root, '.coordinators', 'neo', 'transcript.md'), 'Private conversation.');
    const results = await Promise.all([init(), init()]);
    expect(results).toEqual([
      { ok: true, path: root, projects: [] },
      { ok: true, path: root, projects: [] },
    ]);
    expect(await git('rev-list', '--count', 'HEAD')).toBe('1');
    expect(await git('ls-files')).toBe('.gitignore\nREADME.md\ndirection.md');
    expect(await readFile(join(root, 'direction.md'), 'utf8')).toBe('');
    expect(await git('status', '--porcelain')).toBe('');
    expect(await git('log', '-1', '--format=%an <%ae>')).toBe(
      'Verify Neo <verify@example.invalid>'
    );
  });
  test('repairs a missing coordinator ignore without tracking transcripts', async () => {
    await init();
    await rm(join(root, '.gitignore'));
    await git('commit', '-am', 'Existing home without coordinator ignore');
    await mkdir(join(root, '.coordinators', 'neo'), { recursive: true });
    const transcript = join(root, '.coordinators', 'neo', 'transcript.md');
    await writeFile(transcript, 'Private conversation.');
    expect(await init()).toMatchObject({ ok: true });
    expect(await readFile(transcript, 'utf8')).toBe('Private conversation.');
    expect(await git('status', '--porcelain')).toBe('');
    expect(await git('ls-files', '.coordinators')).toBe('');
    expect(await git('check-ignore', '.coordinators/neo/transcript.md')).toBe(
      '.coordinators/neo/transcript.md'
    );
  });
  test.each(['missing', 'existing'])(
    'retries failed ignore repair with %s ignore',
    async (state) => {
      await init();
      if (state === 'missing') await rm(join(root, '.gitignore'));
      else await writeFile(join(root, '.gitignore'), 'scratch/\n');
      await rm(join(root, 'README.md'));
      await rm(join(root, 'direction.md'));
      await git('add', '-A');
      await git('commit', '-m', 'Existing home without coordinator ignore');
      const before = await git('rev-parse', 'HEAD');
      await git('config', 'user.name', '');
      await git('config', 'user.email', '');
      await expect(init()).rejects.toThrow();
      expect(await git('status', '--porcelain')).toBe('');
      await git('config', 'user.name', 'Verify Neo');
      await git('config', 'user.email', 'verify@example.invalid');
      expect(await init()).toMatchObject({ ok: true });
      expect(await git('rev-parse', 'HEAD')).not.toBe(before);
      expect(await git('status', '--porcelain')).toBe('');
    }
  );
  test.each(['untracked document', 'staged transcript'])(
    'repairs ignores alongside unrelated changes: %s',
    async (change) => {
      await init();
      await rm(join(root, '.gitignore'));
      await git('commit', '-am', 'Existing home without coordinator ignore');
      const path = change === 'staged transcript' ? '.coordinators/draft.md' : 'human.md';
      await mkdir(join(root, '.coordinators'), { recursive: true });
      await writeFile(join(root, path), 'Human draft.');
      if (change === 'staged transcript') await git('add', path);
      const before = await git('status', '--porcelain', '-z');
      expect(await init()).toMatchObject({ ok: true });
      expect(await git('status', '--porcelain', '-z')).toBe(before);
    }
  );
  test('assigns stable project folders across renames and service recreation', async () => {
    repo.saveProject({ id: 'project-release', title: 'Release', summary: '', context: '' }, 0);
    const first = await init();
    const project = repo.getProject('project-release')!;
    const path = first.projects![0].homePath;
    expect(path).toMatch(/^projects\/release-/);
    repo.saveProject({ ...project, title: 'Renamed' }, project.revision);
    home = new NeoHomeRepository(root, repo);
    expect((await init()).projects).toEqual(first.projects);
    expect(repo.getProject(project.id)?.homePath).toBe(path);
    await writeFile(join(root, path, 'digest.md'), 'Progress survives rename.');
    expect(await readFile(join(root, path, 'digest.md'), 'utf8')).toBe('Progress survives rename.');
  });
  test.each(['identity', 'signing'])(
    'recovers after %s configuration is fixed',
    async (failure) => {
      await git('init', '--quiet');
      if (failure === 'identity') {
        await git('config', 'user.name', '');
        await git('config', 'user.email', '');
      } else {
        await git('config', 'commit.gpgsign', 'true');
        await git('config', 'gpg.format', 'openpgp');
        await git('config', 'gpg.program', '/usr/bin/false');
      }
      await expect(init()).rejects.toThrow();
      expect(await git('diff', '--cached', '--name-only')).toBe('');
      await git('config', 'user.name', 'Verify Neo');
      await git('config', 'user.email', 'verify@example.invalid');
      await git('config', 'commit.gpgsign', 'false');
      expect(await init()).toMatchObject({ ok: true });
      expect(await git('status', '--porcelain')).toBe('');
      expect(await git('rev-list', '--count', 'HEAD')).toBe('1');
    }
  );
  test('recovers the staged bootstrap after service interruption', async () => {
    await writeFile(join(root, 'README.md'), 'Preserved home introduction.');
    await writeFile(join(root, 'direction.md'), '');
    await writeFile(join(root, '.gitignore'), '.coordinators/\n');
    await git('add', '--', 'README.md', '.gitignore', 'direction.md');
    home = new NeoHomeRepository(root, repo);
    expect(await init()).toMatchObject({ ok: true });
    expect(await git('rev-list', '--count', 'HEAD')).toBe('1');
    expect(await git('status', '--porcelain')).toBe('');
    expect(await readFile(join(root, 'README.md'), 'utf8')).toBe('Preserved home introduction.');
  });
  test('bootstraps without committing pre-existing staged changes', async () => {
    await git('init', '--quiet');
    await writeFile(join(root, 'human.md'), 'Human draft.');
    await git('add', 'human.md');
    expect(await init()).toMatchObject({ ok: true });
    expect(await git('diff', '--cached', '--name-only')).toBe('human.md');
  });
  test('belongs to the local human or root Neo', async () => {
    expect(await init({ source: 'mcp', sessionId: 'worker', role: 'neo' })).toMatchObject({
      ok: false,
    });
    expect(await init({ source: 'mcp', sessionId: 'neo:root', role: 'neo' })).toMatchObject({
      ok: true,
    });
  });
});
