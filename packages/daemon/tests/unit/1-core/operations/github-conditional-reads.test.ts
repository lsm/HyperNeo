import { afterEach, describe, expect, test } from 'bun:test';
import {
  readGithubBudget,
  recordGithubBudget,
  runGhJson,
} from '../../../../src/lib/github/gh-lookup-helpers.ts';
import type { SpawnFn } from '../../../../src/lib/runtime-spawn/index.ts';

type Reply = { status: number; headers?: Record<string, string>; body?: unknown };

const fakeGh = (replies: Reply[]) => {
  const calls: string[][] = [];
  const spawn: SpawnFn = (args) => {
    calls.push(args);
    const reply = replies.shift()!;
    const head = Object.entries(reply.headers ?? {}).map(([k, v]) => `${k}: ${v}`);
    const text = [`HTTP/2.0 ${reply.status} X`, ...head, '', JSON.stringify(reply.body ?? '')]
      .join('\r\n')
      .replace(/""$/, '');
    const code = reply.status >= 300 ? 1 : 0;
    return {
      stdout: new Response(text).body,
      stderr: new Response(code ? `gh: HTTP ${reply.status}` : '').body,
      exited: Promise.resolve(code),
      exitCode: code,
      kill() {},
    };
  };
  return { calls, spawn };
};
const quota = (remaining: number, reset = Math.floor(Date.now() / 1000) + 600) => ({
  'X-RateLimit-Resource': 'core',
  'X-RateLimit-Limit': '5000',
  'X-RateLimit-Remaining': String(remaining),
  'X-RateLimit-Reset': String(reset),
});

afterEach(() => {
  recordGithubBudget(new Headers(quota(5000)));
  recordGithubBudget(new Headers(quota(5000)), 'ghe.synthetic.test');
});

describe('conditional GitHub reads', () => {
  test('an unchanged read is answered by a 304 with the earlier data', async () => {
    const endpoint = 'repos/synthetic/etag/issues/1/labels';
    const labels = [{ name: 'bug' }];
    const gh = fakeGh([
      { status: 200, headers: { ETag: '"v1"', ...quota(4000) }, body: labels },
      { status: 304, headers: { ETag: '"v1"', ...quota(4000) } },
    ]);
    const first = await runGhJson(['gh', 'api', endpoint], '/tmp', gh.spawn);
    const second = await runGhJson(['gh', 'api', endpoint], '/tmp', gh.spawn);
    expect(first).toEqual({ ok: true, data: labels });
    expect(second).toEqual({ ok: true, data: labels });
    expect(gh.calls[0]).not.toContain('If-None-Match: "v1"');
    expect(gh.calls[1]).toContain('If-None-Match: "v1"');
  });

  test('a paginated read of one page is made conditional and keeps the slurped shape', async () => {
    const args = ['gh', 'api', '--paginate', '--slurp', 'repos/synthetic/etag/pulls/2/reviews'];
    const reviews = [{ state: 'APPROVED' }];
    const gh = fakeGh([
      { status: 200, headers: { ETag: '"r1"', ...quota(4000) }, body: reviews },
      { status: 304, headers: { ETag: '"r1"', ...quota(4000) } },
    ]);
    const first = await runGhJson(args, '/tmp', gh.spawn, { firstPage: true });
    const second = await runGhJson(args, '/tmp', gh.spawn, { firstPage: true });
    expect(first).toEqual({ ok: true, data: [reviews] });
    expect(second).toEqual({ ok: true, data: [reviews] });
    expect(gh.calls).toHaveLength(2);
    expect(gh.calls.flat()).not.toContain('--paginate');
    expect(gh.calls[1]).toContain('If-None-Match: "r1"');
  });

  test('a read with more pages falls back to the full paginated read', async () => {
    const args = ['gh', 'api', '--paginate', '--slurp', 'repos/synthetic/etag/pulls/3/reviews'];
    const gh = fakeGh([
      {
        status: 200,
        headers: { ETag: '"p1"', Link: '<https://api.github.com/x?page=2>; rel="next"' },
        body: [{ state: 'COMMENTED' }],
      },
    ]);
    const full: SpawnFn = (callArgs, options) =>
      callArgs.includes('--paginate')
        ? {
            stdout: new Response('[[{"state":"COMMENTED"}],[{"state":"APPROVED"}]]').body,
            stderr: new Response('').body,
            exited: Promise.resolve(0),
            exitCode: 0,
            kill() {},
          }
        : gh.spawn(callArgs, options);
    const result = await runGhJson(args, '/tmp', full, { firstPage: true });
    expect(result).toEqual({
      ok: true,
      data: [[{ state: 'COMMENTED' }], [{ state: 'APPROVED' }]],
    });
  });

  test('another GitHub host keeps its own ETags and budget', async () => {
    const endpoint = 'repos/synthetic/hosts/issues/1/labels';
    const gh = fakeGh([
      { status: 200, headers: { ETag: '"public"', ...quota(4000) }, body: [] },
      { status: 200, headers: { ETag: '"enterprise"', ...quota(10) }, body: [] },
    ]);
    await runGhJson(['gh', 'api', '--hostname', 'github.com', endpoint], '/tmp', gh.spawn);
    await runGhJson(['gh', 'api', '--hostname', 'ghe.synthetic.test', endpoint], '/tmp', gh.spawn);
    expect(gh.calls[1].join(' ')).not.toContain('If-None-Match');
    expect(readGithubBudget().level).toBe('ok');
    expect(readGithubBudget(Date.now(), 'ghe.synthetic.test').level).toBe('critical');
  });

  test('the remaining core budget sets the level until the reset', async () => {
    const reset = Math.floor(Date.now() / 1000) + 600;
    for (const [remaining, level] of [
      [3000, 'ok'],
      [900, 'low'],
      [200, 'critical'],
    ] as const) {
      const gh = fakeGh([{ status: 200, headers: quota(remaining, reset), body: {} }]);
      await runGhJson(['gh', 'api', `repos/synthetic/budget/${remaining}`], '/tmp', gh.spawn);
      expect(readGithubBudget()).toEqual({ level, resetAt: reset * 1000 });
    }
    expect(readGithubBudget(reset * 1000).level).toBe('ok');
  });
});
