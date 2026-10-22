import { describe, expect, test } from 'bun:test';
import { readGithubPrs } from '../../../../src/lib/neo/packs/coding/work-prs.ts';
import type { SpawnFn } from '../../../../src/lib/runtime-spawn/index.ts';

const url = 'https://github.com/synthetic/ledger/pull/7';
const raw = (head = 'a') => ({
  url,
  state: 'MERGED',
  headRefOid: head.repeat(40),
  reviews: [{ state: 'APPROVED', commit: { oid: 'a'.repeat(40) } }],
  statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
});

function fixture() {
  let calls = 0;
  let data: unknown = raw();
  let code = 0;
  let gate = Promise.resolve(0);
  const spawn: SpawnFn = () => {
    calls++;
    return {
      stdout: new Response(JSON.stringify(data)).body,
      stderr: new Response(code ? 'HTTP 404: synthetic unavailable' : '').body,
      exited: gate.then(() => code),
      exitCode: null,
      kill: () => {},
    };
  };
  return {
    read: (urls: readonly string[]) => readGithubPrs(urls, spawn),
    calls: () => calls,
    data: (value: unknown, exit = 0) => {
      data = value;
      code = exit;
    },
    hold: () => {
      let finish!: (code: number) => void;
      gate = new Promise((done) => {
        finish = done;
      });
      return () => finish(0);
    },
  };
}

describe('ledger work PR acquisition', () => {
  test('five simultaneous demands share one acquisition without changing their results', async () => {
    const f = fixture(),
      release = f.hold();
    const pending = Promise.all(Array.from({ length: 5 }, () => f.read([url])));
    release();
    const results = await pending;
    expect(results).toEqual(Array.from({ length: 5 }, () => results[0]));
    expect(results[0]?.[0]).toMatchObject({
      state: 'MERGED',
      head: 'a'.repeat(40),
      review: 'approved',
    });
    expect(f.calls()).toBe(1);
  });
  test('each settled human read makes a fresh attempt so old approval and failures cannot be masked', async () => {
    const f = fixture();
    expect((await f.read([url]))?.[0].review).toBe('approved');
    f.data(raw('b'));
    expect((await f.read([url]))?.[0]).toMatchObject({ head: 'b'.repeat(40), review: 'none' });
    f.data({}, 1);
    expect(await f.read([url])).toBe(null);
    expect(f.calls()).toBe(3);
  });
});
