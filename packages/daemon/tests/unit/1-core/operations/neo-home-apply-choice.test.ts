import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createNeoHomeOperations } from '../../../../src/lib/neo/home/operations.ts';
import { NeoHomeRepository } from '../../../../src/lib/neo/home/repository.ts';
import { createNeoQuestionOperations } from '../../../../src/lib/neo/question-operations.ts';
import { readNeoReply, recordNeoReplyAnswer } from '../../../../src/lib/neo/intake.ts';
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
const owner: OperationCaller = { source: 'mcp', role: 'neo', sessionId: 'neo:root' };
let run: string, root: string, peer: string, remote: string;
let db: Awaited<ReturnType<typeof createTestDb>>,
  home: NeoHomeRepository,
  store: NeoAskTodoRepository;
let previous: Map<string, string | undefined>;
const localText = 'Human local version  \n',
  remoteText = 'Human remote version 🦊\n';
async function git(cwd: string, ...args: string[]) {
  const child = spawnProcess(['/usr/bin/git', '-c', 'core.hooksPath=/dev/null', ...args], {
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
async function call(name: string, input: unknown, caller = human) {
  const registry = createOperationRegistry([
    ...createNeoHomeOperations(
      {
        repo: new NeoRepository(db.getDatabase()),
        todos: store,
        defaultSessionId: () => owner.sessionId,
      },
      home
    ),
    ...createNeoQuestionOperations(
      store,
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
    questionId?: string;
    question: { id: string; askId: string };
  };
}
async function version(cwd: string, path: string, content: string) {
  await mkdir(dirname(join(cwd, path)), { recursive: true });
  await writeFile(join(cwd, path), content);
  await git(cwd, 'add', '.');
  await git(cwd, 'commit', '-m', 'Synthetic version');
}
async function conflict(path = 'notes.md') {
  await version(root, path, localText);
  const local = await git(root, 'rev-parse', 'HEAD');
  await version(peer, path, remoteText);
  await git(peer, 'push', 'origin', 'main');
  const other = await git(peer, 'rev-parse', 'HEAD');
  const result = await call('neo.home.read', { path });
  expect(result.reason).toContain('conflict');
  const question = store.getQuestion(result.questionId!)!;
  return { question, local, other };
}
async function approve(questionId: string, answer: string | string[] = ['Use remote']) {
  expect((await call('neo.question.answer', { questionId, answer })).ok).toBe(true);
}
async function confirmation(askId: string, path: string, content: string, answer = 'yes') {
  const confirm = { path, sha256: createHash('sha256').update(content).digest('hex') };
  const result = await call(
    'neo.question.ask',
    {
      askId,
      kind: 'yesno',
      text: `Save ${path}\nSHA-256: ${confirm.sha256}`,
      yesLabel: 'Use these exact bytes',
      noLabel: 'Keep current',
      confirm,
    },
    owner
  );
  await approve(result.question.id, answer);
  return result.question.id;
}
async function state() {
  return {
    head: await git(root, 'rev-parse', 'HEAD'),
    status: await git(root, 'status', '--porcelain'),
    remote: await git(remote, 'rev-parse', 'main'),
  };
}
async function race(mode: string) {
  const action = mode.startsWith('remote')
    ? `printf 'Remote racing edit\\n' > '${peer}/racing.md'; /usr/bin/git -C '${peer}' add .; /usr/bin/git -C '${peer}' commit -m human-race >/dev/null; /usr/bin/git -C '${peer}' push origin main >/dev/null 2>&1`
    : mode === 'local-network'
      ? `printf 'Human edit during network check\\n' > '${root}/human.md'`
      : mode === 'local-edit'
        ? `printf 'Uncommitted human edit\\n' > '${root}/notes.md'`
        : `printf 'Local racing commit\\n' > '${root}/racing.md'; /usr/bin/git -C '${root}' add .; /usr/bin/git -C '${root}' commit -m human-race >/dev/null`;
  const trigger =
    mode === 'local-network'
      ? 'ls-remote'
      : mode.endsWith('-late')
        ? mode.startsWith('remote')
          ? 'push'
          : 'merge'
        : 'commit';
  const where = mode.endsWith('-late') || mode === 'local-network' ? '=' : '!=';
  await mkdir(join(run, 'bin'));
  await writeFile(
    join(run, 'bin', 'git'),
    `#!/bin/sh\nfor arg do\n if [ "$arg" = '${trigger}' ] && [ "$(pwd -P)" ${where} "$(cd '${root}' && pwd -P)" ] && [ ! -e '${run}/raced' ]; then\n  touch '${run}/raced'\n  ${action}\n fi\ndone\nexec /usr/bin/git "$@"\n`
  );
  await chmod(join(run, 'bin', 'git'), 0o755);
  process.env.PATH = `${join(run, 'bin')}:${process.env.PATH}`;
}
beforeEach(async () => {
  run = await mkdtemp(join(tmpdir(), 'neo-home-choice-'));
  root = join(run, 'Neo');
  peer = join(run, 'peer');
  remote = join(run, 'remote.git');
  previous = new Map(
    ['PATH', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'].map((key) => [key, process.env[key]])
  );
  process.env.GIT_CONFIG_GLOBAL = join(run, 'gitconfig');
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  await writeFile(
    process.env.GIT_CONFIG_GLOBAL,
    '[user]\n name = Synthetic Neo\n email = verify@example.invalid\n[commit]\n gpgsign = false\n'
  );
  await mkdir(peer);
  await git(peer, 'init', '--initial-branch=main', '--quiet');
  for (const path of ['README.md', 'direction.md', 'notes.md'])
    await writeFile(join(peer, path), 'Initial\n');
  await writeFile(join(peer, '.gitignore'), '.coordinators/\n.claude/\nworktrees/\n');
  await git(peer, 'add', '.');
  await git(peer, 'commit', '-m', 'Initial');
  await git(run, 'clone', '--bare', peer, remote);
  await git(remote, 'config', 'receive.denyNonFastForwards', 'true');
  await git(peer, 'remote', 'add', 'origin', remote);
  db = await createTestDb();
  store = new NeoAskTodoRepository(db.getDatabase());
  home = new NeoHomeRepository(root, new NeoRepository(db.getDatabase()));
  expect(await home.init(remote)).toMatchObject({ ok: true });
});
afterEach(async () => {
  db?.close();
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(run, { recursive: true, force: true });
});

describe('Human-recorded conflict version saves', () => {
  test.each(['Keep local', 'Use remote'])(
    'applies a human chat reply recording the scalar %s',
    async (answer) => {
      const { question, local, other } = await conflict();
      const requestId = crypto.randomUUID();
      const replyTo = { kind: 'question' as const, id: question.id };
      recordNeoReplyAnswer(
        { ok: true, requestId, messageId: requestId, created: true },
        readNeoReply(replyTo, store),
        { sessionId: owner.sessionId!, requestId, content: answer, replyTo },
        store,
        owner.sessionId!
      );
      expect(store.getQuestion(question.id)?.answer).toBe(answer);
      const content = answer === 'Keep local' ? localText : remoteText;
      expect(
        await call('neo.home.save', {
          path: 'notes.md',
          content,
          message: 'Apply human chat choice',
          conflictQuestionId: question.id,
        })
      ).toMatchObject({ ok: true });
      expect(await readFile(join(root, 'notes.md'), 'utf8')).toBe(content);
      await git(root, 'merge-base', '--is-ancestor', local, 'HEAD');
      await git(root, 'merge-base', '--is-ancestor', other, 'HEAD');
    }
  );
  test('explains that an unrelated choice question does not bind the current snapshots', async () => {
    const { question } = await conflict();
    const unrelated = await call(
      'neo.question.ask',
      {
        askId: question.askId,
        kind: 'choice',
        text: 'Which version?',
        options: ['Keep local', 'Use remote'],
        multiple: false,
      },
      owner
    );
    await approve(unrelated.question.id);
    const before = await state();
    expect(
      await call('neo.home.save', {
        path: 'notes.md',
        content: remoteText,
        message: 'Wrong question',
        conflictQuestionId: unrelated.question.id,
      })
    ).toMatchObject({ ok: false, reason: expect.stringContaining('question does not bind') });
    expect(await state()).toEqual(before);
  });
  test.each(['Use remote', 'Keep local'])(
    'applies %s as a merge preserving both histories',
    async (answer) => {
      const { question, local, other } = await conflict();
      await approve(question.id, [answer]);
      const content = answer === 'Keep local' ? localText : remoteText;
      const result = await call('neo.home.save', {
        path: 'notes.md',
        content,
        message: 'Apply human choice',
        conflictQuestionId: question.id,
      });
      expect(result).toMatchObject({ ok: true });
      expect(await readFile(join(root, 'notes.md'), 'utf8')).toBe(content);
      expect(await git(root, 'show', 'HEAD:notes.md')).toBe(content.trim());
      await git(root, 'merge-base', '--is-ancestor', local, 'HEAD');
      await git(root, 'merge-base', '--is-ancestor', other, 'HEAD');
      expect((await state()).remote).toBe(result.commit);
      expect((await state()).status).toBe('');
    }
  );
  test.each(['direction.md', 'projects/verify/mandate.md'])(
    'requires exact protected-file human yes for %s',
    async (path) => {
      const { question } = await conflict(path);
      await approve(question.id);
      const input = {
        path,
        content: remoteText,
        message: 'Apply confirmed choice',
        conflictQuestionId: question.id,
      };
      const before = await state();
      expect(await call('neo.home.save', input)).toMatchObject({
        ok: false,
        reason: expect.stringContaining('confirmation_required'),
      });
      expect(await state()).toEqual(before);
      const wrong = await confirmation(question.askId, path, localText);
      expect(await call('neo.home.save', { ...input, questionId: wrong })).toMatchObject({
        ok: false,
        reason: expect.stringContaining('confirmation_required'),
      });
      const yes = await confirmation(question.askId, path, remoteText);
      expect(await call('neo.home.save', { ...input, questionId: yes })).toMatchObject({
        ok: true,
      });
      expect(await readFile(join(root, path), 'utf8')).toBe(remoteText);
      expect(await readFile(join(root, dirname(path), 'decisions.md'), 'utf8')).toContain(yes);
      expect(await git(root, 'log', '-1', '--format=%B')).toContain(
        `Neo-Confirmed-By: question ${yes}`
      );
    }
  );
  test.each(['unanswered', 'wrong-content', 'review'])(
    'refuses %s without applying anything',
    async (mode) => {
      const { question } = await conflict();
      if (mode !== 'unanswered')
        await approve(question.id, mode === 'review' ? ['Review together'] : ['Use remote']);
      const before = await state();
      expect(
        await call('neo.home.save', {
          path: 'notes.md',
          content: mode === 'wrong-content' ? 'Different bytes' : remoteText,
          message: 'Refuse',
          conflictQuestionId: question.id,
        })
      ).toMatchObject({ ok: false });
      expect(await state()).toEqual(before);
      expect(await readFile(join(root, 'notes.md'), 'utf8')).toBe(localText);
    }
  );
  test.each(['local-commit', 'local-edit', 'remote-commit', 'local-late'])(
    'refuses deterministic %s races without losing the human change',
    async (mode) => {
      const { question, other } = await conflict();
      await approve(question.id);
      await race(mode);
      const result = await call('neo.home.save', {
        path: 'notes.md',
        content: remoteText,
        message: 'Race',
        conflictQuestionId: question.id,
      });
      expect(await readFile(join(run, 'raced'), 'utf8')).toBe('');
      expect(result).toMatchObject({ ok: false });
      if (mode === 'local-edit')
        expect(await readFile(join(root, 'notes.md'), 'utf8')).toBe('Uncommitted human edit\n');
      else expect(await readFile(join(root, 'notes.md'), 'utf8')).toBe(localText);
      if (mode.startsWith('local')) expect(await git(remote, 'rev-parse', 'main')).toBe(other);
      if (mode.startsWith('remote'))
        expect(await git(peer, 'log', '-1', '--format=%s')).toBe('human-race');
    }
  );
  test('refuses a remote race during push and retains/names the local merge without overwriting remote', async () => {
    const { question, local, other } = await conflict();
    await approve(question.id);
    await race('remote-late');
    const result = await call('neo.home.save', {
      path: 'notes.md',
      content: remoteText,
      message: 'Raced push',
      conflictQuestionId: question.id,
    });
    expect(await readFile(join(run, 'raced'), 'utf8')).toBe('');
    const head = await git(root, 'rev-parse', 'HEAD');
    expect(result.reason).toContain(head);
    expect(result.ok).toBe(false);
    await git(root, 'merge-base', '--is-ancestor', local, head);
    await git(root, 'merge-base', '--is-ancestor', other, head);
    expect(await git(remote, 'rev-parse', 'main')).toBe(await git(peer, 'rev-parse', 'HEAD'));
    expect(await readFile(join(peer, 'racing.md'), 'utf8')).toBe('Remote racing edit\n');
  });
});

describe('A human edit during the remote snapshot check', () => {
  test('refuses after the network wait without applying or dropping an unrelated human edit', async () => {
    const { question, local, other } = await conflict();
    await approve(question.id);
    await race('local-network');
    const result = await call('neo.home.save', {
      path: 'notes.md',
      content: remoteText,
      message: 'Network race',
      conflictQuestionId: question.id,
    });
    expect(await readFile(join(run, 'raced'), 'utf8')).toBe('');
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('stale_conflict') });
    expect(await readFile(join(root, 'human.md'), 'utf8')).toBe(
      'Human edit during network check\n'
    );
    expect(await readFile(join(root, 'notes.md'), 'utf8')).toBe(localText);
    expect(await git(root, 'rev-parse', 'HEAD')).toBe(local);
    expect(await git(remote, 'rev-parse', 'main')).toBe(other);
  });
});

describe('Neo reads after applying the choice in the same wake', () => {
  test('returns the applied bytes instead of the cached pre-save conflict', async () => {
    const { question } = await conflict();
    const caller: OperationCaller = {
      ...owner,
    };
    expect((await call('neo.home.read', { path: 'notes.md' }, caller)).ok).toBe(false);
    await approve(question.id);
    expect(
      await call(
        'neo.home.save',
        {
          path: 'notes.md',
          content: remoteText,
          message: 'Apply within wake',
          conflictQuestionId: question.id,
        },
        caller
      )
    ).toMatchObject({ ok: true });
    expect(await call('neo.home.read', { path: 'notes.md' }, caller)).toMatchObject({
      ok: true,
      content: remoteText,
    });
  });
});

describe('Ignored human files during conflict application', () => {
  test('refuses rather than replacing an ignored file newly introduced by the remote merge', async () => {
    await writeFile(join(root, '.git', 'info', 'exclude'), 'private-note.txt\n');
    await writeFile(join(peer, 'private-note.txt'), 'Remote independent bytes\n');
    await git(peer, 'add', '.');
    await git(peer, 'commit', '-m', 'Remote document');
    const { question, local, other } = await conflict();
    await writeFile(join(root, 'private-note.txt'), 'Human private bytes\n');
    await approve(question.id);
    const result = await call('neo.home.save', {
      path: 'notes.md',
      content: remoteText,
      message: 'Keep ignored file',
      conflictQuestionId: question.id,
    });
    expect(result.ok).toBe(false);
    expect(await readFile(join(root, 'private-note.txt'), 'utf8')).toBe('Human private bytes\n');
    expect(await git(root, 'rev-parse', 'HEAD')).toBe(local);
    expect(await git(remote, 'rev-parse', 'main')).toBe(other);
  });
});

describe('Revision-bound application admission', () => {
  test.each(['local', 'remote'])(
    'refuses an already changed %s snapshot before staging',
    async (side) => {
      const { question } = await conflict();
      await approve(question.id);
      const target = side === 'local' ? root : peer;
      await git(target, 'commit', '--allow-empty', '-m', 'Human newer snapshot');
      if (side === 'remote') await git(peer, 'push', 'origin', 'main');
      const before = await state();
      expect(
        await call('neo.home.save', {
          path: 'notes.md',
          content: remoteText,
          message: 'Stale approval',
          conflictQuestionId: question.id,
        })
      ).toMatchObject({ ok: false, reason: expect.stringContaining('stale_conflict') });
      expect(await state()).toEqual(before);
      expect(await readFile(join(root, 'notes.md'), 'utf8')).toBe(localText);
    }
  );
  test('does not choose or authorize a second protected conflict implicitly', async () => {
    await version(root, 'direction.md', 'Local protected direction\n');
    await version(peer, 'direction.md', 'Remote protected direction\n');
    const { question } = await conflict();
    await approve(question.id);
    const before = await state();
    expect(
      await call('neo.home.save', {
        path: 'notes.md',
        content: remoteText,
        message: 'Only notes approved',
        conflictQuestionId: question.id,
      })
    ).toMatchObject({ ok: false, reason: expect.stringContaining('choice_requires_review') });
    expect(await state()).toEqual(before);
    expect(await readFile(join(root, 'direction.md'), 'utf8')).toBe('Local protected direction\n');
  });
  test('does not turn a remote deletion choice into a file deletion', async () => {
    await version(root, 'notes.md', localText);
    await git(peer, 'rm', 'notes.md');
    await git(peer, 'commit', '-m', 'Human remote deletion');
    await git(peer, 'push', 'origin', 'main');
    const read = await call('neo.home.read', { path: 'notes.md' });
    await approve(read.questionId!);
    const before = await state();
    expect(
      await call('neo.home.save', {
        path: 'notes.md',
        content: '',
        message: 'Do not delete',
        conflictQuestionId: read.questionId,
      })
    ).toMatchObject({ ok: false, reason: expect.stringContaining('choice_requires_file') });
    expect(await state()).toEqual(before);
    expect(await readFile(join(root, 'notes.md'), 'utf8')).toBe(localText);
  });
  test('retains an ignored human decision log instead of bypassing normal save checks', async () => {
    const { question } = await conflict('direction.md');
    await approve(question.id);
    await writeFile(join(root, '.git', 'info', 'exclude'), 'decisions.md\n');
    await writeFile(join(root, 'decisions.md'), 'Human private decision history\n');
    const yes = await confirmation(question.askId, 'direction.md', remoteText);
    const before = await state();
    expect(
      await call('neo.home.save', {
        path: 'direction.md',
        content: remoteText,
        message: 'Respect ignored log',
        conflictQuestionId: question.id,
        questionId: yes,
      })
    ).toMatchObject({ ok: false, reason: expect.stringContaining('ignored_path') });
    expect(await state()).toEqual(before);
    expect(await readFile(join(root, 'decisions.md'), 'utf8')).toBe(
      'Human private decision history\n'
    );
  });
});
