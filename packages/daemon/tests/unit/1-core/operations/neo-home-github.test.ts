import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNeoHomeGithubOperation } from '../../../../src/lib/neo/home/github.ts';
import { NeoHomeRepository } from '../../../../src/lib/neo/home/repository.ts';
import { createNeoQuestionOperations } from '../../../../src/lib/neo/question-operations.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import { spawnProcess } from '../../../../src/lib/runtime-spawn/index.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { createTestDb } from '../../../helpers/database.ts';

const human: OperationCaller = { source: 'rpc', principal: 'local' };
const owner: OperationCaller = { source: 'mcp', sessionId: 'neo:root', role: 'neo' };
let fixture: string;
let root: string;
let db: Awaited<ReturnType<typeof createTestDb>>;
let home: NeoHomeRepository;
let todos: NeoAskTodoRepository;
let oldPath: string | undefined;
let oldFixture: string | undefined;
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
const call = async (input: unknown, caller = owner, name = 'neo.home.github') => {
  const result = await invokeOperation(
    createOperationRegistry([
      createNeoHomeGithubOperation(
        {
          db,
          repo: new NeoRepository(db.getDatabase()),
          todos,
          defaultSessionId: () => owner.sessionId!,
        },
        home
      ),
      ...createNeoQuestionOperations(
        todos,
        async () => {},
        async () => ({ ok: true })
      ),
    ]),
    name,
    input,
    caller
  );
  if (result.kind !== 'completed') throw new Error(result.message);
  return result.value as {
    ok: boolean;
    reason?: string;
    status?: string;
    questionId: string;
    repository?: string;
  };
};
const answer = (questionId: string, value = 'yes', caller = human) =>
  call({ questionId, answer: value }, caller, 'neo.question.answer');
const log = async () => readFile(join(fixture, 'calls'), 'utf8').catch(() => '');
beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'neo-home-github-'));
  root = join(fixture, 'Neo');
  await mkdir(root);
  await mkdir(join(fixture, 'bin'));
  oldPath = process.env.PATH;
  oldFixture = process.env.NEO_GITHUB_FIXTURE;
  process.env.PATH = `${fixture}/bin:${oldPath}`;
  process.env.NEO_GITHUB_FIXTURE = fixture;
  await writeFile(
    join(fixture, 'bin', 'gh'),
    `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$NEO_GITHUB_FIXTURE/calls"
case "$*" in
 'auth status') test ! -f "$NEO_GITHUB_FIXTURE/unavailable" ;;
 'api user --jq .login') echo fixture-owner ;;
 'repo create fixture-owner/neo-home --private --source . --remote origin --push')
   test ! -f "$NEO_GITHUB_FIXTURE/fail-create"
   git remote add origin "$NEO_GITHUB_FIXTURE/remote.git"
   git push -u origin HEAD ;;
 *) exit 97 ;;
esac
`
  );
  await chmod(join(fixture, 'bin', 'gh'), 0o755);
  await git('init', '--quiet');
  await git('config', 'user.name', 'Verify Neo');
  await git('config', 'user.email', 'verify@example.invalid');
  await git('config', 'commit.gpgsign', 'false');
  await git('init', '--bare', join(fixture, 'remote.git'));
  db = await createTestDb();
  todos = new NeoAskTodoRepository(db.getDatabase());
  todos.openAsk({
    id: 'ask',
    projectId: null,
    sessionId: owner.sessionId!,
    originMessageId: null,
    title: 'Synthetic home',
    request: 'Set up my home',
    createdAt: 1,
  });
  home = new NeoHomeRepository(root, new NeoRepository(db.getDatabase()));
  await home.init();
});
afterEach(async () => {
  db?.close();
  if (oldPath === undefined) delete process.env.PATH;
  else process.env.PATH = oldPath;
  if (oldFixture === undefined) delete process.env.NEO_GITHUB_FIXTURE;
  else process.env.NEO_GITHUB_FIXTURE = oldFixture;
  await rm(fixture, { recursive: true, force: true });
});

