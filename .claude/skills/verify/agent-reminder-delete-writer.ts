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
raw.prepare = ((sql: string) => { if (measuring && /^(?:DELETE FROM|SELECT \* FROM) space_long_horizon_agent_reminders WHERE id = \?/.test(sql)) mainSql.push(sql); return prepare(sql); }) as typeof raw.prepare;
try {
  await app.spaceRuntimeService.ready(); await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  const space = new SpaceRepository(raw).createSpace({ slug: 'reminder-delete', name: 'Reminder deletion', workspacePath: join(run, 'workspace') });
  const agents = new SpaceAgentRepository(raw);
  const agent = agents.create({ spaceId: space.id, handle: 'reminder-owner', status: 'paused' });
  const other = agents.create({ spaceId: space.id, handle: 'control-owner', status: 'paused' });
  ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('RPC connection failed')); });
  const rpc = <T>(method: string, data: unknown) => new Promise<T>((done, fail) => {
    const id = crypto.randomUUID(), timer = setTimeout(() => { ws!.removeEventListener('message', listener); fail(new Error(`RPC timeout: ${method}`)); }, 15000);
    const listener = (event: MessageEvent) => { const reply = JSON.parse(String(event.data)); if (reply.id !== id && reply.requestId !== id) return; clearTimeout(timer); ws!.removeEventListener('message', listener); replies.push({ method, reply }); if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data); };
    ws!.addEventListener('message', listener);
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method, data, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  const body = 'Preserve unrelated reminder 甲乙🙂'.repeat(3000);
  const create = async (agentId: string, title: string) => (await rpc<{ reminder: SpaceLongHorizonAgentReminder }>('spaceAgentReminder.create', { spaceId: space.id, agentId, title, body, triggerType: 'at', runAt: Date.now() + 86400000 })).reminder;
  const list = async (agentId: string) => {
    const result = await rpc<{ reminders: Array<{ id: string; message: string; body: string; state: string }> }>('operation.invoke', { name: 'agent.reminder.list', input: { spaceId: space.id, agentId } });
    assert(Array.isArray(result.reminders), JSON.stringify(result));
    return result.reminders;
  };
  const remove = (reminderId: string) => rpc<{ success: boolean }>('spaceAgentReminder.delete', { reminderId });
  const counts = async () => (await rpc<{ counts: Record<string, number> }>('spaceAgentReminder.listCounts', { agentIds: [agent.id, other.id] })).counts;
  const target = await create(agent.id, 'Delete this reminder'), race = await create(agent.id, 'One deletion winner'), control = await create(other.id, 'Keep this reminder');
  const controlView = await list(other.id);
  assert.equal(controlView[0].id, control.id); assert.equal(controlView[0].body, body);
  assert.deepEqual(await counts(), { [agent.id]: 2, [other.id]: 1 });
  measuring = true;
  assert.equal((await remove(target.id)).success, true);
  await assert.rejects(remove(target.id), /Reminder not found/);
  await assert.rejects(remove(''), /reminderId is required/);
  measuring = false;
  assert.deepEqual((await list(agent.id)).map(reminder => reminder.id), [race.id]);
  assert.deepEqual(await counts(), { [agent.id]: 1, [other.id]: 1 });
  measuring = true;
  const outcomes = await Promise.allSettled([remove(race.id), remove(race.id)]);
  measuring = false;
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1, 'Exactly one concurrent delete must succeed');
  const rejected = outcomes.find(outcome => outcome.status === 'rejected');
  assert(rejected?.status === 'rejected'); assert.match(String(rejected.reason), /Reminder not found/);
  assert.deepEqual(await list(agent.id), []);
  assert.deepEqual(await counts(), { [agent.id]: 0, [other.id]: 1 });
  const retained = await create(agent.id, 'Deletion failure retains this reminder');
  const beforeFailure = await list(agent.id);
  raw.exec(`CREATE TRIGGER verify_reminder_delete_failure BEFORE DELETE ON space_long_horizon_agent_reminders WHEN OLD.id = '${retained.id}' BEGIN SELECT RAISE(ABORT, 'synthetic reminder delete failure'); END`);
  try {
    measuring = true;
    await assert.rejects(remove(retained.id), /synthetic reminder delete failure/);
  } finally { measuring = false; raw.exec('DROP TRIGGER verify_reminder_delete_failure'); }
  assert.deepEqual(await list(agent.id), beforeFailure);
  assert.deepEqual(await list(other.id), controlView);
  assert.deepEqual(await counts(), { [agent.id]: 1, [other.id]: 1 });
  assert.deepEqual(mainSql, [], 'Reminder existence admission and deletion SQL must leave the main connection together');
  console.log('ok: real reminder delete/list/count RPCs preserve one concurrent winner, missing-ID errors, unrelated full bodies and rollback, with zero admission/delete SQL on main');
} finally {
  measuring = false; ws?.close(); await app.cleanup(); globalThis.fetch = originalFetch;
  writeFileSync(join(run, 'evidence/agent-reminder-delete-writer.json'), JSON.stringify({ mode, mainSql, replies }, null, 2));
}
