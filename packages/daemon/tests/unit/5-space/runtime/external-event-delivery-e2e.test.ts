/**
 * End-to-end reliability suite for external-event delivery.
 *
 * Unlike the layer-specific tests (github-event-extension.test.ts exercises
 * ingestion → bus; space-runtime-external-events.test.ts exercises
 * hand-crafted events → delivery), this suite wires the full chain:
 *
 *   GitHub webhook / polling (real GitHubEventExtension, fake fetch)
 *   → ExternalEventService / ExternalEventStore (dedupe, delivery rows)
 *   → internal event bus
 *   → SpaceRuntimeService / SpaceRuntime (gate wake, subscription matching)
 *   → worker session injection (captured agent.message.inject)
 *
 * Scenarios (from the reliability batch #2154-#2240):
 *   1. blocked run wakes exactly once from a PR review webhook
 *   2. check_run failure webhook delivered to the PR worker
 *   3. polling fallback delivers PR comments without webhooks
 *   4. /pulls backlog pressure does not starve check_run polling
 *   5. genuine /pulls backlog defers check_run polling without dropping it
 *   6. inactive-worker queuing + activation flush
 *   7. idle-subscriber delivery in defer mode
 *   8. duplicate /pulls metadata (same head sha) does not re-trigger workers
 *   9. PR events linked to a run are retained, not terminally dropped
 *
 * The DB runs the real migrations so the extension repository, event store,
 * and space repositories all see the production schema.
 */

import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { SpaceWorkflow } from '@hyperneo/shared';
import { ExternalEventService } from '../../../../src/lib/external-events/external-event-service';
import { ExternalEventStore } from '../../../../src/lib/external-events/external-event-store';
import { GitHubEventExtension } from '../../../../src/lib/external-events/github';
import type { GitHubWatchedRepo } from '../../../../src/lib/external-events/github/github-repository';
import type {
  ExternalEventExtensionConfigStore,
  SpaceExternalEventSourceConfig,
} from '../../../../src/lib/external-events/types';
import { createInternalCommandBus } from '../../../../src/lib/internal-command-bus';
import { createDaemonInternalEventBus } from '../../../../src/lib/internal-event-bus';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager';
import type { SpaceRuntime } from '../../../../src/lib/space/runtime/space-runtime';
import { SpaceRuntimeService } from '../../../../src/lib/space/runtime/space-runtime-service';
import type { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager';
import { ChannelCycleRepository } from '../../../../src/storage/repositories/channel-cycle-repository';
import { GateDataRepository } from '../../../../src/storage/repositories/gate-data-repository';
import { GateOpenStateRepository } from '../../../../src/storage/repositories/gate-open-state-repository';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository';
import { createTables, runMigrations } from '../../../../src/storage/schema';

setDefaultTimeout(15_000);

const SPACE_ID = 'space-ext-e2e';
const AGENT_ID = 'agent-ext-e2e';
const OWNER = 'acme';
const REPO = 'widgets';
const PR_NUMBER = 7;
const PR_URL = `https://github.com/${OWNER}/${REPO}/pull/${PR_NUMBER}`;
const WEBHOOK_SECRET = 'e2e-secret';

const REVIEW_TOPIC = `github/${OWNER}/${REPO}/pull_request/${PR_NUMBER}.review_submitted`;
const CHECK_FAILED_TOPIC = `github/${OWNER}/${REPO}/pull_request/${PR_NUMBER}.check_failed`;
const COMMENT_POLLED_TOPIC = `github/${OWNER}/${REPO}/pull_request/${PR_NUMBER}.comment_polled`;
const PR_POLLED_TOPIC = `github/${OWNER}/${REPO}/pull_request/${PR_NUMBER}.polled`;

// ---------------------------------------------------------------------------
// GitHub payload / fetch fakes
// ---------------------------------------------------------------------------

const baseRepoPayload = {
  id: 1,
  name: REPO,
  full_name: `${OWNER}/${REPO}`,
  owner: { login: OWNER },
};

function reviewWebhookPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'submitted',
    repository: baseRepoPayload,
    sender: { login: 'codex[bot]', type: 'Bot' },
    review: {
      id: 9001,
      state: 'approved',
      body: 'LGTM',
      html_url: `${PR_URL}#pullrequestreview-9001`,
      submitted_at: '2026-07-21T00:00:00Z',
      user: { login: 'codex[bot]', type: 'Bot' },
    },
    pull_request: {
      id: 70,
      number: PR_NUMBER,
      html_url: PR_URL,
      user: { login: 'dev', type: 'User' },
    },
    ...overrides,
  };
}

function checkRunWebhookPayload(conclusion: string): Record<string, unknown> {
  return {
    action: 'completed',
    repository: baseRepoPayload,
    sender: { login: 'github-actions[bot]', type: 'Bot' },
    check_run: {
      id: 987,
      name: 'daemon unit tests',
      status: 'completed',
      conclusion,
      html_url: `https://github.com/${OWNER}/${REPO}/runs/987`,
      completed_at: '2026-07-21T00:00:00Z',
      pull_requests: [{ number: PR_NUMBER }],
    },
  };
}