describe('Neo private GitHub home proposal', () => {
  test('does not publish credential-like bytes in an existing commit message', async () => {
    await git('commit', '--allow-empty', '-m', 'Rotate ghp_' + 'synthetic'.repeat(5));
    const proposed = await call({ askId: 'ask' });
    await answer(proposed.questionId);
    const result = await call({ questionId: proposed.questionId });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('content_refused');
    expect(await log()).not.toContain('repo create');
  });
  test('does not publish credentials added only in a merge resolution', async () => {
    const branch = await git('symbolic-ref', '--short', 'HEAD');
    await git('switch', '-c', 'side');
    await writeFile(join(root, 'side.md'), 'Side progress.');
    await git('add', 'side.md');
    await git('commit', '-m', 'Side progress');
    await git('switch', branch);
    await writeFile(join(root, 'main.md'), 'Main progress.');
    await git('add', 'main.md');
    await git('commit', '-m', 'Main progress');
    await git('merge', '--no-ff', '--no-commit', 'side');
    await writeFile(join(root, 'fixture.md'), 'TOKEN=' + 'synthetic'.repeat(4));
    await git('add', 'fixture.md');
    await git('commit', '-m', 'Merge resolution');
    const proposed = await call({ askId: 'ask' });
    await answer(proposed.questionId);
    const result = await call({ questionId: proposed.questionId });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('content_refused');
    expect(await log()).not.toContain('repo create');
  });

  test('asks once and creates/pushes only the human-approved bound private repository', async () => {
    const proposed = await call({ askId: 'ask' });
    expect(proposed).toMatchObject({
      ok: true,
      status: 'proposed',
      repository: 'fixture-owner/neo-home',
    });
    expect(todos.getQuestion(proposed.questionId)).toMatchObject({
      state: 'open',
      kind: 'yesno',
      text: expect.stringContaining('fixture-owner/neo-home'),
    });
    expect(await git('remote')).toBe('');
    expect(await log()).not.toContain('repo create');
    expect(await call({ askId: 'ask' })).toEqual(proposed);
    expect(todos.listQuestions('ask')).toHaveLength(1);
    expect((await call({ questionId: proposed.questionId })).ok).toBe(false);
    expect((await answer(proposed.questionId, 'yes', owner)).ok).toBe(false);
    expect(await log()).not.toContain('repo create');
    await answer(proposed.questionId);
    const created = await call({ questionId: proposed.questionId });
    expect(created).toMatchObject({
      ok: true,
      status: 'created',
      repository: 'fixture-owner/neo-home',
    });
    expect(await git('remote', 'get-url', 'origin')).toBe(join(fixture, 'remote.git'));
    expect(await git('rev-parse', '@{upstream}')).toBe(await git('rev-parse', 'HEAD'));
    home = new NeoHomeRepository(root, new NeoRepository(db.getDatabase()));
    expect(await call({ questionId: proposed.questionId })).toEqual(created);
    expect((await log()).match(/repo create/g)).toHaveLength(1);
    expect(await git('status', '--porcelain')).toBe('');
  });
  test.each(['missing', 'no', 'retired', 'unrelated', 'foreign ask', 'changed body'])(
    'refuses %s consent without creating anything',
    async (state) => {
      const proposed = await call({ askId: 'ask' });
      let questionId = proposed.questionId;
      if (state === 'missing') questionId = 'missing';
      else if (state === 'retired')
        await call({ questionId, reason: 'No longer needed' }, owner, 'neo.question.retire');
      else if (state === 'unrelated') {
        const q = todos.askQuestion(
          'other',
          'ask',
          {
            text: 'Approve something else?',
            kind: 'yesno',
            options: null,
            multiple: false,
            noLabel: 'No',
            yesLabel: 'Yes',
            startTodos: null,
          },
          Date.now()
        );
        questionId = q.id;
        await answer(questionId);
      } else {
        await answer(questionId, state === 'no' ? 'no' : 'yes');
        if (state === 'foreign ask')
          db.getDatabase().prepare("UPDATE neo_asks SET session_id='worker' WHERE id='ask'").run();
        if (state === 'changed body')
          db.getDatabase()
            .prepare("UPDATE neo_questions SET text='Something else' WHERE id=?")
            .run(questionId);
      }
      expect(await call({ questionId })).toMatchObject({ ok: false });
      expect(await log()).not.toContain('repo create');
      expect(await git('remote')).toBe('');
      if (state === 'no')
        expect((await call({ askId: 'ask' })).questionId).toBe(proposed.questionId);
    }
  );
  test('stays local without GitHub and does not probe or ask again after restart', async () => {
    await writeFile(join(fixture, 'unavailable'), '');
    expect(await call({ askId: 'ask' })).toMatchObject({ ok: true, status: 'local' });
    const before = await log();
    await rm(join(fixture, 'unavailable'));
    home = new NeoHomeRepository(root, new NeoRepository(db.getDatabase()));
    expect(await call({ askId: 'ask' })).toMatchObject({ ok: true, status: 'local' });
    expect(await log()).toBe(before);
    expect(todos.listQuestions('ask')).toHaveLength(0);
  });
  test('reserves once before external submission, even on failure and concurrent retry', async () => {
    const proposed = await call({ askId: 'ask' });
    await answer(proposed.questionId);
    await writeFile(join(fixture, 'fail-create'), '');
    const results = await Promise.all([
      call({ questionId: proposed.questionId }),
      call({ questionId: proposed.questionId }),
    ]);
    expect(results.every((result) => !result.ok)).toBe(true);
    expect((await log()).match(/repo create/g)).toHaveLength(1);
    await rm(join(fixture, 'fail-create'));
    home = new NeoHomeRepository(root, new NeoRepository(db.getDatabase()));
    expect(await call({ questionId: proposed.questionId })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('unconfirmed'),
    });
    expect((await log()).match(/repo create/g)).toHaveLength(1);
  });
  test.each(['existing origin', 'credential history'])(
    'refuses %s before creation',
    async (state) => {
      const proposed = await call({ askId: 'ask' });
      await answer(proposed.questionId);
      if (state === 'existing origin')
        await git('remote', 'add', 'origin', join(fixture, 'remote.git'));
      else {
        await writeFile(join(root, 'fixture.md'), 'TOKEN=' + 'synthetic'.repeat(4));
        await git('add', 'fixture.md');
        await git('commit', '-m', 'Synthetic local fixture');
      }
      expect(await call({ questionId: proposed.questionId })).toMatchObject({ ok: false });
      expect(await log()).not.toContain('repo create');
    }
  );
  test('concurrent proposals show only one question and reject replacement repository fields', async () => {
    const results = await Promise.all([call({ askId: 'ask' }), call({ askId: 'ask' })]);
    expect(results[0]).toEqual(results[1]);
    expect(todos.listQuestions('ask')).toHaveLength(1);
    await answer(results[0].questionId);
    await expect(
      call({ questionId: results[0].questionId, repository: 'other/public-repo' })
    ).rejects.toThrow();
    expect(await log()).not.toContain('repo create');
  });
  test('rejects non-root callers and foreign/closed asks before probing GitHub', async () => {
    expect(
      (await call({ askId: 'ask' }, { source: 'mcp', sessionId: 'worker', role: 'neo' })).ok
    ).toBe(false);
    db.getDatabase().prepare("UPDATE neo_asks SET status='done' WHERE id='ask'").run();
    expect((await call({ askId: 'ask' })).ok).toBe(false);
    expect(await log()).toBe('');
  });
});
