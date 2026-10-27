import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Database } from '../../../packages/daemon/src/storage/database.ts';
import { createReactiveDatabase } from '../../../packages/daemon/src/storage/reactive-database.ts';
import { AgentSession } from '../../../packages/daemon/src/lib/agent/agent-session.ts';
import { createDaemonInternalEventBus } from '../../../packages/daemon/src/lib/internal-event-bus.ts';
import { MessageHub, type Session } from '../../../packages/shared/src/mod.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const part of ['data', 'workspace', 'evidence']) mkdirSync(join(run, part), { recursive: true });
const db = new Database(join(run, 'data', 'daemon.db'));
const reactive = createReactiveDatabase(db);
await db.initialize(reactive);
const session: Session = {
  id: 'synthetic-stop-interrupt', title: 'Synthetic stop interrupt',
  workspacePath: join(run, 'workspace'), status: 'active',
  createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
  config: { model: 'haiku', provider: 'anthropic' }, metadata: {},
};
await db.createSession(session);
const hub = new MessageHub({ defaultSessionId: 'global' });
const agent = new AgentSession(session, db, hub, createDaemonInternalEventBus(), async () => null,
  undefined, undefined, undefined, undefined, { autoReplayPendingMessages: false });
const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000);'], {
  cwd: join(run, 'workspace'), env: { HOME: process.env.HOME, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
  stdio: ['ignore', 'pipe', 'ignore'],
});
const exited = once(child, 'exit');
let releaseInterrupt!: () => void;
const interruptReply = new Promise<void>((done) => { releaseInterrupt = done; });
let interrupted = false;
let closed = false;
let deadline: ReturnType<typeof setTimeout> | undefined;
const evidence: Record<string, unknown> = { surface: 'AgentSession.resetQuery used by session.resetQuery', syntheticSdkInterrupt: true, actualOwnedProcess: true, rpcTransportVerified: false };
let resetting: Promise<{ success: boolean; error?: string }> | undefined;
try {
  await once(child.stdout!, 'data');
  agent.trackAgentProcess(child);
  agent.queryObject = {
    interrupt: () => { interrupted = true; return interruptReply; },
    close: () => { closed = true; },
  } as unknown as NonNullable<AgentSession['queryObject']>;
  agent.queryPromise = exited.then(() => {});
  agent.queryAbortController = new AbortController();
  agent.firstMessageReceived = true;
  agent.messageQueue.start();
  await agent.stateManager.setProcessing('synthetic-reset');
  const started = Date.now();
  resetting = agent.resetQuery({ restartQuery: false });
  const result = await Promise.race([
    resetting,
    new Promise<null>((done) => { deadline = setTimeout(() => done(null), 7000); }),
  ]);
  Object.assign(evidence, { result, elapsedMs: Date.now() - started, interrupted, closed, childExitCode: child.exitCode, childSignal: child.signalCode, state: agent.stateManager.getState(), queryCleared: agent.queryObject === null });
  assert(result?.success, 'Reset never finished when the SDK did not answer interrupt');
  assert(interrupted && closed);
  assert(child.exitCode !== null || child.signalCode !== null, 'Reset left its owned process alive');
  assert.equal(agent.stateManager.getState().status, 'idle');
  assert.equal(agent.queryObject, null);
  evidence.pass = true;
  console.log('PASS: reset returns, the owned process exits, and the session becomes idle despite a non-answering SDK interrupt.');
} finally {
  if (deadline) clearTimeout(deadline);
  releaseInterrupt();
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await exited;
  await resetting;
  await agent.cleanup();
  hub.cleanup();
  await db.close();
  evidence.cleaned = true;
  writeFileSync(join(run, 'evidence', 'observed.json'), JSON.stringify(evidence, null, 2));
}
