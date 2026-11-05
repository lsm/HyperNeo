import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { SpaceRepository } from '../../../packages/daemon/src/storage/repositories/space-repository.ts';
import { SpaceAgentRepository } from '../../../packages/daemon/src/storage/repositories/space-agent-repository.ts';
import type { SpaceLongHorizonAgentReminder } from '../../../packages/shared/src/types/space.ts';

const [mode, directory] = process.argv.slice(2), run = resolve(directory);
assert.equal(mode, 'verify');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'evidence'), { recursive: true });
const originalFetch = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('External HTTP forbidden'); }) as typeof fetch;
const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
let ws: WebSocket | undefined, measuring = false;
const replies: unknown[] = [], mainSql: string[] = [];
const raw = app.db.getDatabase(), prepare = raw.prepare.bind(raw);
raw.prepare = ((sql: string) => { if (measuring && /^(?:SELECT \* FROM space_long_horizon_agents WHERE id = \?|INSERT INTO space_long_horizon_agent_reminders|SELECT \* FROM space_long_horizon_agent_reminders WHERE id = \?)/.test(sql)) mainSql.push(sql); return prepare(sql); }) as typeof raw.prepare;
try {
  await app.spaceRuntimeService.ready(); await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  const space = new SpaceRepository(raw).createSpace({ slug: 'reminder-delete', name: 'Reminder deletion', workspacePath: join(run, 'workspace') });
  const agents = new SpaceAgentRepository(raw);
  const agent = agents.create({ spaceId: space.id, handle: 'reminder-owner', status: 'paused' });
  const otherSpace = new SpaceRepository(raw).createSpace({ slug: 'other-reminders', name: 'Other reminders', workspacePath: join(run, 'other') });
  const other = agents.create({ spaceId: otherSpace.id, handle: 'control-owner', status: 'paused' });
  ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('RPC connection failed')); });
  const rpc = <T>(method: string, data: unknown) => new Promise<T>((done, fail) => {
    const id = crypto.randomUUID(), timer = setTimeout(() => { ws!.removeEventListener('message', listener); fail(new Error(`RPC timeout: ${method}`)); }, 15000);
    const listener = (event: MessageEvent) => { const reply = JSON.parse(String(event.data)); if (reply.id !== id && reply.requestId !== id) return; clearTimeout(timer); ws!.removeEventListener('message', listener); replies.push({ method, reply }); if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data); };
    ws!.addEventListener('message', listener);
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method, data, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  const body = 'Keep the complete creation body 甲乙🙂'.repeat(3000), runAt = Date.now() + 86400000;
  const base = { spaceId: space.id, agentId: agent.id, title: 'At reminder', triggerType: 'at', runAt };
  const create = async (input: unknown) => (await rpc<{ reminder: SpaceLongHorizonAgentReminder }>('spaceAgentReminder.create', input)).reminder;
  measuring = true;
  const at = await create({ ...base, body });
  const defaults = await create({ ...base, title: 'Default body', timezone: 'America/New_York' });
  const cron = await create({ ...base, title: 'Cron reminder', triggerType: 'cron', runAt: undefined, cronExpression: '0 0 * * *', timezone: 'UTC', body });
  const concurrent = await Promise.all([create({ ...base, title: 'Concurrent reminder' }), create({ ...base, title: 'Concurrent reminder' })]);
  const invalid: Array<[Record<string, unknown>, RegExp]> = [
    [{ ...base, spaceId: '' }, /spaceId is required/], [{ ...base, agentId: '' }, /agentId is required/],
    [{ ...base, title: '' }, /title is required/], [{ ...base, triggerType: '' }, /triggerType is required/],
    [{ ...base, runAt: undefined }, /runAt is required/],
    [{ ...base, triggerType: 'cron', cronExpression: '' }, /cronExpression is required/],
    [{ ...base, triggerType: 'cron', cronExpression: 'not-a-cron' }, /Invalid cron expression/],
    [{ ...base, triggerType: 'cron', cronExpression: '0 0 * * *', timezone: 'Invalid/Fixture' }, /Invalid timezone or cron expression/],
    [{ ...base, agentId: 'missing-agent' }, /Long-horizon agent not found/],
    [{ ...base, spaceId: otherSpace.id }, /does not belong to space/],
  ];
  for (const [input, error] of invalid) await assert.rejects(create(input), error);
  measuring = false;
  const { id, createdAt, updatedAt, ...stored } = at;
  assert.equal(typeof id, 'string'); assert.equal(createdAt, updatedAt); assert(createdAt <= Date.now());
  assert.deepEqual(stored, { spaceId: space.id, agentId: agent.id, title: base.title, body, status: 'active', triggerType: 'at', runAt, cronExpression: null, timezone: 'UTC', nextRunAt: runAt, lastFiredAt: null, createdBySession: null });
  assert.equal(defaults.body, ''); assert.equal(defaults.timezone, 'America/New_York'); assert.equal(defaults.nextRunAt, runAt);
  assert.equal(cron.body, body); assert.equal(cron.runAt, null); assert.equal(cron.cronExpression, '0 0 * * *'); assert.equal(cron.timezone, 'UTC');
  assert(cron.nextRunAt && cron.nextRunAt > Date.now() && cron.nextRunAt <= Date.now() + 86400000);
  assert.equal(new Date(cron.nextRunAt).getUTCHours(), 0); assert.equal(new Date(cron.nextRunAt).getUTCMinutes(), 0);
  assert.notEqual(concurrent[0].id, concurrent[1].id);
  const list = async () => {
    const result = await rpc<{ reminders: Array<{ id: string; body: string }> }>('operation.invoke', { name: 'agent.reminder.list', input: { spaceId: space.id, agentId: agent.id } });
    assert(Array.isArray(result.reminders), JSON.stringify(result)); return result.reminders;
  };
  const beforeFailure = await list();
  assert.equal(beforeFailure.length, 5); assert.equal(beforeFailure.find(reminder => reminder.id === at.id)?.body, body);
  raw.exec("CREATE TRIGGER verify_reminder_create_failure BEFORE INSERT ON space_long_horizon_agent_reminders WHEN NEW.title = 'Failing fixture' BEGIN SELECT RAISE(ABORT, 'synthetic reminder create failure'); END");
  try { measuring = true; await assert.rejects(create({ ...base, title: 'Failing fixture' }), /synthetic reminder create failure/); }
  finally { measuring = false; raw.exec('DROP TRIGGER verify_reminder_create_failure'); }
  assert.deepEqual(await list(), beforeFailure);
  const counts = (await rpc<{ counts: Record<string, number> }>('spaceAgentReminder.listCounts', { agentIds: [agent.id, other.id] })).counts;
  assert.deepEqual(counts, { [agent.id]: 5, [other.id]: 0 });
  const errors = replies.map(item => (item as { reply: { error?: string; errorCode?: string } }).reply).filter(reply => reply.error);
  assert.deepEqual(errors.map(reply => reply.errorCode), Array(11).fill('HANDLER_ERROR'));
  console.log('ok: real reminder create/list/count RPCs retain full bodies, defaults, at/cron timing, validation errors, distinct concurrent IDs and insert rollback; neutral characterization leaves SQL on main');
} finally {
  measuring = false; ws?.close(); await app.cleanup(); globalThis.fetch = originalFetch;
  writeFileSync(join(run, 'evidence/agent-reminder-create-contract.json'), JSON.stringify({ mode, mainSql, replies, sqlHash: createHash('sha256').update(mainSql.join('\n')).digest('hex'), limitation: 'Neutral input planning extraction; reminder creation SQL remains on main.' }, null, 2));
}
