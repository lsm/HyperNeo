import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import type { OapHubFrame } from '../../../../src/lib/oap/oap-hub-codec';
import { testDirectories } from '../../../helpers/temporary-directory';

const directory = testDirectories();
const clients: { close(): Promise<void> }[] = [];
const script = `
const subscriptions = new Set(), counts = {};
let heldBusy;
let cleanupRefusal;
const line = (value) => JSON.stringify(value) + '\\n';
const reply = (id, result) => process.stdout.write(line({ id, ok: true, result }));
require('node:readline').createInterface({ input: process.stdin }).on('line', (text) => {
  const r = JSON.parse(text), count = counts[r.op] = (counts[r.op] || 0) + 1;
  if (r.op === 'hang') return;
  if (r.op === 'busy-held') { if (count === 1) heldBusy = r; return; }
  if (r.op === 'release-busy') { process.stdout.write(line({id:heldBusy.id,ok:false,error:{code:'busy',message:'retry'}})); return reply(r.id,null); }
  if (r.op === 'ignore-term') { process.on('SIGTERM',()=>{}); setInterval(()=>{},1000); return reply(r.id,process.pid); }
  if (r.op === 'exit') { if (count === 2) process.exit(7); return; }
  if (r.op === 'busy-once' && count === 1 || r.op === 'busy-always')
    return process.stdout.write(line({ id:r.id, ok:false, error:{code:'busy', message:'send this request again'} }));
  if (r.op === 'refused') return process.stdout.write(line({ id:r.id, ok:false, error:{code:'unknown_session', message:'synthetic'} }));
  if (r.op === 'feature-refusal') return process.stdout.write(line({ id:r.id, ok:false, error:{code:'unsupported_feature', message:'synthetic', details:{feature:r.feature}} }));
  if (r.op === 'events') {
    subscriptions.add(r.id);
    if (r.session_id.startsWith('cleanup-')) { cleanupRefusal=r.session_id.slice(8); return; }
    if (r.session_id === 'never-ack') return;
    return process.stdout.write(line({id:r.id, ok:true, result:null}) + line({id:r.id,event:'oap-subscribed',joined_after:0}));
  }
  if (r.op === 'unsubscribe') {
    if (cleanupRefusal === 'timeout') return;
    if (cleanupRefusal) return process.stdout.write(line({id:r.id,ok:false,error:{code:cleanupRefusal,message:'synthetic cleanup refusal'}}));
    subscriptions.delete(r.subscription); return reply(r.id, null);
  }
  if (r.op === 'emit') {
    for (const id of [...subscriptions].reverse()) process.stdout.write(line({id,event:'envelope',sequence:4,envelope:{type:'content.delta',payload:{text:'synthetic'}}}));
    return reply(r.id, null);
  }
  if (r.op === 'stats') return reply(r.id, counts);
  if (r.op === 'malformed') return process.stdout.write('broken\\n' + line({id:r.id,ok:true,result:'too late'}));
  if (r.op === 'unicode') {
    const buffer = Buffer.from(line({id:r.id,ok:true,result:'雪'}));
    const split = buffer.indexOf(Buffer.from('雪')) + 1;
    process.stdout.write(buffer.subarray(0, split));
    return setTimeout(() => process.stdout.write(buffer.subarray(split)), 5);
  }
  if (r.op === 'stderr') return process.stderr.write('x'.repeat(1000000), () => reply(r.id,'drained'));
  if (r.op === 'slow') return setTimeout(() => reply(r.id, r.value), 20);
  reply(r.id, r.value ?? count);
});
`;

async function client(command = process.execPath, timeoutMs?: number) {
  const { OapHubClient } = await import('../../../../src/lib/oap/oap-hub-client');
  const root = directory(join(tmpdir(), 'oap-hub-client-'));
  for (const name of ['home', 'tmp', 'data']) mkdirSync(join(root, name));
  const hub = new OapHubClient({
    command,
    args: ['-e', script],
    cwd: root,
    timeoutMs,
    env: {
      NODE_ENV: 'test',
      HOME: join(root, 'home'),
      TMPDIR: join(root, 'tmp'),
      HYPERNEO_DATA_DIR: join(root, 'data'),
    },
  });
  clients.push(hub);
  return hub;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((hub) => hub.close()));
});