function reviewCommentWebhookPayload(): Record<string, unknown> {
  return {
    action: 'created',
    repository: baseRepoPayload,
    sender: { login: 'codex[bot]', type: 'Bot' },
    pull_request: {
      id: 70,
      number: PR_NUMBER,
      html_url: PR_URL,
      user: { login: 'dev', type: 'User' },
    },
    comment: {
      id: 601,
      body: 'please fix this',
      html_url: `${PR_URL}#discussion_r601`,
      user: { login: 'codex[bot]', type: 'Bot' },
      created_at: '2026-07-21T00:00:00Z',
      updated_at: '2026-07-21T00:00:00Z',
    },
  };
}

function pullRequestRow(
  number: number,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: number * 10,
    number,
    state: 'open',
    title: `PR ${number}`,
    body: `Body ${number}`,
    html_url: `https://github.com/${OWNER}/${REPO}/pull/${number}`,
    head: { sha: 'abc123' },
    user: { login: 'dev', type: 'User' },
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
    ...overrides,
  };
}

function issueCommentRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 501,
    body: 'looks good',
    html_url: `${PR_URL}#issuecomment-501`,
    issue_url: `https://api.github.com/repos/${OWNER}/${REPO}/issues/${PR_NUMBER}`,
    user: { login: 'codex[bot]', type: 'Bot' },
    created_at: '2026-07-21T00:00:00Z',
    updated_at: '2026-07-21T00:00:00Z',
    ...overrides,
  };
}

function checkRunRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 7001,
    name: 'unit tests',
    status: 'completed',
    conclusion: 'failure',
    head_sha: 'abc123',
    html_url: `https://github.com/${OWNER}/${REPO}/actions/runs/1/job/7001`,
    completed_at: '2099-01-03T00:00:00Z',
    pull_requests: [{ number: PR_NUMBER }],
    app: { login: 'github-actions', type: 'Bot' },
    ...overrides,
  };
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'X-RateLimit-Remaining': '5000', ...headers },
  });
}

interface FakeGitHubApi {
  fetchImpl: typeof fetch;
  requests: string[];
  setRoute(match: string, responder: (url: string) => Response): void;
}

/**
 * URL-substring routed fake for the GitHub REST API. Routes are matched in
 * insertion order, so register more specific paths (e.g. /pulls/comments)
 * before their prefixes (e.g. /pulls).
 */
function makeFakeGitHubApi(routes: Array<[string, unknown]>): FakeGitHubApi {
  const requests: string[] = [];
  const table: Array<[string, (url: string) => Response]> = routes.map(
    ([match, body]) =>
      [match, typeof body === 'function' ? (body as never) : () => jsonResponse(body)] as [
        string,
        (url: string) => Response,
      ]
  );
  const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    requests.push(url);
    for (const [match, responder] of table) {
      if (url.includes(match)) return responder(url);
    }
    throw new Error(`fake GitHub API: no route for ${url}`);
  }) as typeof fetch;
  return {
    fetchImpl,
    requests,
    setRoute(match, responder) {
      const index = table.findIndex(([existing]) => existing === match);
      if (index >= 0) table[index] = [match, responder];
      else table.push([match, responder]);
    },
  };
}

async function createSignature(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const buffer = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(payload));
  return `sha256=${Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')}`;
}

// ---------------------------------------------------------------------------
// Config store + TaskAgentManager fakes
// ---------------------------------------------------------------------------

class StaticConfigStore implements ExternalEventExtensionConfigStore {
  async getGlobalConfig(source: string) {
    return {
      source,
      globallyEnabled: true,
      capabilities: { webhooks: true, polling: true, rpcConfig: true },
      settings: {},
    };
  }
  async getSpaceConfig(
    spaceId: string,
    source: string
  ): Promise<SpaceExternalEventSourceConfig | null> {
    return { spaceId, source, enabled: true, settings: {} };
  }
  async listEnabledSpaces(): Promise<SpaceExternalEventSourceConfig[]> {
    return [];
  }
  async setGlobalConfig(): Promise<void> {}
  async setSpaceConfig(): Promise<void> {}
}

class MockTaskAgentManager {
  alive = new Set<string>();
  spawned: string[] = [];
  recoveryMessages: Array<{ sessionId: string; message: string }> = [];
  activationResult: Array<{ agentName: string; sessionId: string }> = [];

