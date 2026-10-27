import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createNeoHomeOperations } from '../../../../src/lib/neo/home/operations.ts';
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
const input = {
  path: 'projects/verify/mandate.md',
  content: 'New mandate 🦊.\n',
  message: 'Adopt verified direction',
};
let fixture: string;
let root: string;
let db: Awaited<ReturnType<typeof createTestDb>>;
let repo: NeoRepository;
let todos: NeoAskTodoRepository;
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
const call = async (name: string, input: unknown, caller = human) => {
  const registry = createOperationRegistry([
    ...createNeoHomeOperations({ repo, todos, defaultSessionId: () => owner.sessionId! }, home),
    ...createNeoQuestionOperations(
      todos,
      async () => {},
      async () => ({ ok: true })
    ),
  ]);
  const result = await invokeOperation(registry, name, input, caller);
  if (result.kind !== 'completed') throw new Error(result.message);
  return result.value as {
    ok: boolean;
    reason?: string;
    commit?: string;
    question: { id: string };
  };
};
const proposal = async (value = input, state = 'yes') => {
  const confirm = {
    path: value.path,
    sha256: createHash('sha256').update(value.content).digest('hex'),
  };
  const asked = await call(
    'neo.question.ask',
    {
      askId: 'ask',
      kind: 'yesno',
      text: `Old: previous mandate. New: proposed mandate. Path: ${confirm.path}\nSHA-256: ${confirm.sha256}`,
      noLabel: 'Keep old',
      yesLabel: 'Use new',
      confirm,
    },
    owner
  );
  const questionId = asked.question.id;
  if (state === 'yes' || state === 'no')
    await call('neo.question.answer', { questionId, answer: state });
  if (state === 'retired')
    await call('neo.question.retire', { questionId, reason: 'Superseded' }, owner);
  return questionId;
};
const bytes = (path: string) => readFile(join(root, path)).catch(() => null);
beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'neo-home-confirmed-'));
  root = join(fixture, 'Neo');
  await mkdir(root);
  await git('init', '--quiet');
  await git('config', 'user.name', 'Verify Neo');
  await git('config', 'user.email', 'verify@example.invalid');
  await git('config', 'commit.gpgsign', 'false');
  db = await createTestDb();
  repo = new NeoRepository(db.getDatabase());
  todos = new NeoAskTodoRepository(db.getDatabase());
  todos.openAsk({
    id: 'ask',
    projectId: null,
    sessionId: owner.sessionId!,
    originMessageId: null,
    title: 'Synthetic home decision',
    request: 'Review this change',
    createdAt: 1,
  });
  home = new NeoHomeRepository(root, repo);
  await home.init();
});
afterEach(async () => {
  db.close();
  await rm(fixture, { recursive: true, force: true });
});