describe('OAP hub child lifecycle and correlation', () => {
  test('delivers the refused feature to the reopen decision without replay', async () => {
    const { decideReopenFailure } = await import('../../../../src/lib/oap/oap-session-open');
    const hub = await client();
    await hub.connect();
    for (const feature of ['session.open.reopen', 'run.cancel']) {
      const error = await hub
        .request('feature-refusal', { feature })
        .catch((reason: Error) => reason);
      expect(error).toMatchObject({ code: 'unsupported_feature', feature });
      expect(decideReopenFailure(error as { code: string; feature?: string }).mode).toBe(
        feature === 'session.open.reopen' ? 'summary' : 'error'
      );
    }
    expect(await hub.request('stats')).toMatchObject({ 'feature-refusal': 2 });
  });
  test.each(['unknown_session', 'busy'])(
    'cleanup refusal %s keeps unrelated pending requests and subscribers alive',
    async (code) => {
      const hub = await client(process.execPath, 200);
      await hub.connect();
      const received: Array<OapHubFrame | Error> = [];
      await hub.subscribe('synthetic', (frame) => received.push(frame));
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      let unrelatedFailure: Error | undefined;
      try {
        const declined = hub.subscribe(`cleanup-${code}`, () => {}).catch((error: Error) => error);
        await hub.request('stats');
        await vi.advanceTimersByTimeAsync(100);
        void hub.request('hang').catch((error: Error) => {
          unrelatedFailure = error;
        });
        await vi.advanceTimersByTimeAsync(100);
        expect(((await declined) as Error).message).toContain('timed out');
        await hub.request('stats');
        await hub.request('emit');
        expect(await hub.request('stats')).toMatchObject({ unsubscribe: code === 'busy' ? 2 : 1 });
        expect(unrelatedFailure).toBeUndefined();
        expect(received.filter((frame) => frame instanceof Error)).toHaveLength(0);
        expect(received.at(-1)).toMatchObject({ event: 'envelope' });
      } finally {
        vi.useRealTimers();
      }
    }
  );

  test('a cleanup timeout still fails the transport and notifies established subscribers', async () => {
    const hub = await client(process.execPath, 200);
    await hub.connect();
    const received: Array<OapHubFrame | Error> = [];
    await hub.subscribe('synthetic', (frame) => received.push(frame));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const declined = hub.subscribe('cleanup-timeout', () => {}).catch((error: Error) => error);
      await hub.request('stats');
      await vi.advanceTimersByTimeAsync(200);
      expect(((await declined) as Error).message).toContain('timed out');
      await hub.request('stats');
      await vi.advanceTimersByTimeAsync(200);
      expect(received.filter((frame) => frame instanceof Error)).toHaveLength(1);
      await expect(hub.request('later')).rejects.toThrow('timed out');
    } finally {
      vi.useRealTimers();
    }
  });

  test('a live silent child cannot hold a request beyond its configured deadline', async () => {
    const hub = await client(process.execPath, 200);
    await hub.connect();
    const answer = await Promise.race([
      hub.request('hang').catch((error: Error) => error),
      new Promise<undefined>((resolve) => setTimeout(resolve, 1000)),
    ]);
    expect(answer).toBeInstanceOf(Error);
    expect((answer as Error).message).toContain('timed out');
    expect(await hub.request('fast')).toBe(1);
  });

  test('a subscription acknowledgment timeout removes the remote subscription', async () => {
    const hub = await client(process.execPath, 200);
    await hub.connect();
    const received: unknown[] = [];
    const answer = await Promise.race([
      hub.subscribe('never-ack', (frame) => received.push(frame)).catch((error: Error) => error),
      new Promise<undefined>((resolve) => setTimeout(resolve, 1000)),
    ]);
    expect(answer).toBeInstanceOf(Error);
    expect((answer as Error).message).toContain('timed out');
    expect(await hub.request('stats')).toMatchObject({ events: 1, unsubscribe: 1 });
    await hub.request('emit');
    expect(received).toHaveLength(0);
  });

  test('busy replay retains the original request deadline', async () => {
    const hub = await client(process.execPath, 200);
    await hub.connect();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let failure: Error | undefined;
    try {
      void hub.request('busy-held').catch((error: Error) => {
        failure = error;
      });
      await hub.request('stats');
      await vi.advanceTimersByTimeAsync(120);
      await hub.request('release-busy');
      expect(await hub.request('stats')).toMatchObject({ 'busy-held': 2 });
      await vi.advanceTimersByTimeAsync(80);
      expect(failure?.message).toContain('timed out');
    } finally {
      vi.useRealTimers();
    }
  });

  test('close escalates when its own child ignores SIGTERM', async () => {
    const hub = await client(process.execPath, 100);
    await hub.connect();
    const pid = (await hub.request('ignore-term')) as number;
    let externalCleanup = false;
    const watchdog = setTimeout(() => {
      externalCleanup = true;
      process.kill(pid, 'SIGKILL');
    }, 2000);
    try {
      await hub.close();
      expect(externalCleanup).toBe(false);
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      clearTimeout(watchdog);
    }
  });

  test('child exit rejects all pending hub requests exactly once', async () => {
    const hub = await client();
    await hub.connect();
    const events: Array<OapHubFrame | Error> = [];
    await hub.subscribe('synthetic', (event) => events.push(event));
    const rejected = [0, 0];
    const results = await Promise.allSettled(
      [0, 1].map((index) =>
        hub.request('exit').catch((error: Error) => {
          rejected[index]++;
          throw error;
        })
      )
    );
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    for (const result of results)
      if (result.status === 'rejected') expect(result.reason.message).toContain('code=7');
    await hub.close();
    await hub.close();
    expect(rejected).toEqual([1, 1]);
    expect(events.filter((event) => event instanceof Error)).toHaveLength(1);
    await expect(hub.request('after-exit')).rejects.toThrow('code=7');
  });

  test('busy resends once and every other refusal is returned without replay', async () => {
    const hub = await client();
    await hub.connect();
    expect(await hub.request('busy-once')).toBe(2);
    await expect(hub.request('busy-always')).rejects.toMatchObject({ code: 'busy' });
    await expect(hub.request('refused')).rejects.toMatchObject({ code: 'unknown_session' });
    expect(await hub.request('stats')).toMatchObject({
      'busy-once': 2,
      'busy-always': 2,
      refused: 1,
    });
  });

  test('out-of-order replies resolve the matching caller', async () => {
    const hub = await client();
    await hub.connect();
    expect(
      await Promise.all([
        hub.request('slow', { value: 'first' }),
        hub.request('fast', { value: 'second' }),
      ])
    ).toEqual(['first', 'second']);
  });

  test('overlapping subscriptions preserve ids and same-chunk events then unsubscribe once', async () => {
    const hub = await client();
    await hub.connect();
    const first: Array<OapHubFrame | Error> = [],
      second: Array<OapHubFrame | Error> = [];
    const a = await hub.subscribe('synthetic', (event) => first.push(event));
    const b = await hub.subscribe('synthetic', (event) => second.push(event), {
      after: 3,
      run_id: 'run',
    });
    expect(first).toEqual([expect.objectContaining({ id: a.id, event: 'oap-subscribed' })]);
    expect(second).toEqual([expect.objectContaining({ id: b.id, event: 'oap-subscribed' })]);
    await hub.request('emit');
    expect(first.at(-1)).toMatchObject({ id: a.id, data: { sequence: 4 } });
    expect(second.at(-1)).toMatchObject({
      id: b.id,
      data: { envelope: { type: 'content.delta' } },
    });
    await Promise.all([a.unsubscribe(), a.unsubscribe()]);
    await hub.request('emit');
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(3);
    expect(await hub.request('stats')).toMatchObject({ unsubscribe: 1 });
  });

  test('a malformed line fails the connection before a later valid reply', async () => {
    const hub = await client();
    await hub.connect();
    await expect(hub.request('malformed')).rejects.toThrow();
    await expect(hub.request('later')).rejects.toThrow();
  });

  test('split UTF-8 and chunk boundaries preserve the reply', async () => {
    const hub = await client();
    await hub.connect();
    expect(await hub.request('unicode')).toBe('雪');
  });

  test('stderr cannot block hub stdout replies', async () => {
    const hub = await client();
    await hub.connect();
    expect(await hub.request('stderr')).toBe('drained');
  });

  test('closing rejects outstanding requests and never reconnects implicitly', async () => {
    const hub = await client();
    await expect(hub.request('before-connect')).rejects.toThrow('not connected');
    await hub.connect();
    const pending = hub.request('exit');
    const result = Promise.allSettled([pending]);
    await hub.close();
    expect((await result)[0].status).toBe('rejected');
    await expect(hub.connect()).rejects.toThrow('connects once');
  });

  test('spawn failure rejects connect and subsequent requests', async () => {
    const hub = await client('/nonexistent-synthetic-oap-hub');
    await expect(hub.connect()).rejects.toThrow();
    await expect(hub.request('adapters')).rejects.toThrow();
  });

  test('a throwing listener does not break another subscription or request', async () => {
    const hub = await client();
    await hub.connect();
    await hub.subscribe('synthetic', () => {
      throw new Error('synthetic listener failure');
    });
    const received: unknown[] = [];
    await hub.subscribe('synthetic', (frame) => received.push(frame));
    await hub.request('emit');
    expect(received).toHaveLength(2);
    expect(await hub.request('fast')).toBe(1);
  });
});
