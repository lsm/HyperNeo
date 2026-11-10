import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SDKMessage } from '../../../packages/shared/src/sdk/index.ts';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import type { Session } from '../../../packages/shared/src/types.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));

process.env.HYPERNEO_TASK_NOTIFICATION_REQUERY_BASE_DELAY_MS = '0';

const ZERO_USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

function hollowResult(sessionId: string, uuid: string): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result: '',
    stop_reason: null,
    total_cost_usd: 0,
    usage: { ...ZERO_USAGE },
    modelUsage: {},
    permission_denials: [],
    parent_tool_use_id: null,
    uuid,
    session_id: sessionId,
    origin: { kind: 'task-notification' },
  } as unknown as SDKMessage;
}

async function launch() {
  const app = await createDaemonApp({
    config: {
      ...getConfig({
        host: '127.0.0.1',
        port: 0,
        dbPath: join(run, 'data', 'daemon.db'),
      }),
      disableWorktrees: true,
    },
    standalone: true,
    verbose: false,
  });
  await app.jobProcessor.stop();
  return app;
}

const sessionId = 'requery-proof-session';
const isEscalationError = (data: { sessionId: string; error: string }) =>
  data.sessionId === sessionId && data.error.includes('background-task notification');

function readEpisode(db: { getSession(id: string): Session | null }) {
  return db.getSession(sessionId)?.metadata.taskNotificationRequeryEpisode;
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 60_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(200);
  assert(predicate(), `timed out waiting for ${label}`);
}

let sessionErrors = 0;
const evidence: Record<string, unknown> = {};

const app = await launch();
try {
  app.internalEventBus.subscribe(
    'session.error',
    (data) => {
      if (isEscalationError(data)) sessionErrors += 1;
    },
    { subscriberName: 'requery-proof' }
  );
  await app.db.createSession({
    id: sessionId,
    title: 'Requery proof',
    workspacePath: run,
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    status: 'active',
    config: { model: 'default', maxTokens: 8192, temperature: 1.0 },
    metadata: {},
  } as Session);

  const agentSession = await app.sessionManager.getSessionAsync(sessionId, {
    startQuery: false,
  });
  assert(agentSession, 'session must attach');
  agentSession.messageQueue.start();

  for (let i = 0; i < 10; i++) {
    await agentSession.onSDKMessage(hollowResult(sessionId, `hollow-${i}`));
    await Bun.sleep(50);
  }

  await waitFor(() => sessionErrors === 1, 'the single escalation');
  await waitFor(
    () => readEpisode(app.db)?.escalation === 'done',
    'the persisted escalation disposition'
  );

  const episode = readEpisode(app.db);
  evidence.firstDaemon = { sessionErrors, episode };
  assert(episode, 'episode record must persist');
  assert.equal(episode.attempts >= 5, true);
  assert.equal(episode.closed, false);
} finally {
  await app.cleanup();
}

const app2 = await launch();
try {
  let restartErrors = 0;
  app2.internalEventBus.subscribe(
    'session.error',
    (data) => {
      if (isEscalationError(data)) restartErrors += 1;
    },
    { subscriberName: 'requery-proof-2' }
  );
  const agentSession = await app2.sessionManager.getSessionAsync(sessionId, {
    startQuery: false,
  });
  assert(agentSession, 'session must reattach after restart');
  agentSession.messageQueue.start();

  for (let i = 0; i < 8; i++) {
    await agentSession.onSDKMessage(hollowResult(sessionId, `post-restart-${i}`));
    await Bun.sleep(50);
  }
  await Bun.sleep(2_000);

  const episode = readEpisode(app2.db);
  evidence.afterRestart = { sessionErrors: restartErrors, episode };
  assert.equal(restartErrors, 0, 'later failures hold after restart — no second escalation');
  assert(episode, 'episode record must survive restart');
  assert.equal(episode.escalation, 'done');
  assert.equal(episode.closed, false);
} finally {
  await app2.cleanup();
}

mkdirSync(join(run, 'evidence'), { recursive: true });
writeFileSync(join(run, 'evidence', 'requery-episode-durable.json'), JSON.stringify(evidence, null, 2));
process.exit(0);
