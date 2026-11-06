import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OapHubFrame } from '../../../../src/lib/oap/oap-hub-codec';
import { testDirectories } from '../../../helpers/temporary-directory';

const directory = testDirectories();
const clients: { close(): Promise<void> }[] = [];
const script = `
const subscriptions = new Set(), counts = {};
const line = (value) => JSON.stringify(value) + '\\n';
const reply = (id, result) => process.stdout.write(line({ id, ok: true, result }));
require('node:readline').createInterface({ input: process.stdin }).on('line', (text) => {
  const r = JSON.parse(text), count = counts[r.op] = (counts[r.op] || 0) + 1;
  if (r.op === 'exit') { if (count === 2) process.exit(7); return; }
  if (r.op === 'busy-once' && count === 1 || r.op === 'busy-always')
    return process.stdout.write(line({ id:r.id, ok:false, error:{code:'busy', message:'send this request again'} }));
  if (r.op === 'refused') return process.stdout.write(line({ id:r.id, ok:false, error:{code:'unknown_session', message:'synthetic'} }));
  if (r.op === 'events') {
    subscriptions.add(r.id);
    return process.stdout.write(line({id:r.id, ok:true, result:null}) + line({id:r.id,event:'oap-subscribed',joined_after:0}));
  }
  if (r.op === 'unsubscribe') { subscriptions.delete(r.subscription); return reply(r.id, null); }
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

async function client(command = process.execPath) {
  const { OapHubClient } = await import('../../../../src/lib/oap/oap-hub-client');
  const root = directory(join(tmpdir(), 'oap-hub-client-'));
  for (const name of ['home', 'tmp', 'data']) mkdirSync(join(root, name));
  const hub = new OapHubClient({
    command,
    args: ['-e', script],
    cwd: root,
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