describe('Neo human-confirmed home saves', () => {
  test('mandate revisions compare document content, ignore unrelated commits and never fetch or write', async () => {
    const first = await call('neo.home.save', { ...input, questionId: await proposal() }, owner);
    expect(first.ok).toBe(true);
    expect(await home.changedRevision(`${input.path}#goal`, first.commit!)).toBeNull();
    const unrelated = await call(
      'neo.home.save',
      { path: 'notes.md', content: 'Unrelated note', message: 'A different document' },
      owner
    );
    expect(unrelated.ok).toBe(true);
    expect(await home.changedRevision(input.path, first.commit!)).toBeNull();
    expect(await home.changedRevision(input.path, unrelated.commit!)).toBeNull();
    const next = { ...input, content: 'A changed mandate.\n' };
    const changed = await call(
      'neo.home.save',
      { ...next, questionId: await proposal(next) },
      owner
    );
    expect(changed.ok).toBe(true);
    await git('remote', 'add', 'origin', '/synthetic-unreachable-remote');
    expect(await home.changedRevision(input.path, first.commit!)).toBe(changed.commit);
    expect(await home.changedRevision(input.path, unrelated.commit!)).toBe(changed.commit);
    expect(await home.changedRevision(input.path, null)).toBe(changed.commit);
    expect(await home.changedRevision(input.path, 'not-a-revision')).toBe(changed.commit);
    expect(await home.changedRevision(input.path, changed.commit!)).toBeNull();
    expect(await home.changedRevision('../mandate.md', first.commit!)).toBeNull();
    expect(await git('rev-parse', 'HEAD')).toBe(changed.commit!);
    expect(await git('status', '--porcelain')).toBe('');
  });
  test.each(['direction.md', input.path])(
    'commits %s with its decision and human trailer once',
    async (path) => {
      const value = { ...input, path };
      const log = join(dirname(path), 'decisions.md');
      await mkdir(join(root, dirname(log)), { recursive: true });
      await writeFile(join(root, log), 'Prior decision.\n');
      await git('add', log);
      await git('commit', '-m', 'Prior history');
      const before = await git('rev-list', '--count', 'HEAD');
      const questionId = await proposal(value);
      const first = await call('neo.home.save', { ...value, questionId }, owner);
      expect(first.ok).toBe(true);
      expect(await bytes(path)).toEqual(Buffer.from(value.content));
      const history = (await bytes(log))!.toString();
      expect(history.startsWith('Prior decision.\n')).toBe(true);
      expect(history).toContain(questionId);
      expect(history).toContain(value.message);
      expect(history).toContain(createHash('sha256').update(value.content).digest('hex'));
      expect(history).toContain(todos.getQuestion(questionId)!.text);
      expect(await git('show', '--format=', '--name-only', 'HEAD')).toBe(
        [path, log].sort().join('\n')
      );
      expect(await git('log', '-1', '--format=%B')).toContain(
        `Neo-Confirmed-By: question ${questionId}`
      );
      expect(await git('rev-list', '--count', 'HEAD')).toBe(String(Number(before) + 1));
      expect(await call('neo.home.save', { ...value, questionId }, owner)).toEqual(first);
      expect((await bytes(log))!.toString()).toBe(history);
      expect(await git('status', '--porcelain')).toBe('');
    }
  );
  test.each([
    'missing',
    'unknown',
    'open',
    'no',
    'retired',
    'path',
    'hash',
    'worker ask',
    'unbound',
    'body',
    'kind',
  ])('refuses %s confirmation without changing the repo', async (state) => {
    let questionId = state === 'missing' ? undefined : 'unknown';
    if (!['missing', 'unknown'].includes(state))
      questionId = await proposal(input, ['open', 'no', 'retired'].includes(state) ? state : 'yes');
    const sql = db.getDatabase();
    if (state === 'worker ask')
      sql.prepare("UPDATE neo_asks SET session_id = 'worker' WHERE id = 'ask'").run();
    if (state === 'unbound')
      sql.prepare('UPDATE neo_questions SET confirm_json = NULL WHERE id = ?').run(questionId!);
    if (state === 'body')
      sql
        .prepare("UPDATE neo_questions SET text = 'Approve something else?' WHERE id = ?")
        .run(questionId!);
    if (state === 'kind')
      sql.prepare("UPDATE neo_questions SET kind = 'reply' WHERE id = ?").run(questionId!);
    const before = await git('rev-parse', 'HEAD');
    const value = {
      ...input,
      path: state === 'path' ? 'direction.md' : input.path,
      content: state === 'hash' ? 'Other content.' : input.content,
      questionId,
    };
    expect(await call('neo.home.save', value)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('confirmation'),
    });
    expect(await git('rev-parse', 'HEAD')).toBe(before);
    expect(await bytes(input.path)).toBeNull();
    expect(await bytes('projects/verify/decisions.md')).toBeNull();
    expect(await git('status', '--porcelain')).toBe('');
  });
  test.each(['absent', 'existing'])(
    'rolls back both files after a commit failure with %s history',
    async (state) => {
      const log = 'projects/verify/decisions.md';
      if (state === 'existing') {
        await mkdir(join(root, 'projects/verify'), { recursive: true });
        await writeFile(join(root, input.path), 'Old mandate.\n');
        await writeFile(join(root, log), new Uint8Array([0xff, 0xc3, 0x28]));
        await git('add', input.path, log);
        await git('commit', '-m', 'Legacy history bytes');
      }
      const originals = [await bytes(input.path), await bytes(log)];
      const questionId = await proposal();
      const before = await git('rev-parse', 'HEAD');
      await git('config', 'user.name', '');
      await git('config', 'user.email', '');
      await expect(call('neo.home.save', { ...input, questionId })).rejects.toThrow(
        'Author identity unknown'
      );
      expect([await bytes(input.path), await bytes(log)]).toEqual(originals);
      expect(await git('rev-parse', 'HEAD')).toBe(before);
      expect(await git('status', '--porcelain')).toBe('');
      await git('config', 'user.name', 'Verify Neo');
      await git('config', 'user.email', 'verify@example.invalid');
      expect(await call('neo.home.save', { ...input, questionId })).toMatchObject({ ok: true });
      expect(await git('status', '--porcelain')).toBe('');
    }
  );
  test.each(['ignored', 'symlink'])(
    'refuses an %s decision log without touching either file',
    async (kind) => {
      const log = 'projects/verify/decisions.md';
      await mkdir(join(root, 'projects/verify'), { recursive: true });
      if (kind === 'ignored') {
        await writeFile(join(root, '.gitignore'), '.coordinators/\n' + log + '\n');
        await git('commit', '-am', 'Ignore synthetic log');
      } else {
        await writeFile(join(fixture, 'outside.md'), 'Outside content.');
        await symlink(join(fixture, 'outside.md'), join(root, log));
        await git('add', log);
        await git('commit', '-m', 'Synthetic link');
      }
      const before = await git('rev-parse', 'HEAD');
      expect(await call('neo.home.save', { ...input, questionId: await proposal() })).toMatchObject(
        { ok: false }
      );
      expect(await bytes(input.path)).toBeNull();
      expect(await git('rev-parse', 'HEAD')).toBe(before);
      expect(await git('status', '--porcelain')).toBe('');
      if (kind === 'symlink')
        expect(await readFile(join(fixture, 'outside.md'), 'utf8')).toBe('Outside content.');
    }
  );
  test('still refuses credential content and non-owner callers with a bound human yes', async () => {
    await git('remote', 'add', 'origin', join(fixture, 'synthetic-remote.git'));
    const sensitive = { ...input, content: '-----BEGIN PRIVATE KEY-----\nSynthetic\n' };
    const questionId = await proposal(sensitive);
    expect(await call('neo.home.save', { ...sensitive, questionId })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('content'),
    });
    expect(
      await call(
        'neo.home.save',
        { ...input, questionId: await proposal() },
        { source: 'mcp', sessionId: 'worker', role: 'neo' }
      )
    ).toMatchObject({ ok: false });
    expect(await git('status', '--porcelain')).toBe('');
  });
});