  isSessionAlive(sessionId: string): boolean {
    return this.alive.has(sessionId);
  }
  getAgentSessionById(_sessionId: string): null {
    return null;
  }
  async rehydrate(): Promise<void> {}
  isExecutionSpawning(_executionId: string): boolean {
    return false;
  }
  async tryResumeNodeAgentSession(): Promise<void> {}
  cancelBySessionId(sessionId: string): void {
    this.alive.delete(sessionId);
  }
  async prepareSubSessionForWorkflowResume(): Promise<boolean> {
    return true;
  }
  async flushPendingMessagesForTarget(): Promise<void> {}
  async injectRuntimeRecoveryMessage(subSessionId: string, message: string): Promise<string> {
    this.recoveryMessages.push({ sessionId: subSessionId, message });
    return 'ok';
  }
  async activateTargetSessionsForMessage(): Promise<
    Array<{ agentName: string; sessionId: string }>
  > {
    for (const result of this.activationResult) {
      this.alive.add(result.sessionId);
    }
    return this.activationResult;
  }
  async spawnWorkflowNodeAgentForExecution(
    _task: unknown,
    _space: unknown,
    _workflow: unknown,
    _run: unknown,
    execution: { id: string }
  ): Promise<string> {
    const sessionId = `session-${execution.id}`;
    this.spawned.push(sessionId);
    this.alive.add(sessionId);
    return sessionId;
  }
}

// ---------------------------------------------------------------------------
// Suite wiring
// ---------------------------------------------------------------------------

interface InjectedMessage {
  sessionId: string;
  message: string;
  deliveryMode?: string;
}

interface E2EContext {
  db: Database;
  service: SpaceRuntimeService;
  runtime: SpaceRuntime;
  extension: GitHubEventExtension;
  eventStore: ExternalEventStore;
  workflowRunRepo: SpaceWorkflowRunRepository;
  taskRepo: SpaceTaskRepository;
  nodeExecutionRepo: NodeExecutionRepository;
  gateDataRepo: GateDataRepository;
  gateOpenStateRepo: GateOpenStateRepository;
  workflowManager: SpaceWorkflowManager;
  tam: MockTaskAgentManager;
  injected: InjectedMessage[];
  services: Array<{ stop(): Promise<void> }>;
}

const approvedField = {
  name: 'approved',
  type: 'boolean',
  writers: [],
  check: { op: '==', value: true },
} as const;

const prUrlField = {
  name: 'pr_url',
  type: 'string',
  writers: ['coder'],
  check: { op: 'exists' },
} as const;

