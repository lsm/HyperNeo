import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { QueryOptionsBuilder } from '../../../src/lib/agent/query-options-builder';
import type { Session } from '@hyperneo/shared';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import { getProcessingState } from '../../helpers/daemon-actions';

const SETUP_TIMEOUT = 75000;

describe('Consumed startup timeout reaches the shared failure cap', () => {
  let daemon: DaemonServerContext;
  let restoreOptions: () => void;
  let starts: number[];

  beforeEach(async () => {
    starts = [];
    const build = QueryOptionsBuilder.prototype.build;
    QueryOptionsBuilder.prototype.build = async function (...args) {
      const options = await build.apply(this, args);
      await new Promise((resolve) => setTimeout(resolve, 25));
      return {
        ...options,
        spawnClaudeCodeProcess: (opts) => {
          starts.push(Date.now());
          return spawn(
            process.execPath,
            ['-e', 'process.stdin.resume();setInterval(() => {}, 1000);'],
            {
              cwd: opts.cwd,
              env: opts.env,
              stdio: ['pipe', 'pipe', 'pipe'],
              signal: opts.signal,
            }
          );
        },
      };
    };
    restoreOptions = () => {
      QueryOptionsBuilder.prototype.build = build;
    };
    const prior = process.env.DAEMON_TEST_SPAWN;
    process.env.DAEMON_TEST_SPAWN = 'false';
    try {
      daemon = await createDaemonServer({
        modelsReadyTimeoutMs: 25000,
        devProxy: process.env.VERIFY_STARTUP_PROXY_PORT
          ? { port: Number(process.env.VERIFY_STARTUP_PROXY_PORT) }
          : undefined,
        env: { LOG_LEVEL: 'warn', HYPERNEO_SDK_START_INACTIVITY_TIMEOUT_MS: '2000' },
      });
    } finally {
      if (prior === undefined) delete process.env.DAEMON_TEST_SPAWN;
      else process.env.DAEMON_TEST_SPAWN = prior;
    }
  }, SETUP_TIMEOUT);

  afterEach(async () => {
    try {
      if (daemon) {
        daemon.kill('SIGTERM');
        await daemon.waitForExit();
      }
    } finally {
      restoreOptions();
    }
  }, SETUP_TIMEOUT);

  test('a delivered prompt gets three bounded starts and a visible terminal error', async () => {
    const { sessionId } = await daemon.messageHub.request<{ sessionId: string }>('session.create', {
      workspacePath: process.cwd(),
      title: 'Synthetic consumed startup failure',
      config: { model: 'haiku', permissionMode: 'acceptEdits' },
    });
    daemon.trackSession(sessionId);
    await daemon.messageHub.request('message.send', {
      sessionId,
      content: 'Synthetic silent process',
    });
    let episode: Session['metadata']['queryFailureEpisode'];
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const result = await daemon.messageHub.request<{ session: Session }>('session.get', {
        sessionId,
      });
      episode = result.session.metadata.queryFailureEpisode;
      if (episode?.failed) break;
      await new Promise((done) => setTimeout(done, 50));
    }
    expect(episode?.failed).toBe(true);
    expect(episode?.failures).toBe(3);
    expect(episode?.error).toContain('SDK startup timeout');
    expect(starts.length).toBe(3);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(950);
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(1950);
    const messages = await daemon.messageHub.request<{
      sdkMessages: { type: string; deliveryStatus?: string }[];
    }>('message.sdkMessages', { sessionId });
    expect(
      messages.sdkMessages.some((row) => row.type === 'user' && row.deliveryStatus === 'delivered')
    ).toBe(true);
    const errorDeadline = Date.now() + 3000;
    let terminal: { message: string } | null = null;
    while (Date.now() < errorDeadline) {
      const state = await daemon.messageHub.request<{ error?: { message: string } }>(
        'state.session',
        { sessionId }
      );
      terminal = state.error ?? null;
      if (terminal?.message.includes('Query stopped after 3 failures')) break;
      await new Promise((done) => setTimeout(done, 25));
    }
    expect(terminal?.message).toContain('Query stopped after 3 failures');
    expect((await getProcessingState(daemon, sessionId)).status).toBe('idle');
    await new Promise((done) => setTimeout(done, 2300));
    expect(starts.length).toBe(3);
  }, 45000);
});
