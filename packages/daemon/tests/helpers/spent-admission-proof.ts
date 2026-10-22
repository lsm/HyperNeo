import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageHub, WebSocketClientTransport, subscribeToStructuredLogs } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';

export async function verifySpentAdmission(
  kind: 'ordinary' | 'neo',
  acceptance: 'deadline' | 'full'
): Promise<void> {
  const run = await mkdtemp(join(tmpdir(), 'spent-admission-'));
  const requestId = randomUUID();
  const markers = ['ADMISSION_HEAD', 'QUEUED_ONE', 'QUEUED_TWO', 'QUEUED_THREE', 'QUEUED_FOUR'];
  const requests: string[] = [];
  const received = new Set<string>();
  const stages: Array<Record<string, unknown>> = [];
  const unsubscribe = subscribeToStructuredLogs((event) => {
    if (event.module === 'hyperneo:daemon:message-delivery.lifecycle')
      stages.push({ at: Date.now(), ...event.metadata });
  });
  let restarted = false;
  const evidence: Record<string, unknown> = { run, kind, acceptance, requestId, requests, stages };
  const fixture = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    res.setHeader('content-type', 'application/json');
    if (req.url?.includes('count_tokens')) return res.end('{"input_tokens":100}');
    if (req.url?.endsWith('/models')) return res.end(JSON.stringify({ data: [], has_more: false }));
    if (!req.url?.startsWith('/v1/messages')) {
      res.statusCode = 404;
      return res.end('{}');
    }
    const active =
      body.tools?.some((tool: { name: string }) =>
        tool.name.endsWith('hyperneo-operations__invoke')
      ) && JSON.stringify(body.messages).includes('synthetic recovery garden');
    const text = active ? `Visible synthetic recovery reply ${requests.length + 1}` : 'Probe ready';
    if (active) {
      requests.push(text);
      if (restarted)
        for (const marker of markers)
          if (JSON.stringify(body.messages).includes(marker)) received.add(marker);
    }
    const message = {
      id: `msg_${randomUUID()}`,
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 10 },
    };
    if (!body.stream) return res.end(JSON.stringify(message));
    res.setHeader('content-type', 'text/event-stream');
    const event = (type: string, data: unknown) =>
      res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    event('message_start', {
      type: 'message_start',
      message: { ...message, content: [], stop_reason: null },
    });
    event('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    });
    event('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    });
    event('content_block_stop', { type: 'content_block_stop', index: 0 });
    event('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 10 },
    });
    event('message_stop', { type: 'message_stop' });
    res.end();
  });
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const address = fixture.address();
  if (!address || typeof address === 'string') throw new Error('Missing synthetic model port');
  const environment = {
    NODE_ENV: 'test',
    HYPERNEO_USE_DEV_PROXY: '0',
    HYPERNEO_DATA_DIR: join(run, 'data'),
    HYPERNEO_WORKSPACE_PATH: run,
    CLAUDE_CONFIG_DIR: join(run, 'sdk'),
    TEST_SDK_SESSION_DIR: join(run, 'sdk'),
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
    DEFAULT_MODEL: 'haiku',
    HYPERNEO_DELIVERY_CONSUMPTION_TIMEOUT_MS: '3000',
  };
  const prior = new Map(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  let daemon: Awaited<ReturnType<typeof import('../../src/app.ts').createDaemonApp>> | undefined;
  let hub: MessageHub;
  let transport: WebSocketClientTransport | undefined;
  let sessionId = '';
  const dbPath = join(run, 'daemon.db');
  const read = async () => {
    const page = await hub.request<{ sdkMessages: SDKMessage[] }>('message.sdkMessages', {
      sessionId,
    });
    evidence.messages = page.sdkMessages;
    return page.sdkMessages;
  };
  const waitForReply = async (reply: string) => {
    const end = Date.now() + 20000;
    while (Date.now() < end) {
      if (JSON.stringify(await read()).includes(reply)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Conversation did not show ${reply}; requests=${JSON.stringify(requests)}`);
  };
  const { QueryOptionsBuilder } = await import('../../src/lib/agent/query-options-builder.ts');
  const build = QueryOptionsBuilder.prototype.build;
  QueryOptionsBuilder.prototype.build = async function (...args) {
    const options = await build.apply(this, args);
    return {
      ...options,
      spawnClaudeCodeProcess: (opts) =>
        spawn(opts.command, opts.args, {
          cwd: opts.cwd,
          env: { ...opts.env, ANTHROPIC_BASE_URL: environment.ANTHROPIC_BASE_URL },
          stdio: ['pipe', 'pipe', 'pipe'],
          signal: opts.signal,
        }),
    };
  };
  try {
    const { createDaemonApp } = await import('../../src/app.ts');
    const { getConfig } = await import('../../src/config.ts');
    const start = async () => {
      daemon = await createDaemonApp({
        config: {
          ...getConfig({ host: '127.0.0.1', port: 0, dbPath, workspaceRoot: run }),
          disableWorktrees: true,
          disableGoalProcessing: true,
        },
        standalone: false,
        verbose: false,
      });
      daemon.settingsManager.updateGlobalSettings({ sandbox: { enabled: false } });
      hub = new MessageHub({ defaultSessionId: 'global' });
      transport = new WebSocketClientTransport({
        url: `ws://127.0.0.1:${daemon.server.port}/ws`,
        autoReconnect: false,
      });
      hub.registerTransport(transport);
      await transport.initialize();
      evidence.port = daemon.server.port;
    };
    const call = (name: string, input: unknown = {}) =>
      hub.request<Record<string, unknown>>('operation.invoke', { name, input });
    await start();
    const params = {
      providerId: 'anthropic',
      displayName: 'Synthetic model',
      kind: 'built_in',
      authType: 'api_key',
      isEnabled: true,
      isDefault: true,
      sortOrder: 0,
    };
    const credentials = { apiKey: 'sk-synthetic-loopback-only' };
    if (kind === 'ordinary' && !daemon!.db.providers.getProviderByProviderId('anthropic'))
      daemon!.db.providers.createProvider({ ...params, kind: 'built_in', authType: 'api_key' });
    const { providers } = await hub!.request<{
      providers: Array<{ id: string; providerId: string }>;
    }>('providers.list', {});
    const existing = providers.find((provider) => provider.providerId === 'anthropic');
    evidence.providerSetup = existing ? 'existing' : 'new';
    if (existing) await hub!.request('providers.update', { id: existing.id, params, credentials });
    else await hub!.request('providers.create', { params, credentials });
    sessionId =
      kind === 'neo'
        ? String((await call('neo.open')).sessionId)
        : (
            await hub!.request<{ sessionId: string }>('session.create', {
              workspacePath: run,
              title: 'Spent admission ordinary control',
              config: { model: 'haiku', provider: 'anthropic' },
            })
          ).sessionId;
    evidence.sessionId = sessionId;
    const original =
      kind === 'neo'
        ? await call('neo.message.send', {
            sessionId,
            requestId,
            content: 'Check the synthetic recovery garden.',
          })
        : await hub!.request<{ messageId: string }>('message.send', {
            sessionId,
            content: 'Check the synthetic recovery garden.',
          });
    const originalId = kind === 'neo' ? requestId : String(original.messageId);
    evidence.firstAccepted = original;
    await waitForReply('Visible synthetic recovery reply 1');
    const live = await daemon!.sessionManager.getSessionForControl(sessionId);
    const settled = Date.now() + 10000;
    while (live?.getProcessingState().status !== 'idle' && Date.now() < settled)
      await new Promise((resolve) => setTimeout(resolve, 100));
    await transport!.close();
    await daemon!.cleanup();
    daemon = undefined;
    const { Database } = await import('../../src/storage/sqlite-compat.ts');
    const seed = new Database(dbPath);
    seed
      .prepare(
        "UPDATE sdk_messages SET send_status = 'enqueued' WHERE session_id = ? AND sdk_uuid = ?"
      )
      .run(sessionId, originalId);
    seed
      .prepare(`UPDATE job_queue SET status = 'pending', run_at = ?, completed_at = NULL,
      payload = json_set(payload, '$.origin', 'recovery', '$.released', json('true'))
      WHERE queue = 'message_delivery' AND json_extract(payload, '$.messageUuid') = ?`)
      .run(Date.now(), originalId);
    const { SDKMessageRepository } = await import(
      '../../src/storage/repositories/sdk-message-repository.ts'
    );
    const { JobQueueRepository } = await import(
      '../../src/storage/repositories/job-queue-repository.ts'
    );
    const messages = new SDKMessageRepository(seed);
    const jobs = new JobQueueRepository(seed);
    const ids: string[] = [];
    for (const marker of markers) {
      const uuid = randomUUID();
      ids.push(uuid);
      messages.saveUserMessage(
        sessionId,
        {
          type: 'user',
          uuid,
          session_id: sessionId,
          parent_tool_use_id: null,
          message: { role: 'user', content: `Check the synthetic recovery garden: ${marker}` },
          inputKind: 'system',
        } as SDKMessage,
        'enqueued'
      );
      jobs.enqueue({
        queue: 'message_delivery',
        payload: {
          sessionId,
          messageUuid: uuid,
          origin: 'space_inject',
          released: true,
          parentToolUseId: null,
        },
        runAt: Date.now(),
        maxRetries: 8,
      });
    }
    seed.close();
    restarted = true;
    await start();
    const rows = () =>
      daemon!.db
        .getDatabase()
        .prepare(
          "SELECT sdk_uuid, send_status FROM sdk_messages WHERE session_id = ? AND message_type = 'user' ORDER BY seq"
        )
        .all(sessionId) as Array<{ sdk_uuid: string; send_status: string }>;
    const sample = () => ({
      at: Date.now(),
      processing: daemon!.db.getSession(sessionId)?.processingState,
      delivery: daemon!.db
        .getDatabase()
        .prepare(
          "SELECT id, status, retry_count, error FROM job_queue WHERE queue = 'message_delivery' AND json_extract(payload, '$.sessionId') = ?"
        )
        .all(sessionId),
      rows: rows(),
      received: [...received],
    });
    const samples: unknown[] = [];
    evidence.samples = samples;
    const until = async (check: () => boolean, label: string, timeout = 20000) => {
      const deadline = Date.now() + timeout;
      while (!check()) {
        samples.push(sample());
        if (Date.now() >= deadline) throw new Error(label);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };
    if (kind === 'neo') {
      await until(
        () => stages.some((event) => event.messageUuid === ids[0] && event.event === 'query_ready'),
        'head never reached query_ready'
      );
      await until(
        () => JSON.parse(daemon!.db.getSession(sessionId)!.processingState!).status === 'idle',
        'session never became idle'
      );
      evidence.interrupt = await hub!.request('client.interrupt', { sessionId });
      evidence.afterInterrupt = rows();
      assert.equal(
        rows().filter((row) => ids.includes(row.sdk_uuid) && row.send_status === 'failed').length,
        0
      );
    }
    if (kind === 'neo' && acceptance === 'deadline') {
      await until(
        () =>
          stages.some(
            (event) =>
              event.event === 'slot_released' &&
              event.messageUuid === ids[0] &&
              event.outcome === 'pending' &&
              Number(event.elapsedMs) >= 2500 &&
              Number(event.elapsedMs) < 6000
          ),
        'spent admission did not release within its existing deadline',
        7000
      );
      evidence.deadlineBounded = true;
      evidence.fullJourney =
        'known red until P0b (#8091): queued markers do not yet reach the model';
    } else {
      await until(
        () => markers.every((marker) => received.has(marker)),
        'queued inputs did not reach the model after restart'
      );
      await until(
        () =>
          rows()
            .filter((row) => ids.includes(row.sdk_uuid))
            .every((row) => row.send_status === 'consumed'),
        'queued inputs were not consumed'
      );
    }
    evidence.afterDelivery = sample();
    evidence.messages = await read();
    evidence.received = [...received];
    evidence.passed = true;
  } finally {
    if (process.env.VERIFY_EVIDENCE_DIR) {
      await mkdir(process.env.VERIFY_EVIDENCE_DIR, { recursive: true });
      await writeFile(
        join(process.env.VERIFY_EVIDENCE_DIR, `spent-admission-${kind}.json`),
        JSON.stringify(evidence, null, 2)
      );
    }
    unsubscribe();
    QueryOptionsBuilder.prototype.build = build;
    await transport?.close();
    await daemon?.cleanup();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
