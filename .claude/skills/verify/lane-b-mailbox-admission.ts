import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const name of ['home', 'workspace', 'evidence']) mkdirSync(join(run, name), { recursive: true });
const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
const { getConfig } = await import('../../../packages/daemon/src/config.ts');
const { MessageHub, WebSocketClientTransport } = await import('../../../packages/shared/src/mod.ts');
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let transport: InstanceType<typeof WebSocketClientTransport> | undefined;
const evidence: Record<string, unknown> = {};
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
try {
  app = await createDaemonApp({
    config: {
      ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') }),
      disableWorktrees: true,
      disableGoalProcessing: true,
    },
    verbose: false,
  });
  assert.notEqual(app.server.port, 8399);
  await app.jobProcessor.stop();
  const hub = new MessageHub({ defaultSessionId: 'global' });
  transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false });
  hub.registerTransport(transport);
  await transport.initialize();
  const { sessionId } = await hub.request<{ sessionId: string }>('session.create', {
    workspacePath: join(run, 'workspace'), config: { queryMode: 'manual' },
  });
  const raw = app.db.getDatabase();
  const { SessionScheduler } = await import('../../../packages/daemon/src/lib/scheduler/session-schedules.ts');
  const { createScheduleDelivery } = await import('../../../packages/daemon/src/lib/scheduler/session-schedule-delivery.ts');
  const { createOperationRegistry } = await import('../../../packages/daemon/src/lib/operations/registry.ts');
  const schedule = new SessionScheduler(raw, app.jobQueue).create({
    target: { adapter: 'hyperneo', id: sessionId }, sourceKind: 'reminder', sourceId: 'synthetic',
    note: 'One reminder', nudgeEvery: 1, cadence: { kind: 'every', everyMs: 60000 }, createdBySession: null,
  });
  const prepare = raw.prepare;
  let mainSqlAttempts = 0;
  raw.prepare = (...args) => {
    if (/\/(?:mailbox\/(?:handoff|enqueue)|scheduler\/session-schedule-delivery)\.ts/.test(new Error().stack ?? '')) {
      mainSqlAttempts++;
      throw new Error('mailbox admission SQL reached main connection');
    }
    return Reflect.apply(prepare, raw, args);
  };
  const body = 'complete synthetic message '.repeat(10000);
  try {
    evidence.health = await hub.request('system.health', {});
    const started = performance.now();
    const sent = await hub.request<{ kind: string; mailboxId: string; messageId: string }>('operation.invoke', {
      name: 'message.send', input: { sessionId, message: { type: 'user', message: { role: 'user', content: body }, parent_tool_use_id: null } },
    });
    evidence.rpcMs = performance.now() - started;
    evidence.sent = sent;
    evidence.mainSqlAttempts = mainSqlAttempts;
    assert.equal(mainSqlAttempts, 0, 'mailbox admission must not use main SQLite');
    assert.equal(sent.kind, 'accepted');
    const jobs = app.jobQueue.listActiveByPayload('mailbox', { id: sent.mailboxId });
    assert.equal(jobs.length, 1);
    const payload = jobs[0].payload as { message: { message: { content: string } }; messageUuid: string; to: { sessionId: string } };
    assert.equal(payload.to.sessionId, sessionId);
    assert.equal(payload.messageUuid, sent.messageId);
    assert.equal(hash(payload.message.message.content), hash(body));
    evidence.fullBodyHash = hash(body);
    evidence.bodyBytes = Buffer.byteLength(body);
    const scheduledId = `schedule:${schedule.id}:${schedule.nextRunAt}`;
    const delivery = createScheduleDelivery(app.db, () => createOperationRegistry([]));
    await Promise.all([
      delivery.deliver(schedule, scheduledId, 'One reminder'),
      delivery.deliver(schedule, scheduledId, 'One reminder'),
    ]);
    const scheduled = app.jobQueue.listActiveByPayload('mailbox', { 'to.sessionId': sessionId, messageUuid: scheduledId });
    assert.equal(scheduled.length, 1, 'concurrent scheduled retries must enqueue once');
    evidence.scheduledRetries = scheduled.length;
    assert.equal(mainSqlAttempts, 0);
    evidence.healthAfter = await hub.request('system.health', {});
  } finally {
    evidence.mainSqlAttempts = mainSqlAttempts;
    raw.prepare = prepare;
  }
} finally {
  writeFileSync(join(run, 'evidence/mailbox-admission.json'), JSON.stringify(evidence, null, 2));
  await transport?.close();
  await app?.cleanup();
}
console.log('ok real message.send RPC retains complete mailbox content without main admission SQL');
