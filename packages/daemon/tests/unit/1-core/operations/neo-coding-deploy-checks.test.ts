import { expect, test } from 'bun:test';
import {
  readGithubDeploys,
  readMergeCommit,
} from '../../../../src/lib/neo/packs/coding/deploy-checks.ts';
import type { SpawnFn } from '../../../../src/lib/runtime-spawn/index.ts';

function github(body: unknown, code = 0) {
  const calls: string[][] = [];
  const spawn = ((args: string[]) => {
    calls.push(args);
    return {
      stdout: new Response(JSON.stringify(body)).body,
      stderr: new Response('').body,
      exited: Promise.resolve(code),
      kill: () => {},
    };
  }) as unknown as SpawnFn;
  return { spawn, calls };
}
const pull = (number: number) => `https://github.com/synthetic/deploy-pin/pull/${number}`;

test.each([
  ['ahead', true],
  ['identical', true],
  ['behind', false],
  ['diverged', false],
])('deploy ancestry %s is containment: %s, cached for immutable SHAs', async (status, found) => {
  const url = pull(100 + status.length);
  const merge = `merge-${status}`;
  const build = `build-${status}`;
  const { spawn, calls } = github({ status });
  const read = () =>
    readGithubDeploys(
      [url],
      async () => [{ daemon: 'local', commit: build }],
      spawn,
      async () => merge
    );
  const expected = {
    prs: [{ url, mergeCommit: merge }],
    daemons: [{ daemon: 'local', commit: build, contains: found ? [merge] : [] }],
  };
  expect(await read()).toEqual(expected);
  expect(await read()).toEqual(expected);
  expect(calls).toHaveLength(1);
  expect(calls[0].slice(0, 3)).toEqual([
    'gh',
    'api',
    `repos/synthetic/deploy-pin/compare/${merge}...${build}`,
  ]);
});

test.each([{ status: 1 }, { unexpected: 'shape' }])(
  'malformed ancestry %j remains unknown and retries',
  async (body) => {
    const url = pull(body.status ? 201 : 202);
    const merge = `unknown-${url}`;
    const failed = github(body);
    const read = (spawn: SpawnFn) =>
      readGithubDeploys(
        [url],
        async () => [{ daemon: 'local', commit: 'candidate' }],
        spawn,
        async () => merge
      );
    expect((await read(failed.spawn)).daemons[0].contains).toEqual([]);
    const recovered = github({ status: 'ahead' });
    expect((await read(recovered.spawn)).daemons[0].contains).toEqual([merge]);
    expect(failed.calls).toHaveLength(1);
    expect(recovered.calls).toHaveLength(1);
  }
);

test('missing merge or daemon commit never invokes ancestry comparison', async () => {
  const comparisons: string[][] = [];
  const urls = [pull(301), pull(302)];
  const result = await readGithubDeploys(
    urls,
    async () => [
      { daemon: 'live', commit: 'build' },
      { daemon: 'offline', commit: null },
    ],
    github(null).spawn,
    async (url) => (url === urls[0] ? 'merge' : null),
    async (url, merge, build) => {
      comparisons.push([url, merge, build]);
      return true;
    }
  );
  expect(comparisons).toEqual([[urls[0], 'merge', 'build']]);
  expect(result).toEqual({
    prs: [
      { url: urls[0], mergeCommit: 'merge' },
      { url: urls[1], mergeCommit: null },
    ],
    daemons: [
      { daemon: 'live', commit: 'build', contains: ['merge'] },
      { daemon: 'offline', commit: null, contains: [] },
    ],
  });
});

test.each([
  { state: 'OPEN', mergeCommit: { oid: 'not-merged' } },
  { state: 'MERGED', mergeCommit: null },
  { state: 'MERGED', mergeCommit: { oid: 1 } },
])('merge lookup %j is not cached until a merged SHA is observed', async (body) => {
  const url = pull(body.state === 'OPEN' ? 401 : body.mergeCommit ? 402 : 403);
  const first = github(body);
  expect(await readMergeCommit(url, first.spawn)).toBeNull();
  const second = github({ state: 'MERGED', mergeCommit: { oid: `sha-${url}` } });
  expect(await readMergeCommit(url, second.spawn)).toBe(`sha-${url}`);
  const refused = github(null, 1);
  expect(await readMergeCommit(url.toUpperCase(), refused.spawn)).toBe(`sha-${url}`);
  expect(first.calls).toHaveLength(1);
  expect(second.calls).toHaveLength(1);
  expect(refused.calls).toEqual([]);
});

test('ancestry cache distinguishes ordered merge/build pairs and retries command failures', async () => {
  const url = pull(501);
  const failed = github({ status: 'ahead' }, 1);
  const read = (merge: string, build: string, spawn: SpawnFn) =>
    readGithubDeploys(
      [url],
      async () => [{ daemon: 'local', commit: build }],
      spawn,
      async () => merge
    );
  expect((await read('ordered-a', 'ordered-b', failed.spawn)).daemons[0].contains).toEqual([]);
  const ahead = github({ status: 'ahead' });
  expect((await read('ordered-a', 'ordered-b', ahead.spawn)).daemons[0].contains).toEqual([
    'ordered-a',
  ]);
  const behind = github({ status: 'behind' });
  expect((await read('ordered-b', 'ordered-a', behind.spawn)).daemons[0].contains).toEqual([]);
  expect((await read('ordered-a', 'ordered-c', ahead.spawn)).daemons[0].contains).toEqual([
    'ordered-a',
  ]);
  expect(failed.calls).toHaveLength(1);
  expect(ahead.calls).toHaveLength(2);
  expect(behind.calls).toHaveLength(1);
});
