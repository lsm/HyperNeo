import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageHub, WebSocketClientTransport, type Session } from '@hyperneo/shared';
import type { NeoPublication } from '@hyperneo/shared/types/neo-publication';
import { createScheduleDelivery } from '../../../src/lib/scheduler/session-schedule-delivery.ts';
import { createOperationRegistry } from '../../../src/lib/operations/registry.ts';
import { SessionScheduleRepository } from '../../../src/storage/repositories/session-schedule-repository.ts';
import { NeoAskTodoRepository } from '../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { readNeoPublications } from '../../../../web/src/neo/publication-client.ts';

const sandboxProof = process.env.HYPERNEO_TEST_DISABLE_SANDBOX !== '1';
async function verifyNeoGithubSource(githubSource: 'store' | 'daemon-gh') {
  const isolated = mkdtempSync(join(tmpdir(), 'neo-sdk-publication-'));
  const requestId = randomUUID();
  const githubToken = 'ghp_synthetic_loopback_only_012345678901234567890123456789';
  const root = `neo:${randomUUID()}`;
  const approvalProbeFile = join(isolated, 'approval-probe.txt');
  const readProbeFile = join(isolated, 'read-probe.txt');
  const readCheckout = join(isolated, 'data', 'worktrees', 'lsm', 'synthetic', 'neo-read');
  const workerCheckout = join(isolated, 'data', 'worktrees', 'lsm', 'synthetic', 'worker-id');
  await mkdir(readCheckout, { recursive: true });
  await mkdir(workerCheckout, { recursive: true });
  const readProbe = `synthetic-code-${randomUUID()}`;
  await writeFile(readProbeFile, readProbe);
  const shellHome = join(isolated, 'inherited-shell');
  await mkdir(shellHome);
  await writeFile(join(shellHome, '.zshenv'), 'export GH_TOKEN=synthetic-inherited-owner-token\n');
  const ghBin = join(isolated, 'bin');
  const daemonGhConfig = join(isolated, 'daemon-gh');
  await mkdir(ghBin);
  await mkdir(daemonGhConfig);
  await writeFile(
    join(ghBin, 'gh'),
    `#!/bin/sh
if [ "$*" = 'auth token --hostname github.com' ] && [ "$GH_CONFIG_DIR" = '${daemonGhConfig}' ]; then
  printf '%s' '${githubToken}'
  exit 0
fi
if [ "$GH_TOKEN" != '${githubToken}' ] && [ "$GH_CONFIG_DIR" != '${daemonGhConfig}' ]; then
  printf 'GitHub authentication unavailable\\n' >&2
  exit 1
fi
if [ "$*" != 'pr view https://github.com/lsm/HyperNeo/pull/8148 --json number' ]; then
  printf 'Unexpected synthetic GitHub request\\n' >&2
  exit 1
fi
printf '%s' '{"number":8148,"authenticatedByDaemon":true}'
`,
    { mode: 0o755 }
  );
  let approvalProbeIssued = false;
  let nativeProbeIndex = 0;
  let approvalProbeDenied = false;
  const approvalProbeResults: unknown[] = [];
  const nativeReadProbes = [
    { name: 'Read', input: { file_path: readProbeFile } },
    {
      name: 'Grep',
      input: { pattern: 'synthetic-code-', path: readProbeFile, output_mode: 'content' },
    },
    { name: 'Glob', input: { pattern: 'read-probe.txt', path: isolated } },
    {
      name: 'Bash',
      input: {
        command: sandboxProof
          ? `cat '${readProbeFile}'; if [ -n "$HYPERNEO_HANDOFF_DIR" ]; then printf UNWRITABLE_HANDOFF_ADVERTISED; exit 1; fi; printf CHECKOUT_OK > '${readCheckout}/allowed.txt'; printf TEMP_OK > '${join(tmpdir(), 'hyperneo-neo', root, 'allowed.txt')}'; (printf BAD > '${workerCheckout}/blocked.txt'); (printf BAD > '${isolated}/data/blocked.txt'); (printf BAD > '${isolated}/data/Neo/blocked.txt'); gh pr view https://github.com/lsm/HyperNeo/pull/8148 --json number; printf SYNTHETIC_UNAPPROVED > '${approvalProbeFile}'`
          : `cat '${readProbeFile}'; if [ -n "$HYPERNEO_HANDOFF_DIR" ]; then printf UNWRITABLE_HANDOFF_ADVERTISED; exit 1; fi; gh pr view https://github.com/lsm/HyperNeo/pull/8148 --json number`,
      },
    },
    { name: 'Write', input: { file_path: approvalProbeFile, content: 'NATIVE_WRITE_BYPASS' } },
    {
      name: 'Edit',
      input: { file_path: readProbeFile, old_string: readProbe, new_string: 'NATIVE_EDIT_BYPASS' },
    },
  ];
  const historyMarker = `synthetic-history-${randomUUID()}`;
  const oldCwd = join(isolated, 'data', 'Neo', '.coordinators', 'old-root');
  const newCwd = join(isolated, 'data', 'Neo');
  let sdkSessionId = '';
  const historySeen: boolean[] = [];
  const nativeToolsSeen: string[][] = [];
  const shortText = 'The fictional moon garden is ready.';
  const fullText = '## Fictional garden\n\nThe moon garden has three blue flowers.';
  const calls: string[] = [];
  const receipts: { accepted: boolean; created?: boolean }[] = [];
  const receivedToolCalls = new Set<string>();
  const requests: { path: string; tools: number; active: boolean }[] = [];
  const sent: { system: string; human: unknown }[] = [];
  const nudged: string[] = [];
  const sdkErrors: string[] = [];
  let publicationReady = false;
  let releasePublication = () => {};
  const publicationGate = new Promise<void>((resolve) => {
    releasePublication = resolve;
  });
  let round = 0;
  const fixture = createServer(async (req, res) => {
    if (req.url?.startsWith('/v1/models')) {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          data: [
            {
              id: 'claude-haiku-4-5-20251001',
              type: 'model',
              display_name: 'Fictional Haiku',
              created_at: '2025-10-01T00:00:00Z',
            },
          ],
          has_more: false,
        })
      );
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as {
      stream?: boolean;
      messages?: {
        role?: string;
        content?:
          | string
          | {
              type: string;
              text?: string;
              content?: { text?: string }[];
              tool_use_id?: string;
              is_error?: boolean;
            }[];
      }[];
      tools?: { name: string }[];
      system?: string | { text: string }[];
    };
    if (req.url?.startsWith('/v1/messages/count_tokens')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ input_tokens: 100 }));
      return;
    }
    if (JSON.stringify(body.messages ?? []).includes('had no visible output'))
      nudged.push(req.url ?? '');
    const invoke = body.tools?.find((tool) => tool.name.endsWith('hyperneo-operations__invoke'));
    const active = !!invoke && JSON.stringify(body.messages).includes('fictional moon garden');
    requests.push({ path: req.url ?? '', tools: body.tools?.length ?? 0, active });
    if (active && !sent.length)
      sent.push({
        system:
          typeof body.system === 'string'
            ? body.system
            : (body.system ?? []).map((part) => part.text).join('\n'),
        human: body.messages?.find(
          (message) =>
            message.role === 'user' && JSON.stringify(message).includes('fictional moon garden')
        )?.content,
      });
    if (active) {
      historySeen.push(JSON.stringify(body.messages).includes(historyMarker));
      nativeToolsSeen.push((body.tools ?? []).map((tool) => tool.name));
      for (const message of body.messages ?? []) {
        if (!Array.isArray(message.content)) continue;
        for (const result of message.content) {
          const id = result.tool_use_id;
          if (result.type !== 'tool_result' || !id || receivedToolCalls.has(id)) continue;
          receivedToolCalls.add(id);
          approvalProbeResults.push(result);
          if (result.tool_use_id?.startsWith('tool-read-probe-')) {
            if (result.tool_use_id === 'tool-read-probe-3')
              approvalProbeDenied = result.is_error === true;
            continue;
          }
          if (id.startsWith('tool-fictional-'))
            for (const item of result.content ?? [])
              if (item.text) receipts.push(JSON.parse(item.text));
        }
      }
    }
    const approvalProbe = active && nativeProbeIndex < nativeReadProbes.length;
    if (approvalProbe) approvalProbeIssued = true;
    const publishing = active && !approvalProbe && round < 4;
    if (publishing && round === 0) {
      publicationReady = true;
      await publicationGate;
    }
    const block = approvalProbe
      ? {
          type: 'tool_use',
          id: `tool-read-probe-${nativeProbeIndex}`,
          ...nativeReadProbes[nativeProbeIndex++],
        }
      : publishing
        ? {
            type: 'tool_use',
            id: `tool-fictional-${++round}`,
            name: invoke!.name,
            input: {
              name:
                round <= 2
                  ? 'neo.publication.publish'
                  : round === 3
                    ? 'neo.rule.save'
                    : 'neo.question.ask',
              input:
                round <= 2
                  ? {
                      requestId: 'fictional-send',
                      shortText,
                      fullText,
                      links: [],
                      replyTo: [requestId],
                    }
                  : round === 3
                    ? {
                        messageId: requestId,
                        from: 'Tell me about the fictional moon garden. Keep synthetic garden changes as drafts.',
                        add: ['Keep synthetic garden changes as drafts.'],
                      }
                    : {
                        askId: 'fictional-garden',
                        kind: 'reply',
                        text: 'Which synthetic flower?',
                        replyTo: [requestId],
                      },
            },
          }
        : { type: 'text', text: 'Done.' };
    if (active) calls.push(block.type);
    const message = {
      id: `msg-fictional-${randomUUID()}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-4-5-20251001',
      content: [block],
      stop_reason: approvalProbe || publishing ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 30 },
    };
    if (!body.stream) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(message));
      return;
    }
    res.setHeader('content-type', 'text/event-stream');
    const event = (type: string, data: unknown) =>
      res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    event('message_start', {
      type: 'message_start',
      message: {
        ...message,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 100, output_tokens: 0 },
      },
    });
    event('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block:
        block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' },
    });
    event('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta:
        block.type === 'tool_use'
          ? {
              type: 'input_json_delta',
              partial_json: JSON.stringify('input' in block ? block.input : {}),
            }
          : { type: 'text_delta', text: 'Done.' },
    });
    event('content_block_stop', { type: 'content_block_stop', index: 0 });
    event('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: message.stop_reason, stop_sequence: null },
      usage: { output_tokens: 30 },
    });
    event('message_stop', { type: 'message_stop' });
    res.end();
  });
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const address = fixture.address();
  if (!address || typeof address === 'string') throw new Error('Missing fictional server port');
  const environment = {
    NODE_ENV: 'test',
    HYPERNEO_USE_DEV_PROXY: '0',
    HYPERNEO_DATA_DIR: join(isolated, 'data'),
    HYPERNEO_WORKSPACE_PATH: isolated,
    CLAUDE_CONFIG_DIR: join(isolated, 'sdk'),
    TEST_SDK_SESSION_DIR: join(isolated, 'sdk'),
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
    GLM_API_KEY: '',
    OPENAI_API_KEY: '',
    MINIMAX_API_KEY: '',
    COPILOT_GITHUB_TOKEN: '',
    DEFAULT_MODEL: 'haiku',
    PATH: `${ghBin}:${process.env.PATH}`,
    GH_TOKEN: githubSource === 'store' ? 'synthetic-environment-token' : '',
    GH_CONFIG_DIR: daemonGhConfig,
    HYPERNEO_PROVIDER_CREDENTIAL_KEY: 'synthetic-credential-encryption-key',
    GITHUB_TOKEN: githubSource === 'store' ? 'synthetic-inherited-owner-token' : '',
    GITHUB_ACTIONS: 'true',
    ZDOTDIR: shellHome,
  };
  const prior = new Map(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  let daemon: Awaited<ReturnType<typeof import('../../../src/app.ts').createDaemonApp>> | undefined;
  const hub = new MessageHub({ defaultSessionId: 'global' });
  let transport: WebSocketClientTransport | undefined;
  const { QueryOptionsBuilder } = await import('../../../src/lib/agent/query-options-builder.ts');
  const build = QueryOptionsBuilder.prototype.build;
  QueryOptionsBuilder.prototype.build = async function (...args) {
    const options = await build.apply(this, args);
    return {
      ...options,
      sandbox: sandboxProof ? options.sandbox : { enabled: false },
      stderr: (data) => {
        sdkErrors.push(data);
        options.stderr?.(data);
      },
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
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const { resolveSDKCliPath } = await import('../../../src/lib/agent/sdk-cli-resolver.ts');
    const { getSDKSessionFilePath } = await import('../../../src/lib/sdk-session-file-manager.ts');
    await mkdir(oldCwd, { recursive: true });
    const seedTurn = query({
      prompt: historyMarker,
      options: {
        cwd: oldCwd,
        executable: 'bun',
        pathToClaudeCodeExecutable: resolveSDKCliPath(),
        model: 'claude-haiku-4-5-20251001',
        tools: [],
        settingSources: [],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        env: { ...process.env, ANTHROPIC_API_KEY: 'sk-synthetic-loopback-only' },
      },
    });
    try {
      for await (const event of seedTurn)
        if (event.type === 'result') sdkSessionId = event.session_id;
    } finally {
      seedTurn.close();
    }
    expect(sdkSessionId).not.toBe('');
    expect(existsSync(getSDKSessionFilePath(oldCwd, sdkSessionId))).toBe(true);
    const { Database } = await import('../../../src/storage/database.ts');
    const { createReactiveDatabase } = await import('../../../src/storage/reactive-database.ts');
    const { NeoRepository } = await import('../../../src/storage/repositories/neo-repository.ts');
    const { createTestSession } = await import('../../helpers/database.ts');
    const seed = new Database(join(isolated, 'daemon.db'));
    try {
      await seed.initialize(createReactiveDatabase(seed));
      seed.createSession({
        ...createTestSession(root),
        workspacePath: newCwd,
        sdkSessionId,
        sdkOriginPath: oldCwd,
        config: {
          model: 'claude-haiku-4-5-20251001',
          maxTokens: 8192,
          temperature: 1,
          provider: 'anthropic',
          permissionMode: 'dontAsk',
          settingSources: [],
          systemPrompt: 'You are Neo, the user’s personal context coordinator.',
          sdkToolsPreset: [],
        },
      });
      new NeoRepository(seed.getDatabase()).reserveBinding({
        sessionId: root,
        kind: 'neo',
        projectId: null,
      });
    } finally {
      seed.close();
    }
    const { createDaemonApp } = await import('../../../src/app.ts');
    const { getConfig } = await import('../../../src/config.ts');
    daemon = await createDaemonApp({
      config: {
        ...getConfig({
          host: '127.0.0.1',
          port: 0,
          dbPath: join(isolated, 'daemon.db'),
          workspaceRoot: isolated,
        }),
        disableWorktrees: true,
        disableGoalProcessing: true,
      },
      standalone: false,
      verbose: false,
    });
    daemon.settingsManager.updateGlobalSettings({ sandbox: { enabled: false } });
    transport = new WebSocketClientTransport({
      url: `ws://127.0.0.1:${daemon.server.port}/ws`,
      autoReconnect: false,
    });
    hub.registerTransport(transport);
    await transport.initialize();
    if (githubSource === 'store')
      expect(await hub.request('space.github.setToken', { token: githubToken })).toMatchObject({
        success: true,
      });
    else
      expect(
        execFileSync(
          join(ghBin, 'gh'),
          ['pr', 'view', 'https://github.com/lsm/HyperNeo/pull/8148', '--json', 'number'],
          { env: { GH_CONFIG_DIR: daemonGhConfig }, encoding: 'utf8' }
        )
      ).toContain('8148');
    const { servers } = await hub.request<{ servers: Array<{ id: string }> }>(
      'mcp.registry.list',
      {}
    );
    for (const server of servers)
      await hub.request('mcp.registry.setEnabled', { id: server.id, enabled: false });
    const params = {
      providerId: 'anthropic',
      displayName: 'Synthetic local model',
      kind: 'built_in',
      authType: 'api_key',
      isEnabled: true,
      isDefault: true,
      sortOrder: 0,
    };
    const credentials = { apiKey: 'sk-synthetic-loopback-only' };
    const { providers } = await hub.request<{ providers: { id: string; providerId: string }[] }>(
      'providers.list',
      {}
    );
    const existing = providers.find((provider) => provider.providerId === 'anthropic');
    if (existing) await hub.request('providers.update', { id: existing.id, params, credentials });
    else await hub.request('providers.create', { params, credentials });

    const storedAtStartup = (
      await hub.request<{ session: Session }>('session.get', { sessionId: root })
    ).session;
    const opened = await hub.request<{ ok: boolean; sessionId: string }>('operation.invoke', {
      name: 'neo.open',
      input: {},
    });
    expect(opened.ok).toBe(true);
    expect(opened.sessionId).toBe(root);
    const sandboxOff = await hub.request('session.sandbox.switch', {
      sessionId: root,
      sandboxEnabled: false,
    });
    expect(sandboxOff).toMatchObject({
      success: false,
      sandboxEnabled: true,
      error: expect.stringContaining('Neo requires'),
    });
    await hub.request('session.update', {
      sessionId: root,
      config: {
        ...storedAtStartup.config,
        sdkToolsPreset: ['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit', 'NotebookEdit'],
        allowedTools: [
          'Read',
          'Grep',
          'Glob',
          'Bash',
          'Write',
          'Edit',
          'NotebookEdit',
          'mcp__hyperneo-operations__invoke',
        ],
        permissionMode: 'acceptEdits',
        coordinatorMode: true,
        sandbox: {
          enabled: false,
          allowUnsandboxedCommands: true,
          excludedCommands: ['gh'],
          allowAppleEvents: true,
          enableWeakerNestedSandbox: true,
          ignoreViolations: { file: ['*'] },
        },
      },
    });
    const storedSandboxOverride = daemon.db.getSession(root)?.config.sandbox;
    expect(storedSandboxOverride?.enabled).toBe(false);
    const schedule = new SessionScheduleRepository(daemon.db.getDatabase()).create(
      {
        target: { adapter: 'hyperneo', id: opened.sessionId },
        sourceKind: 'reminder',
        sourceId: 'fictional-wake',
        note: 'Check the synthetic schedule',
        cadence: { kind: 'every', everyMs: 60000 },
        nudgeEvery: 1,
        createdBySession: null,
      },
      Date.now()
    );
    await createScheduleDelivery(daemon.db, () => createOperationRegistry([])).deliver(
      schedule,
      'fictional-wake-message',
      'Check the synthetic schedule'
    );
    const conversation = () =>
      hub.request<{ items: { role: string; wake?: { scheduleId: string; sourceId: string } }[] }>(
        'operation.invoke',
        { name: 'neo.conversation.read', input: { conversationId: opened.sessionId.slice(4) } }
      );
    let history = await conversation();
    const wakeDeadline = Date.now() + 15000;
    while (!history.items.some((item) => item.role === 'wake') && Date.now() < wakeDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      history = await conversation();
    }
    expect(history.items).toEqual([
      expect.objectContaining({
        role: 'wake',
        wake: expect.objectContaining({ scheduleId: schedule.id, sourceId: 'fictional-wake' }),
      }),
    ]);
    expect(
      daemon.db.getDatabase().prepare('SELECT COUNT(*) AS count FROM neo_input_origins').get()
    ).toEqual({ count: 0 });
    const wakeConsumed = () =>
      Boolean(daemon!.db.getMessageByStatusAndUuid(root, 'consumed', 'fictional-wake-message'));
    let wakeSession = (await hub.request<{ session: Session }>('session.get', { sessionId: root }))
      .session;
    const wakeIdleDeadline = Date.now() + 15000;
    while (
      (!wakeConsumed() || JSON.parse(wakeSession.processingState ?? '{}').status !== 'idle') &&
      Date.now() < wakeIdleDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      wakeSession = (await hub.request<{ session: Session }>('session.get', { sessionId: root }))
        .session;
    }
    expect(wakeConsumed()).toBe(true);
    expect(JSON.parse(wakeSession.processingState ?? '{}')).toMatchObject({ status: 'idle' });
    const todos = new NeoAskTodoRepository(daemon.db.getDatabase());
    todos.openAsk({
      id: 'fictional-garden',
      projectId: null,
      sessionId: opened.sessionId,
      originMessageId: null,
      title: 'Garden',
      request: 'Compare fictional flowers',
      createdAt: 1,
    });
    const accepted = await hub.request<{ ok: boolean; messageId: string }>('operation.invoke', {
      name: 'neo.message.send',
      input: {
        sessionId: opened.sessionId,
        requestId,
        content:
          'Tell me about the fictional moon garden. Keep synthetic garden changes as drafts.',
      },
    });
    expect(accepted).toMatchObject({ ok: true, messageId: requestId });
    const statusPage = () =>
      hub.request<{ items: { requestId: string; messageStatus?: string }[] }>('operation.invoke', {
        name: 'neo.conversation.asks.read',
        input: { conversationId: opened.sessionId.slice(4) },
      });
    const workingDeadline = Date.now() + 15000;
    while (!publicationReady && Date.now() < workingDeadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
    expect(publicationReady).toBe(true);
    const workingStatus = await statusPage();
    expect(
      workingStatus.items,
      JSON.stringify({ requestId, processing: daemon.db.getSession(root)?.processingState })
    ).toEqual([expect.objectContaining({ requestId, messageStatus: 'working' })]);
    releasePublication();
    const read = () =>
      hub.request<{ ok: boolean; items: NeoPublication[] }>('operation.invoke', {
        name: 'neo.publication.read',
        input: { conversationId: opened.sessionId.slice(4) },
      });
    let page = await read();
    const deadline = Date.now() + 45000;
    while (
      !page.items?.some((item: NeoPublication) => item.shortText === shortText) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      page = await read();
    }
    expect(page.ok).toBe(true);
    expect(page.items, JSON.stringify({ calls, receipts, requests, sdkErrors })).toHaveLength(1);
    expect(page.items[0].askOrigin).toBeUndefined();
    expect(page.items[0].producerInput).toBeUndefined();
    expect(page.items[0]).toMatchObject({
      publicationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      shortText,
      fullText,
      links: [],
      replyTo: [requestId],
    });
    const end = Date.now() + 15000;
    while (calls.length < nativeReadProbes.length + 5 && Date.now() < end)
      await new Promise((resolve) => setTimeout(resolve, 100));
    expect(calls).toEqual([...Array(nativeReadProbes.length + 4).fill('tool_use'), 'text']);
    expect(receipts).toMatchObject([
      {
        accepted: true,
        created: true,
        publication: { publicationId: page.items[0].publicationId },
      },
      {
        accepted: true,
        created: false,
        publication: { publicationId: page.items[0].publicationId },
      },
      { ok: true, standingRules: ['Keep synthetic garden changes as drafts.'] },
      { ok: true, question: { replyTo: [requestId] } },
    ]);
    expect(daemon.db.getGlobalSettings().neo?.standingRules).toEqual([
      'Keep synthetic garden changes as drafts.',
    ]);
    expect(todos.listQuestions('fictional-garden')).toEqual([
      expect.objectContaining({ replyTo: [requestId] }),
    ]);
    const question = todos.listQuestions('fictional-garden')[0];
    expect(
      await hub.request('operation.invoke', {
        name: 'neo.question.get',
        input: { questionId: question.id },
      })
    ).toMatchObject({ ok: true, question: { replyTo: [requestId] } });
    expect((await read()).items).toEqual(page.items);
    const messageStatuses = await hub.request<{
      items: { requestId: string; messageStatus?: string }[];
    }>('operation.invoke', {
      name: 'neo.conversation.asks.read',
      input: { conversationId: opened.sessionId.slice(4) },
    });
    expect(messageStatuses.items).toEqual([
      expect.objectContaining({ requestId, messageStatus: 'answered' }),
    ]);
    expect((await conversation()).items).toContainEqual(
      expect.objectContaining({
        role: 'human',
        ask: expect.objectContaining({ requestId, messageStatus: 'answered' }),
      })
    );
    const webRead = await readNeoPublications(
      { conversationId: opened.sessionId.slice(4), after: 0 },
      async () => hub,
      () => true
    );
    expect(webRead).toEqual({ state: 'ready', items: page.items, nextAfter: 1 });
    const unansweredId = randomUUID();
    expect(
      await hub.request('operation.invoke', {
        name: 'neo.message.send',
        input: {
          sessionId: opened.sessionId,
          requestId: unansweredId,
          content: 'Read this synthetic follow-up without publishing.',
        },
      })
    ).toMatchObject({ ok: true, messageId: unansweredId });
    let unansweredStatus = await statusPage();
    const readDeadline = Date.now() + 15000;
    while (
      unansweredStatus.items.find((item) => item.requestId === unansweredId)?.messageStatus !==
        'read' &&
      Date.now() < readDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      unansweredStatus = await statusPage();
    }
    expect(unansweredStatus.items).toEqual([
      expect.objectContaining({ requestId, messageStatus: 'answered' }),
      expect.objectContaining({ requestId: unansweredId, messageStatus: 'read' }),
    ]);
    expect((await read()).items).toEqual(page.items);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(nudged, 'ending with Done. keeps the CLI from nudging for visible output').toEqual([]);
    const { neoPrompt } = await import('../../../src/lib/neo/prompt.ts');
    if (process.env.VERIFY_EVIDENCE_DIR) {
      await mkdir(process.env.VERIFY_EVIDENCE_DIR, { recursive: true });
      await writeFile(
        join(
          process.env.VERIFY_EVIDENCE_DIR,
          githubSource === 'store' ? 'neo-goal-cycle-sdk.json' : 'neo-goal-cycle-sdk-daemon-gh.json'
        ),
        JSON.stringify(
          {
            approvalProbeResults,
            githubSource,
            sandboxProof,
            sandboxOff,
            storedSandboxOverride,
            approvalProbeDenied,
            approvalProbeCreatedFile: existsSync(approvalProbeFile),
            tempWriteAllowed: existsSync(join(tmpdir(), 'hyperneo-neo', root, 'allowed.txt')),
            checkoutWriteAllowed: existsSync(join(readCheckout, 'allowed.txt')),
            protectedWritesDenied: [workerCheckout, join(isolated, 'data'), newCwd].every(
              (path) => !existsSync(join(path, 'blocked.txt'))
            ),
            sdkSessionId,
            historyMarker,
            oldCwd,
            newCwd,
            historySeen,
            nativeToolsSeen,
            storedAtStartup: {
              sdkSessionId: storedAtStartup.sdkSessionId,
              config: storedAtStartup.config,
            },
            afterResume: {
              sdkSessionId: daemon.db.getSession(root)?.sdkSessionId,
              sdkOriginPath: daemon.db.getSession(root)?.sdkOriginPath,
            },
            transcriptAtNewCwd: existsSync(getSDKSessionFilePath(newCwd, sdkSessionId)),
            sent,
            calls,
            receipts,
            publication: page.items[0],
            question,
            messageStatuses,
            workingStatus,
            unansweredStatus,
            wakeHistory: history,
            webRead,
            daemonPort: daemon.server.port,
            mockPort: address.port,
          },
          null,
          2
        )
      );
    }
    expect(approvalProbeIssued).toBe(true);
    expect(JSON.stringify(approvalProbeResults)).toContain(readProbe);
    expect(JSON.stringify(approvalProbeResults)).not.toContain(
      'Permission to use Bash has been denied'
    );
    for (const index of [0, 1, 2]) {
      const result = (approvalProbeResults as { tool_use_id: string; is_error?: boolean }[]).find(
        (result) => result.tool_use_id === `tool-read-probe-${index}`
      );
      expect(result).toBeDefined();
      expect(result?.is_error).not.toBe(true);
    }
    expect(JSON.stringify(approvalProbeResults)).not.toContain('UNWRITABLE_HANDOFF_ADVERTISED');
    expect(JSON.stringify(approvalProbeResults)).toContain('authenticatedByDaemon');
    expect(JSON.stringify(approvalProbeResults)).toContain('8148');
    expect(JSON.stringify(approvalProbeResults)).not.toContain('GitHub authentication unavailable');
    expect(JSON.stringify(storedAtStartup.config)).not.toContain(githubToken);
    if (sandboxProof) {
      expect(JSON.stringify(approvalProbeResults)).toMatch(/operation not permitted/i);
      expect(existsSync(join(readCheckout, 'allowed.txt'))).toBe(true);
      expect(existsSync(join(tmpdir(), 'hyperneo-neo', root, 'allowed.txt'))).toBe(true);
      for (const path of [workerCheckout, join(isolated, 'data'), newCwd])
        expect(existsSync(join(path, 'blocked.txt'))).toBe(false);
    }
    for (const index of [4, 5]) {
      const result = (approvalProbeResults as { tool_use_id: string; is_error?: boolean }[]).find(
        (result) => result.tool_use_id === `tool-read-probe-${index}`
      );
      expect(result?.is_error).toBe(true);
    }
    expect(readFileSync(readProbeFile, 'utf8')).toBe(readProbe);
    expect(nativeToolsSeen[0]).not.toEqual(expect.arrayContaining(['Write']));
    expect(nativeToolsSeen[0]).not.toEqual(expect.arrayContaining(['Edit']));
    expect(approvalProbeDenied).toBe(sandboxProof);
    expect(existsSync(approvalProbeFile)).toBe(false);
    expect(storedAtStartup.config.systemPrompt).toBe(neoPrompt());
    expect(storedAtStartup.config.sdkToolsPreset).toContain('Read');
    expect(storedAtStartup.config.sdkToolsPreset).toContain('Bash');
    expect(storedAtStartup.config.sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
    });
    expect(nativeToolsSeen[0]).toEqual(expect.arrayContaining(['Read', 'Bash']));
    expect(historySeen.length).toBeGreaterThan(0);
    expect(historySeen.every(Boolean)).toBe(true);
    expect(daemon.db.getSession(root)?.sdkSessionId).toBe(sdkSessionId);
    expect(daemon.db.getSession(root)?.sdkOriginPath).toBe(newCwd);
    expect(existsSync(getSDKSessionFilePath(newCwd, sdkSessionId))).toBe(true);
    expect(sent[0].system).toContain(neoPrompt());
    expect(sent[0].system).not.toContain('On a scheduled goal wake, use its goalId');
    for (const instruction of [
      'neo.home.init',
      'neo.home.save',
      'goal.session.create',
      '900000',
      'nudgeEvery',
      'answeredByHuman',
    ])
      expect(sent[0].system).toContain(instruction);
    const human = (sent[0].human as { type: string; text?: string }[]).filter(
      (part) => part.type === 'text'
    );
    expect(human.map((part) => part.text).slice(-2)).toEqual([
      expect.stringMatching(/^\(local time: \w{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2} \S+\)$/),
      'Tell me about the fictional moon garden. Keep synthetic garden changes as drafts.',
    ]);
    expect(human.map((part) => part.text).join('\n')).not.toContain('<human-input>');
    expect(human.map((part) => part.text)).toContain(`[message id: ${requestId}]`);
  } finally {
    releasePublication();
    QueryOptionsBuilder.prototype.build = build;
    await transport?.close();
    await daemon?.cleanup();
    await rm(join(tmpdir(), 'hyperneo-neo', root), { recursive: true, force: true });
    await new Promise<void>((resolve, reject) =>
      fixture.close((cause) => (cause ? reject(cause) : resolve()))
    );
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test.each(['store', 'daemon-gh'] as const)(
  `root startup, reads, resume and publication: %s (${sandboxProof ? 'real OS sandbox proof' : 'transport fixture, sandbox disabled'})`,
  verifyNeoGithubSource,
  90000
);
