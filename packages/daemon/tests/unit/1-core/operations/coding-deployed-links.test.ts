import { describe, expect, test } from 'bun:test';
import { checkCodingDeployed } from '../../../../src/lib/neo/packs/coding/deployed.ts';
import {
  codingLinkIsComment,
  createCodingLinkExists,
} from '../../../../src/lib/neo/packs/coding/link-exists.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { runMigration533 } from '../../../../src/storage/schema/m533-neo-todo-deployed-coding.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import {
  codingTodoCheckRefusal,
  codingTodoDoneWhen,
} from '../../../../src/lib/neo/packs/coding/todo-prs.ts';

const sha = 'a'.repeat(40);
const build = 'b'.repeat(40);
const ancestry = (contains: boolean | null) => ({
  refresh: async (subject: { repo: string; baseOid: string; headOid: string }) => {
    expect(subject).toEqual({ repo: 'owner/repo', baseOid: sha, headOid: build });
    return {
      ancestry:
        contains === null ? { status: 'unknown' as const } : { status: 'known' as const, contains },
    };
  },
});

describe('coding deployed', () => {
  test('passes only when the running build contains the commit', async () => {
    expect(
      await checkCodingDeployed('owner/repo', sha, ancestry(true) as never, build)
    ).toMatchObject({ done: true });
    expect(await checkCodingDeployed('owner/repo', sha, ancestry(false) as never, build)).toEqual({
      done: false,
      evidence: null,
    });
    expect(await checkCodingDeployed('owner/repo', sha, ancestry(null) as never, build)).toEqual({
      done: false,
      evidence: null,
    });
    expect(
      await checkCodingDeployed('owner/repo', sha, ancestry(true) as never, 'unknown')
    ).toEqual({ done: false, evidence: null });
  });

  test('refuses a short sha or a bad repo and describes a valid check', () => {
    const check = (params: Record<string, unknown>) => ({
      check: { pack: 'coding', kind: 'deployed', params },
      instruction: null,
    });
    expect(codingTodoCheckRefusal(check({ repo: 'owner/repo', sha }))).toBeNull();
    expect(codingTodoCheckRefusal(check({ repo: 'owner/repo', sha: 'abc' }))).toStartWith(
      'deployed_invalid:'
    );
    expect(codingTodoCheckRefusal(check({ repo: 'repo', sha }))).toStartWith('deployed_invalid:');
    expect(
      codingTodoDoneWhen({ pack: 'coding', kind: 'deployed', params: { repo: 'owner/repo', sha } })
    ).toContain(`owner/repo@${sha}`);
  });
});

describe('coding link resolver', () => {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    const path = args[2]!;
    if (path.endsWith('/404')) return { ok: false, error: 'HTTP 404' } as never;
    if (path.includes('/issues/comments/'))
      return {
        ok: true,
        data: { issue_url: 'https://api.github.com/repos/o/r/issues/7' },
      } as never;
    if (path.includes('/pulls/comments/'))
      return {
        ok: true,
        data: { pull_request_url: 'https://api.github.com/repos/o/r/pulls/7' },
      } as never;
    return { ok: true, data: {} } as never;
  };
  test.each([
    ['https://github.com/o/r/pull/7#pullrequestreview-9', 'repos/o/r/pulls/7/reviews/9'],
    [
      'https://github.com/o/r/pull/7?tab=conversation#issuecomment-5',
      'repos/o/r/issues/comments/5',
    ],
    ['https://github.com/o/r/pull/7/files#discussion_r3', 'repos/o/r/pulls/comments/3'],
    ['https://github.com/o/r/issues/7', 'repos/o/r/issues/7'],
    ['https://github.com/o/r/commit/abc1234', 'repos/o/r/commits/abc1234'],
  ])('%s asks gh api %s', async (url, path) => {
    expect(await createCodingLinkExists(run)(url)).toBe(true);
    expect(calls.at(-1)).toEqual(['gh', 'api', path]);
  });

  test('fails closed on unknown GitHub forms, foreign parents and missing objects', async () => {
    const exists = createCodingLinkExists(run);
    expect(await exists('https://github.com/o/r/issues/404')).toBe(false);
    expect(await exists('https://github.com/o/r/pull/8#issuecomment-5')).toBe(false);
    expect(await exists('https://github.com/o/r/pull/8#discussion_r3')).toBe(false);
    expect(await exists('https://github.com/o/r/pull/7#unknown-1')).toBe(false);
    expect(await exists('https://github.com/o/r/issues/7#pullrequestreview-1')).toBe(false);
    expect(await exists('https://github.com/o/r/pull/7/commits')).toBe(false);
    expect(await exists('https://example.com/review')).toBeNull();
    expect(await exists('http://github.com/o/r/issues/7')).toBeNull();
  });

  test('coalesces repeated reads and retries a missing link only after the wait', async () => {
    let at = 0;
    let reads = 0;
    const exists = createCodingLinkExists(
      async () => {
        reads += 1;
        return { ok: false, error: 'HTTP 404' } as never;
      },
      () => at
    );
    const url = 'https://github.com/o/r/issues/1';
    expect(await Promise.all([exists(url), exists(url)])).toEqual([false, false]);
    expect(await exists(url)).toBe(false);
    expect(reads).toBe(1);
    at = 5 * 60_000;
    expect(await exists(url)).toBe(false);
    expect(reads).toBe(2);
  });

  test('only comment and review links are coding evidence', () => {
    expect(codingLinkIsComment('https://github.com/o/r/pull/7#pullrequestreview-9')).toBe(true);
    expect(codingLinkIsComment('https://github.com/o/r/pull/7#issuecomment-5')).toBe(true);
    expect(codingLinkIsComment('https://github.com/o/r/pull/7?w=1')).toBe(false);
    expect(codingLinkIsComment('https://github.com/o/r/PULL/7/files')).toBe(false);
    expect(codingLinkIsComment('https://example.com/review')).toBeNull();
  });
});

test('stored core deployed checks move to the coding pack', () => {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  const store = new NeoAskTodoRepository(db);
  store.openAsk({
    id: 'ask',
    sessionId: 'neo',
    projectId: null,
    originMessageId: null,
    title: 'T',
    request: 'R',
    createdAt: 1,
  });
  store.addTodo(
    'todo',
    'ask',
    { title: 'Ship', doneWhen: 'Shipped', instruction: null, named: null, check: null },
    1
  );
  db.prepare('UPDATE neo_todos SET check_json=? WHERE id=?').run(
    JSON.stringify({ pack: 'core', kind: 'deployed', params: { repo: 'o/r', sha } }),
    'todo'
  );
  runMigration533(db);
  expect(store.getTodo('todo')?.check).toEqual({
    pack: 'coding',
    kind: 'deployed',
    params: { repo: 'o/r', sha },
  });
  db.close();
});
