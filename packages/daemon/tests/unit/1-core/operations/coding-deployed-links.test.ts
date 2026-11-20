import { describe, expect, test } from 'bun:test';
import { checkCodingDeployed } from '../../../../src/lib/neo/packs/coding/deployed.ts';
import { codingLinkExists } from '../../../../src/lib/neo/packs/coding/link-exists.ts';
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
  const seen: string[] = [];
  const run = async (args: string[]) => {
    seen.push(args[1]!);
    return { ok: !args[1]!.endsWith('/404') } as never;
  };
  test.each([
    ['https://github.com/o/r/pull/7#pullrequestreview-9', 'repos/o/r/pulls/7/reviews/9'],
    ['https://github.com/o/r/pull/7#issuecomment-5', 'repos/o/r/issues/comments/5'],
    ['https://github.com/o/r/pull/7#discussion_r3', 'repos/o/r/pulls/comments/3'],
    ['https://github.com/o/r/issues/8', 'repos/o/r/issues/8'],
    ['https://github.com/o/r/commit/abc1234', 'repos/o/r/commits/abc1234'],
  ])('%s asks GitHub for %s', async (url, path) => {
    expect(await codingLinkExists(url, run)).toBe(true);
    expect(seen.at(-1)).toBe(path);
  });

  test('a missing GitHub object fails and other links are not the coding pack’s', async () => {
    expect(await codingLinkExists('https://github.com/o/r/issues/404', run)).toBe(false);
    expect(await codingLinkExists('https://example.com/review', run)).toBeNull();
    expect(
      await codingLinkExists('https://github.com/o/r/issues/8#pullrequestreview-1', run)
    ).toBeNull();
  });
});