async function setupE2E(): Promise<E2EContext> {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  createTables(db);
  runMigrations(db, () => {});
  const now = Date.now();
  db.prepare(
    `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)`
  ).run(SPACE_ID, SPACE_ID, '/tmp/ext-e2e', 'External Event E2E', now, now);
  db.prepare(
    `INSERT INTO space_agents (id, space_id, name, description, tools, system_prompt, created_at, updated_at)
		 VALUES (?, ?, ?, '', '[]', '', ?, ?)`
  ).run(AGENT_ID, SPACE_ID, 'Coder', now, now);

  const taskRepo = new SpaceTaskRepository(db);
  const nodeExecutionRepo = new NodeExecutionRepository(db);
  const gateDataRepo = new GateDataRepository(db);
  const gateOpenStateRepo = new GateOpenStateRepository(db);
  const workflowRunRepo = new SpaceWorkflowRunRepository(db, gateOpenStateRepo);
  const channelCycleRepo = new ChannelCycleRepository(db);
  const workflowManager = new SpaceWorkflowManager(new SpaceWorkflowRepository(db));
  const bus = createDaemonInternalEventBus();
  const commandBus = createInternalCommandBus();
  const eventStore = new ExternalEventStore(db);
  const eventService = new ExternalEventService(eventStore, bus);
  const injected: InjectedMessage[] = [];
  commandBus.register('agent.message.inject', async (command) => {
    injected.push({
      sessionId: command.sessionId,
      message: command.message,
      deliveryMode: command.deliveryMode,
    });
    return { ok: true };
  });

  const tam = new MockTaskAgentManager();
  const service = new SpaceRuntimeService({
    db,
    spaceManager: new SpaceManager(db),
    spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
    spaceWorkflowManager: workflowManager,
    workflowRunRepo,
    taskRepo,
    nodeExecutionRepo,
    tickIntervalMs: 60_000,
    gateDataRepo,
    gateOpenStateRepo,
    channelCycleRepo,
    internalEventBus: bus,
    commandBus,
    externalEventStore: eventStore,
  });
  service.setTaskAgentManager(tam as unknown as TaskAgentManager);

  // pollIntervalMs: 0 disables the self-scheduled poll timer; tests drive
  // pollWatchedRepo directly with a fake fetch.
  const extension = new GitHubEventExtension(db, 'test-token', { pollIntervalMs: 0 });
  await extension.start({
    publisher: eventService,
    config: new StaticConfigStore(),
    onSourceConfigChanged() {},
  });

  workflowManager.createWorkflow({
    spaceId: SPACE_ID,
    name: `E2E Workflow ${Math.random()}`,
    description: '',
    nodes: [
      { id: 'code', name: 'Code', agents: [{ agentId: AGENT_ID, name: 'coder' }] },
      { id: 'review', name: 'Review', agents: [{ agentId: AGENT_ID, name: 'reviewer' }] },
    ],
    transitions: [],
    startNodeId: 'code',
    rules: [],
    tags: [],
    gates: [{ id: 'approval', fields: [approvedField, prUrlField] }] as SpaceWorkflow['gates'],
    channels: [
      { id: 'ch-code-to-review', from: 'coder', to: 'reviewer', gateId: 'approval' },
    ] as SpaceWorkflow['channels'],
  });

  const runtime = await service.createOrGetRuntime(SPACE_ID);
  // runtime.start() fires the first executeTick without awaiting it, and a
  // concurrent executeTick() call no-ops on tickInFlight. Wait for that first
  // tick to fully finish so test bodies run with no tick in flight (the
  // interval is 60s, so no further tick fires spontaneously). Without this,
  // the tick's PR auto-subscription sweep can race test seeding.
  const tickState = runtime as unknown as { tickInFlight: boolean; rehydrated: boolean };
  for (let i = 0; i < 400 && (!tickState.rehydrated || tickState.tickInFlight); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  // Idempotent fallback: completes rehydration synchronously if the
  // fire-and-forget tick somehow never ran, and flips
  // acceptingExternalEvents so the terminal drop/ignore paths behave like a
  // booted daemon.
  await runtime.executeTick();

  return {
    db,
    service,
    runtime,
    extension,
    eventStore,
    workflowRunRepo,
    taskRepo,
    nodeExecutionRepo,
    gateDataRepo,
    gateOpenStateRepo,
    workflowManager,
    tam,
    injected,
    services: [service, extension],
  };
}

function injectedTopics(ctx: E2EContext): string[] {
  return ctx.injected.map((item) => JSON.parse(item.message).topic as string);
}

async function sendWebhook(
  ctx: E2EContext,
  eventType: string,
  payload: unknown,
  deliveryId: string
): Promise<Response> {
  const raw = JSON.stringify(payload);
  const signature = await createSignature(raw, WEBHOOK_SECRET);
  return ctx.extension.routes[0].handle(
    new Request('http://localhost/webhook/github/space', {
      method: 'POST',
      headers: {
        'X-GitHub-Event': eventType,
        'X-GitHub-Delivery': deliveryId,
        'X-Hub-Signature-256': signature,
      },
      body: raw,
    })
  );
}

function watchRepo(ctx: E2EContext, options: { polling?: boolean } = {}): GitHubWatchedRepo {
  return ctx.extension.repo.upsertWatchedRepo({
    spaceId: SPACE_ID,
    owner: OWNER,
    repo: REPO,
    webhookSecret: WEBHOOK_SECRET,
    pollingEnabled: options.polling ?? false,
  });
}

function reloadWatchedRepo(ctx: E2EContext, id: string): GitHubWatchedRepo {
  return ctx.extension.repo.getWatchedRepoById(id)!;
}

function workflowId(ctx: E2EContext): string {
  return ctx.workflowManager.listWorkflows(SPACE_ID)[0]!.id;
}

/** Active run: coder execution in_progress with a live session and a PR auto-sub. */
async function seedActiveRunWithPr(
  ctx: E2EContext
): Promise<{ runId: string; taskId: string; coderSessionId: string }> {
  const { run, tasks } = await ctx.runtime.startWorkflowRun(SPACE_ID, workflowId(ctx), 'Run');
  const execution = ctx.nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
  const coderSessionId = `session-coder-${run.id}`;
  ctx.nodeExecutionRepo.update(execution.id, {
    status: 'in_progress',
    agentSessionId: coderSessionId,
    startedAt: Date.now(),
  });
  ctx.tam.alive.add(coderSessionId);
  ctx.gateDataRepo.merge(run.id, 'approval', { pr_url: PR_URL });
  // The production gate-write path: registers the PR auto-subscription for the
  // in_progress run (with replay of retained events).
  await ctx.service.notifyGateDataChanged(run.id, 'approval');
  return { runId: run.id, taskId: tasks[0]!.id, coderSessionId };
}

/** Blocked run awaiting the approval gate, PR URL resolvable from gate data. */
async function seedBlockedRunWithPr(
  ctx: E2EContext
): Promise<{ runId: string; coderSessionId: string }> {
  const { runId, coderSessionId } = await seedActiveRunWithPr(ctx);
  ctx.workflowRunRepo.updateRun(runId, { status: 'blocked', failureReason: 'agentCrash' });
  // Still blocked: the gate-write path keeps the auto-subscription registered
  // so an external event can re-evaluate the gate.
  await ctx.service.notifyGateDataChanged(runId, 'approval');
  return { runId, coderSessionId };
}

// ---------------------------------------------------------------------------
// 1. Webhook-driven blocked run recovery
// ---------------------------------------------------------------------------

describe('external event delivery e2e', () => {
  let ctx: E2EContext;

  afterEach(async () => {
    for (const service of ctx.services) {
      await service.stop();
    }
  });

  test('blocked run wakes exactly once from a PR review webhook; duplicate delivery is a no-op', async () => {
    ctx = await setupE2E();
    watchRepo(ctx);
    const { runId, coderSessionId } = await seedBlockedRunWithPr(ctx);
    // Pre-satisfy the gate data (as a reviewer handoff would) without firing
    // gate evaluation — the webhook must be what wakes the run.
    ctx.gateDataRepo.merge(runId, 'approval', { approved: true, approvedAt: Date.now() });

    const response = await sendWebhook(
      ctx,
      'pull_request_review',
      reviewWebhookPayload(),
      'delivery-review-1'
    );
    expect(response.status).toBe(200);
    // The blocked-run hook chain is fire-and-forget; let it drain.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(ctx.workflowRunRepo.getRun(runId)?.status).toBe('in_progress');
    expect(ctx.gateOpenStateRepo.isOpen(runId, 'approval').open).toBe(true);
    expect(ctx.tam.recoveryMessages).toHaveLength(1);
    expect(ctx.tam.recoveryMessages[0]!.sessionId).toBe(coderSessionId);
    expect(injectedTopics(ctx)).toEqual([REVIEW_TOPIC]);
    const stored = ctx.db
      .prepare(`SELECT id, state FROM space_external_events WHERE space_id = ?`)
      .all(SPACE_ID) as Array<{ id: string; state: string }>;
    expect(stored).toHaveLength(1);
    expect(stored[0]!.state).toBe('delivered');

    // GitHub retries the same delivery (same X-GitHub-Delivery → same
    // dedupeKey): the store short-circuits the terminal duplicate, so the
    // run must not be woken a second time.
    const duplicate = await sendWebhook(
      ctx,
      'pull_request_review',
      reviewWebhookPayload(),
      'delivery-review-1'
    );
    expect(duplicate.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(ctx.workflowRunRepo.getRun(runId)?.status).toBe('in_progress');
    expect(ctx.tam.recoveryMessages).toHaveLength(1);
    expect(injectedTopics(ctx)).toEqual([REVIEW_TOPIC]);
    expect(ctx.db.prepare(`SELECT COUNT(*) AS c FROM space_external_events`).get()).toEqual({
      c: 1,
    });
  });

  test('check_run failure webhook is delivered to the PR worker; success conclusions are dropped', async () => {
    ctx = await setupE2E();
    watchRepo(ctx);
    const { coderSessionId } = await seedActiveRunWithPr(ctx);

    const success = await sendWebhook(
      ctx,
      'check_run',
      checkRunWebhookPayload('success'),
      'delivery-check-success'
    );
    expect(success.status).toBe(202);
    expect(ctx.injected).toHaveLength(0);

    const failure = await sendWebhook(
      ctx,
      'check_run',
      checkRunWebhookPayload('failure'),
      'delivery-check-failure'
    );
    expect(failure.status).toBe(200);

    expect(ctx.injected).toHaveLength(1);
    expect(ctx.injected[0]!.sessionId).toBe(coderSessionId);
    expect(ctx.injected[0]!.deliveryMode).toBe('immediate');
    const essence = JSON.parse(ctx.injected[0]!.message);
    expect(essence.topic).toBe(CHECK_FAILED_TOPIC);
    expect(ctx.eventStore.getById(essence.eventId)?.state).toBe('delivered');
  });

  // -------------------------------------------------------------------------
  // 2. Polling fallback (no webhooks)
  // -------------------------------------------------------------------------

  test('polled PR comment reaches the subscribed worker when no webhook is configured', async () => {
    ctx = await setupE2E();
    const watched = watchRepo(ctx, { polling: true });
    const { coderSessionId } = await seedActiveRunWithPr(ctx);

    const api = makeFakeGitHubApi([
      ['/issues/comments?', [issueCommentRow()]],
      ['/pulls/comments?', []],
      ['/pulls?', []],
      ['/reactions?', []],
    ]);
    const published = await ctx.extension.pollWatchedRepo(watched, api.fetchImpl);

    expect(published).toBe(1);
    expect(ctx.injected).toHaveLength(1);
    expect(ctx.injected[0]!.sessionId).toBe(coderSessionId);
    const essence = JSON.parse(ctx.injected[0]!.message);
    expect(essence.topic).toBe(COMMENT_POLLED_TOPIC);
    expect(ctx.eventStore.getById(essence.eventId)?.state).toBe('delivered');
  });

  test('/pulls page with stale rows clears the backlog so check_run failures still deliver', async () => {
    ctx = await setupE2E();
    const watched = watchRepo(ctx, { polling: true });
    const { coderSessionId } = await seedActiveRunWithPr(ctx);

    // Cycle 1: seed the cursor — PR 7 head sha abc123 tracked, pulls
    // watermark committed, empty check-run scan.
    const seedApi = makeFakeGitHubApi([
      ['/issues/comments?', []],
      ['/pulls/comments?', []],
      ['/pulls?', [pullRequestRow(PR_NUMBER)]],
      ['/check-runs?', { check_runs: [], total_count: 0 }],
      ['/reactions?', []],
    ]);
    await ctx.extension.pollWatchedRepo(watched, seedApi.fetchImpl);
    const seeded = reloadWatchedRepo(ctx, watched.id);
    expect(seeded.pollCursor?.recentPullRequestHeadShas?.[PR_NUMBER]).toBe('abc123');

    // Cycle 2: a full /pulls page (100 rows) — but one row is older than the
    // pulls watermark, so the cutoff clears the backlog and check-run polling
    // must still run this cycle.
    const freshRows = Array.from({ length: 99 }, (_, i) =>
      pullRequestRow(100 + i, {
        head: { sha: `fresh-sha-${i}` },
        updated_at: '2026-07-21T00:00:00Z',
      })
    );
    const staleRow = pullRequestRow(999, { updated_at: '2026-06-01T00:00:00Z' });
    const backlogApi = makeFakeGitHubApi([
      ['/issues/comments?', []],
      ['/pulls/comments?', []],
      ['/pulls?', [...freshRows, staleRow]],
      ['/check-runs?', { check_runs: [checkRunRow()], total_count: 1 }],
      ['/reactions?', []],
    ]);
    await ctx.extension.pollWatchedRepo(seeded, backlogApi.fetchImpl);

    // The check_run failure was published and delivered to the PR worker in
    // the same cycle, despite the full /pulls page.
    expect(injectedTopics(ctx)).toContain(CHECK_FAILED_TOPIC);
    const checkInjection = ctx.injected.find(
      (item) => JSON.parse(item.message).topic === CHECK_FAILED_TOPIC
    )!;
    expect(checkInjection.sessionId).toBe(coderSessionId);
    // The backlog was cleared by the cutoff — the next cycle resumes at page 1.
    const after = reloadWatchedRepo(ctx, watched.id);
    expect(after.pollCursor?.processedPages?.pulls ?? 1).toBe(1);
  });

  test('genuine /pulls backlog defers check_run polling but does not drop the failure', async () => {
    ctx = await setupE2E();
    const watched = watchRepo(ctx, { polling: true });
    await seedActiveRunWithPr(ctx);

    // Cycle 1: seed the cursor.
    const seedApi = makeFakeGitHubApi([
      ['/issues/comments?', []],
      ['/pulls/comments?', []],
      ['/pulls?', [pullRequestRow(PR_NUMBER)]],
      ['/check-runs?', { check_runs: [], total_count: 0 }],
      ['/reactions?', []],
    ]);
    await ctx.extension.pollWatchedRepo(watched, seedApi.fetchImpl);

    // Cycle 2: 100 rows all newer than the watermark — a real backlog. Page 2
    // is pending, so check-run polling is deferred this cycle. Rows carry
    // distinct descending updated_at values, mirroring GitHub's
    // sort=updated&direction=desc (which also ignores `since`, so page 1
    // always re-returns the newest full page).
    const freshRows = Array.from({ length: 100 }, (_, i) =>
      pullRequestRow(100 + i, {
        head: { sha: `fresh-sha-${i}` },
        updated_at: new Date(Date.parse('2026-07-21T00:00:00Z') - i * 60_000).toISOString(),
      })
    );
    const checkRunsRoute: [string, unknown] = [
      '/check-runs?',
      { check_runs: [checkRunRow()], total_count: 1 },
    ];
    const backlogApi = makeFakeGitHubApi([
      ['/issues/comments?', []],
      ['/pulls/comments?', []],
      // Page 2 holds the older tail of the list — the cutoff clears the
      // backlog there. Page 1 always serves the newest full page.
      [
        '/pulls?',
        (url: string) =>
          jsonResponse(
            url.includes('&page=2')
              ? [pullRequestRow(999, { updated_at: '2026-06-01T00:00:00Z' })]
              : freshRows
          ),
      ],
      checkRunsRoute,
      ['/reactions?', []],
    ]);
    await ctx.extension.pollWatchedRepo(reloadWatchedRepo(ctx, watched.id), backlogApi.fetchImpl);

    // Deferred, not dropped: no check-run request was even made.
    expect(injectedTopics(ctx)).not.toContain(CHECK_FAILED_TOPIC);
    expect(backlogApi.requests.filter((url) => url.includes('/check-runs?'))).toHaveLength(0);
    const midCursor = reloadWatchedRepo(ctx, watched.id).pollCursor;
    expect(midCursor?.processedPages?.pulls).toBe(2);

    // Cycle 3: page 2 drains (older rows cut off against the watermark), but
    // check-run polling stays deferred because a resumed page was fetched —
    // cursor-seeded heads are not confirmed fresh until page 1 is re-fetched.
    await ctx.extension.pollWatchedRepo(reloadWatchedRepo(ctx, watched.id), backlogApi.fetchImpl);
    expect(injectedTopics(ctx)).not.toContain(CHECK_FAILED_TOPIC);

    // Cycle 4: page 1 re-fetched, heads confirmed fresh, and the deferred
    // check_run failure is finally delivered — deferred, never dropped.
    await ctx.extension.pollWatchedRepo(reloadWatchedRepo(ctx, watched.id), backlogApi.fetchImpl);

    expect(injectedTopics(ctx)).toContain(CHECK_FAILED_TOPIC);
    const stored = ctx.db
      .prepare(`SELECT state FROM space_external_events WHERE topic = ?`)
      .all(CHECK_FAILED_TOPIC) as Array<{ state: string }>;
    expect(stored).toHaveLength(1);
    expect(stored[0]!.state).toBe('delivered');
  });

  // -------------------------------------------------------------------------
  // 3. Worker state transitions
  // -------------------------------------------------------------------------

  test('event for an inactive worker is persisted, then flushed exactly once on activation', async () => {
    ctx = await setupE2E();
    watchRepo(ctx);
    const { runId, taskId } = await seedActiveRunWithPr(ctx);
    // Worker goes inactive: idle execution, no session to inject into.
    const execution = ctx.nodeExecutionRepo.listByNode(runId, 'code')[0]!;
    ctx.tam.alive.clear();
    ctx.nodeExecutionRepo.update(execution.id, {
      status: 'idle',
      agentSessionId: null,
      completedAt: Date.now(),
    });

    const response = await sendWebhook(
      ctx,
      'pull_request_review_comment',
      reviewCommentWebhookPayload(),
      'delivery-comment-1'
    );
    expect(response.status).toBe(200);

    // Queued, not dropped: the delivery row waits for the worker.
    expect(ctx.injected).toHaveLength(0);
    const pendingEvent = (
      ctx.db
        .prepare(`SELECT id FROM space_external_events WHERE space_id = ?`)
        .all(SPACE_ID) as Array<{ id: string }>
    )[0]!;
    const delivery = ctx.eventStore.listDeliveries(pendingEvent.id)[0]!;
    expect(delivery.state).toBe('pending');

    // Worker activates: the tick-loop spawn path flushes the pending queue.
    ctx.nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: 'session-reactivated',
      completedAt: null,
    });
    // A concurrent flush (e.g. activation flush racing the delivery-path
    // flush) must not double-dispatch the persisted delivery.
    ctx.runtime.flushPendingNodeQueue({
      workflowRunId: runId,
      taskId,
      nodeId: 'code',
      agentName: 'coder',
      sessionId: 'session-reactivated',
    });
    ctx.runtime.flushPendingNodeQueue({
      workflowRunId: runId,
      taskId,
      nodeId: 'code',
      agentName: 'coder',
      sessionId: 'session-reactivated',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(ctx.injected).toHaveLength(1);
    expect(ctx.injected[0]!.sessionId).toBe('session-reactivated');
    expect(JSON.parse(ctx.injected[0]!.message).eventId).toBe(pendingEvent.id);
    expect(ctx.eventStore.listDeliveries(pendingEvent.id)[0]!.state).toBe('delivered');
    expect(ctx.eventStore.getById(pendingEvent.id)?.state).toBe('delivered');
  });

  test('webhook event for an idle subscriber is delivered in defer mode', async () => {
    ctx = await setupE2E();
    watchRepo(ctx);
    const { runId } = await seedActiveRunWithPr(ctx);
    // Idle subscriber: execution keeps a session handle but the session is
    // not live — the event must be queued for replay, not interrupt.
    ctx.tam.alive.clear();

    const response = await sendWebhook(
      ctx,
      'pull_request_review',
      reviewWebhookPayload(),
      'delivery-review-idle'
    );
    expect(response.status).toBe(200);

    expect(ctx.injected).toHaveLength(1);
    expect(ctx.injected[0]!.deliveryMode).toBe('defer');
    const essence = JSON.parse(ctx.injected[0]!.message);
    expect(essence.topic).toBe(REVIEW_TOPIC);
    expect(ctx.eventStore.getById(essence.eventId)?.state).toBe('delivered');
    expect(ctx.workflowRunRepo.getRun(runId)?.status).toBe('in_progress');
  });

  // -------------------------------------------------------------------------
  // 4. Noisy metadata dedupe
  // -------------------------------------------------------------------------

  test('repeated /pulls metadata for the same head sha does not re-trigger the worker', async () => {
    ctx = await setupE2E();
    const watched = watchRepo(ctx, { polling: true });
    await seedActiveRunWithPr(ctx);

    const api = makeFakeGitHubApi([
      ['/issues/comments?', []],
      ['/pulls/comments?', []],
      ['/pulls?', [pullRequestRow(PR_NUMBER, { updated_at: '2026-07-20T00:00:00Z' })]],
      ['/check-runs?', { check_runs: [], total_count: 0 }],
      ['/reactions?', []],
    ]);
    await ctx.extension.pollWatchedRepo(watched, api.fetchImpl);
    expect(injectedTopics(ctx)).toEqual([PR_POLLED_TOPIC]);

    // A comment lands on the PR: GitHub bumps updated_at, but the head sha is
    // unchanged. The dedupe key is unchanged, so nothing reaches the worker.
    api.setRoute('/pulls?', () =>
      jsonResponse([pullRequestRow(PR_NUMBER, { updated_at: '2026-07-21T00:00:00Z' })])
    );
    await ctx.extension.pollWatchedRepo(reloadWatchedRepo(ctx, watched.id), api.fetchImpl);
    expect(injectedTopics(ctx)).toEqual([PR_POLLED_TOPIC]);
    expect(ctx.db.prepare(`SELECT COUNT(*) AS c FROM space_external_events`).get()).toEqual({
      c: 1,
    });

    // A real push changes the head sha: new dedupe key, worker re-triggered.
    api.setRoute('/pulls?', () =>
      jsonResponse([
        pullRequestRow(PR_NUMBER, {
          head: { sha: 'def456' },
          updated_at: '2026-07-21T01:00:00Z',
        }),
      ])
    );
    await ctx.extension.pollWatchedRepo(reloadWatchedRepo(ctx, watched.id), api.fetchImpl);
    expect(injectedTopics(ctx)).toEqual([PR_POLLED_TOPIC, PR_POLLED_TOPIC]);
    const pushEvent = ctx.eventStore.getByDedupe(
      SPACE_ID,
      'github',
      `${OWNER}/${REPO}:pull_request:${PR_NUMBER * 10}:def456`
    );
    expect(pushEvent?.state).toBe('delivered');
  });

  // -------------------------------------------------------------------------
  // 5. Retention: no terminal drop while a run can still consume the event
  // -------------------------------------------------------------------------

  test('PR event linked to a run is retained published until a subscription registers; unlinked events are ignored', async () => {
    ctx = await setupE2E();
    watchRepo(ctx);
    // Seed a run whose PR URL is resolvable from gate data, but with no
    // subscription registered yet (no notifyGateDataChanged, no tick sweep).
    const { run } = await ctx.runtime.startWorkflowRun(SPACE_ID, workflowId(ctx), 'Run');
    const execution = ctx.nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
    const coderSessionId = `session-coder-${run.id}`;
    ctx.nodeExecutionRepo.update(execution.id, {
      status: 'in_progress',
      agentSessionId: coderSessionId,
      startedAt: Date.now(),
    });
    ctx.tam.alive.add(coderSessionId);
    ctx.gateDataRepo.merge(run.id, 'approval', { pr_url: PR_URL });

    const response = await sendWebhook(
      ctx,
      'pull_request_review',
      reviewWebhookPayload(),
      'delivery-review-retained'
    );
    expect(response.status).toBe(200);

    // No subscription matches, but the event names this run's PR — it must
    // stay published (retained) instead of being terminally ignored.
    const retained = (
      ctx.db
        .prepare(`SELECT id, state FROM space_external_events WHERE space_id = ?`)
        .all(SPACE_ID) as Array<{ id: string; state: string }>
    )[0]!;
    expect(retained.state).toBe('published');
    expect(ctx.eventStore.listDeliveries(retained.id)).toHaveLength(0);
    expect(ctx.injected).toHaveLength(0);

    // The subscription registering later (production: gate write on the
    // in_progress run) replays the retained event to the worker.
    await ctx.service.notifyGateDataChanged(run.id, 'approval');
    expect(injectedTopics(ctx)).toEqual([REVIEW_TOPIC]);
    expect(ctx.eventStore.getById(retained.id)?.state).toBe('delivered');

    // An event for a PR no run cares about is terminally ignored, so
    // duplicate webhooks for it short-circuit at the store.
    const unlinkedPayload = reviewWebhookPayload({
      review: { ...reviewWebhookPayload().review, id: 9002 },
      pull_request: {
        id: 990,
        number: 99,
        html_url: `https://github.com/${OWNER}/${REPO}/pull/99`,
        user: { login: 'dev', type: 'User' },
      },
    });
    const unlinked = await sendWebhook(
      ctx,
      'pull_request_review',
      unlinkedPayload,
      'delivery-review-unlinked'
    );
    expect(unlinked.status).toBe(200);
    const ignored = ctx.db
      .prepare(`SELECT state FROM space_external_events WHERE topic LIKE '%pull_request/99.%'`)
      .all() as Array<{ state: string }>;
    expect(ignored).toEqual([{ state: 'ignored' }]);
  });
});
