# Design: External Event Bus for Space Workflow Nodes

## Status: Draft

## Problem

The Space Agent spends most of its time relaying "check the new review comments" to the coder node. External events (PR reviews, CI failures, etc.) arrive via webhooks/polling but have no path to workflow **nodes** — they only route to Rooms or to the Space Agent's global session (via `SpaceGitHubService`). We need a system where workflow nodes declare interest in event types, and matching events are delivered directly to their agent sessions.

## Current State

Two parallel event pipelines exist today, neither of which routes to individual workflow nodes:

1. **Room pipeline** (`GitHubService`): Webhook → normalize → filter → security → route → `deliverToRoom()` → DaemonHub `room.message`. Routes to **Rooms**, not Spaces.
2. **Space pipeline** (`SpaceGitHubService`): Webhook → normalize → dedupe → `SpacePrTaskResolver.resolve()` → `injectTaskAgent()`. Routes events to the **Task Agent session** (the orchestrator), which must then manually relay to the coder node.

The Space pipeline proves the primitives exist, but it is not the right extension boundary: GitHub-specific normalization, dedup, PR-to-task resolution, and Task Agent injection are bundled together in `SpaceGitHubService`. The target design extracts source ingestion into extensions and moves dedup and node delivery into reusable core external-event services.

## Design Overview

This design treats GitHub as the first external-event **extension** rather than a special-case Space service. The extension owns source-specific concerns — GitHub auth, webhook verification, polling, raw payload normalization, and source configuration. Core Space infrastructure owns durable external-event lifecycle only. Subscription matching, event delivery, and retry are **workflow-runtime and agent concerns**, not event-pipeline concerns.

The event pipeline is a **dumb pipe** with three responsibilities and nothing more:

```text
ExternalEventService
  validates, dedupes, persists, publishes InternalEventBus fact: externalEvent.published
       |
       v
  Subscribers (workflow runtime / agents):
  - Data-driven event subscriptions in workflow definitions (topic patterns only)
  - MCP tool for dynamic agent subscriptions
  - Topic-pattern matching only -- no scope layer
```

The design should make adding a third-party source boring:

```text
SlackEventExtension / JiraEventExtension / CIEventExtension
  → normalize source payloads into ExternalEvent
  → publish to ExternalEventService
  → reuse the same store and dedup pipeline
```

No third-party extension should inspect workflow node state or inject messages into agent sessions.

### Extension enablement and configuration

External event sources should be configurable at two levels:

1. **Global extension configuration** — installed/enabled daemon-wide, with shared secrets or app credentials.
2. **Space extension configuration** — enabled/disabled per space, with source-specific routing scope such as watched GitHub repositories, Slack channels, Jira projects, or CI pipelines.

GitHub is the reference implementation:

```text
Global GitHub config
  ├─ extension enabled/disabled
  ├─ GitHub App / token / webhook secret configuration
  └─ allowed capabilities: webhooks, polling, repo watching

Per-space GitHub config
  ├─ extension enabled/disabled for the space
  ├─ watched repositories
  ├─ optional event filters
  └─ optional polling/webhook preferences
```

The extension manager should prevent disabled sources from accepting webhooks, scheduling polling, or publishing events for disabled spaces. Existing source-specific tables such as `space_github_watched_repos` can remain as GitHub extension configuration during migration, but the cross-source event lifecycle belongs to `ExternalEventStore`.

## 1. Namespaced Event Topics

Topic format is **source-specific** — each extension defines its own schema:

- **GitHub**: `{source}/{owner}/{repo}/{resource}/{entityId.action}` (5 segments)
- **Slack**: `{source}/{workspace}/{channel}/{event_type}` (3 segments)
- **Jira**: `{source}/{org}/{project}/{event_type}` (3 segments)

Examples (GitHub):
```
github/lsm/neokai/pull_request/5.review_submitted
github/lsm/neokai/pull_request/5.comment_created
github/lsm/neokai/pull_request/5.synchronize
github/lsm/neokai/pull_request/5.closed
# issues.* requires a future GitHub extension expansion: github/lsm/neokai/issues/5.opened
# Future CI extension (Phase 3): github/lsm/neokai/check_suite/12345.completed
github/lsm/neokai/pull_request/5.*            ← wildcard: all events for PR #5
github/lsm/neokai/pull_request/*.review_submitted  ← wildcard: any PR, review_submitted only
github/lsm/neokai/pull_request/*.*             ← wildcard: all events for any PR
github/lsm/neokai/pull_request/5.review_*      ← prefix wildcard: all review events for PR #5
github/*/*/*/*.*                               ← space-level: everything
```

### Topic construction rules

1. `source` — extension/source identifier (`github`, `slack`, `ci`). Lowercase, no slashes.
2. Remaining segments are **source-specific** — each extension defines its own schema, depth, and segment structure.
3. `validateGlobPattern()` enforces only universal structural constraints (non-empty, no empty segments, no `..`, no `**`, valid characters). Segment count, dotted format, and position-specific wildcard rules are enforced by each source extension.
4. The GitHub extension uses 5 segments: `source/owner/repo/resource/entityId.action`. The `entityId` is the source-native entity identifier (e.g., PR number). The `entityId.action` segment is dot-separated to allow entity-level and action-level wildcards.

### Matching rules

Subscriptions use glob-style patterns:
- `*` matches any sequence of characters inside one path segment (no slashes).
  - A whole-segment `*` matches any single segment (e.g., owner or repo).
  - A segment-local wildcard also works inside dotted resource/action segments (e.g., `pull_request.*`, `pull_request.review_*`, `*.*`).
- Literal characters match exactly (case-insensitive).

> **V1 scope note:** The `**` (multi-segment) wildcard is deferred to a follow-up. All v1 use cases are covered by segment-local `*` wildcards (e.g., `github/*/*/pull_request/5.review_submitted`, `github/*/*/pull_request/5.*`). Adding `**` support requires a depth-bounded recursive trie walk and is not justified by current subscription patterns.

Pattern validation (enforced when a runtime subscription is created or updated):
- Must be non-empty.
- Must have at least 2 segments (source + one scope segment).
- Must not contain `..` segments.
- Must not contain empty segments (no double slashes).
- Each segment may contain alphanumeric, dash, underscore, dot, and `*`; `*` must stay within a single segment and cannot cross `/` boundaries.
- Segment count and structure are source-specific (enforced by each extension, not the general-purpose validator).
- Max 10 interests per agent slot.

We implement matching via a **trie-based prefix index** (see §6), scoped as a workflow-runtime utility.

## 2. Runtime Event Subscription (`EventInterest`)

### Runtime subscription type

`EventInterest` is a shared type for runtime subscription APIs. It is **not** stored on `WorkflowNodeAgent` or any static workflow schema. Subscriptions are created by runtime scripts and agent tools that already have the concrete context needed to subscribe narrowly.

```typescript
// packages/shared/src/types/space.ts

export interface EventInterest {
  /**
   * Glob pattern matching event topics.
   * Examples: 'github/*/*/pull_request/5.*', 'github/*/*/pull_request/5.review_*'
   *
   * The topic pattern IS the filter — the source-specific topic format encodes
   * source identity and scope (e.g. owner/repo for GitHub). No additional scope
   * layer is needed. Subscription matching is a workflow-runtime concern
   * that matches topic patterns against incoming event topics.
   */
  topic: string;

  /**
   * Optional label for diagnostics. Not used in matching logic.
   * Example: 'PR review comments', 'CI failures'
   */
  label?: string;
}
```

### Why subscriptions are runtime-driven

Workflows operate on a concrete unit of work, such as one pull request. When an agent creates or discovers that unit of work, the artifact or gate script that reacts to the event already has all required context: source, owner, repo, PR number, and target node or agent. That script can mechanically subscribe to exactly the relevant topic pattern:

```text
Agent creates PR #142 in lsm/neokai
  → artifact/gate script receives context: owner=lsm, repo=neokai, pr=142, targetNode=Coding
  → script subscribes: { topic: 'github/lsm/neokai/pull_request.142_*', label: 'PR #142 activity' }
  → matched events are injected into the target node/agent session
```

Static workflow-level declarations like `github/*/*/pull_request.*` are usually too broad, while precise subscriptions are not known until runtime. Keeping subscriptions runtime-driven avoids coupling reusable workflow definitions to a specific repository, PR, or external source instance.

### Topic pattern IS the filter

The source-specific topic format encodes enough context for routing without any additional scope layer:

- `github/lsm/neokai/pull_request/5.review_submitted` — specific PR in a specific repo
- `github/*/*/pull_request/*.review_submitted` — all repos, any PR
- `github/lsm/neokai/pull_request/5.*` — all actions for a specific PR
- `github/lsm/neokai/pull_request/*.*` — all events for any PR in a specific repo

Subscription matching is a **workflow-runtime concern**, not an event-pipeline concern. The pipeline publishes events; the workflow runtime matches topic patterns against runtime subscription records. No scope concepts (`repo`, `global`, `task`) exist in the event pipeline.

### Dynamic event subscriptions

Runtime scripts and node-agent tools create event subscriptions while a workflow run is active. This allows:

1. **Script-created subscriptions** — gate/artifact scripts subscribe to events derived from concrete workflow actions (for example, a PR URL emitted by an agent).
2. **Agent-initiated subscriptions** — A new MCP tool (`subscribe_external_event`) allows agents to dynamically subscribe to events during execution. The agent can inspect event payloads and decide relevance based on its own context (task, PR, branch).
3. **No pipeline-level filtering** — The event pipeline does not understand repos, tasks, or any domain-specific scoping. It publishes normalized events with opaque payloads. All filtering happens at the subscriber level.

## 3. External Event Extension Interface

External sources are modeled as **extensions**. An extension owns the source-specific work:

1. Receive events from its source (webhook, polling, streaming API, etc.).
2. Check global and per-space enablement before accepting or polling events.
3. Verify source-specific authenticity (e.g. GitHub HMAC signatures).
4. Load source-specific configuration (for GitHub: watched repositories and webhook/polling settings).
5. Normalize raw source payloads into `ExternalEvent`.
6. Publish directly to `ExternalEventService`.

Extensions do **not** inspect workflow nodes, resolve Space tasks, or inject into agent sessions. Those are subscriber concerns handled by the workflow runtime and agent tools. This keeps GitHub, Slack, Jira, CI, and future integrations pluggable without adding source-specific paths to the workflow runtime.

```typescript
// packages/daemon/src/lib/external-events/types.ts

/**
 * A normalized external event on the bus.
 *
 * `dedupeKey` is the stable source-level identity used by `ExternalEventStore`
 * to recognize the same external event across webhook + polling observations.
 * It must be stable across observations of the same external event from any
 * channel and unique within `(spaceId, source)`.
 *
 * Source-specific metadata (PR number, repo owner, branch, etc.) lives in the
 * opaque `payload` object. The event pipeline is intentionally agnostic to
 * task-system concerns — task matching is the responsibility of subscribers.
 */
export interface ExternalEvent {
  /** Unique event ID (UUID) assigned by the extension for this publication. */
  id: string;
  /** Space this event belongs to. Required to prevent cross-space delivery. */
  spaceId: string;
  /** Fully qualified topic: 'github/owner/repo/resource.action' */
  topic: string;
  /** Timestamp when the event occurred at the source (epoch ms). */
  occurredAt: number;
  /** Timestamp when the event was accepted by the extension (epoch ms). */
  ingestedAt: number;
  /** Source extension identifier. */
  source: string;
  /** Optional source-native event id / delivery id for diagnostics. */
  sourceEventId?: string;
  /** Human-readable summary for agent consumption. */
  summary: string;
  /** External URL (e.g. GitHub PR link). */
  externalUrl?: string;
  /**
   * Structured source payload — extension-specific, not constrained.
   * Source-specific metadata like prNumber, repoOwner, repoName, branch
   * live inside this opaque payload. The event pipeline does not interpret
   * these fields; they are passed through to subscribers.
   */
  payload: Record<string, unknown>;
  /**
   * Stable source-level identity used by bus dedup. Must be stable across
   * webhook and polling observations of the same external event.
   */
  dedupeKey: string;
}

export interface ExternalEventExtensionConfig {
  source: string;
  globallyEnabled: boolean;
  capabilities: {
    webhooks?: boolean;
    polling?: boolean;
    rpcConfig?: boolean;
  };
  secretsRef?: string;
  settings?: Record<string, unknown>;
}

export interface SpaceExternalEventSourceConfig {
  spaceId: string;
  source: string;
  enabled: boolean;
  settings: Record<string, unknown>;
}

export interface ExternalEventExtensionContext {
  /** Publish a normalized event into the shared external-event subsystem. */
  publisher: ExternalEventPublisher;
  /** Read global extension config, secrets references, and per-space config. */
  config: ExternalEventExtensionConfigStore;
  /** Notify core services that source configuration changed for a space. */
  onSourceConfigChanged(change: { source: string; spaceId?: string; kind: string }): void;
}

export interface ExternalEventExtensionConfigStore {
  getGlobalConfig(source: string): Promise<ExternalEventExtensionConfig>;
  getSpaceConfig(spaceId: string, source: string): Promise<SpaceExternalEventSourceConfig | null>;
  listEnabledSpaces(source: string): Promise<SpaceExternalEventSourceConfig[]>;
}

/**
 * Interface that event source extensions must implement.
 */
export interface ExternalEventExtension {
  /** Source identifier used in topic namespace: '{source}/...'. */
  readonly sourceId: string;

  /**
   * Start the extension. Called once at daemon startup if the source is globally enabled.
   * The extension calls `context.publisher.publish(event)` whenever it accepts an event.
   */
  start(context: ExternalEventExtensionContext): Promise<void>;

  /** Stop the extension. Called at daemon shutdown or when globally disabled. */
  stop(): Promise<void>;
}

/**
 * Optional interface for extensions that expose HTTP endpoints.
 * The daemon routes matching requests to the extension without knowing source
 * internals such as HMAC verification, event names, or raw payload shape.
 */
export interface HttpExternalEventExtension extends ExternalEventExtension {
  readonly routes: readonly {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    path: string;
    handle(req: Request, context: ExternalEventExtensionContext): Promise<Response>;
  }[];
}

/**
 * Optional interface for extensions that expose daemon RPC methods.
 * GitHub uses this for watch/list/poll operations; future extensions can expose
 * source-specific configuration without adding core RPC handler dependencies.
 */
export interface RpcExternalEventExtension extends ExternalEventExtension {
  registerRpcHandlers(hub: MessageHub, context: ExternalEventExtensionContext): void;
}

/**
 * Callback extensions use to publish events into the shared external-event subsystem.
 */
export interface ExternalEventPublisher {
  publish(event: ExternalEvent): Promise<PublishResult>;
}

export interface PublishResult {
  eventId: string;
  duplicate: boolean;
  state: 'published' | 'duplicate_terminal' | 'retryable_duplicate' | 'ignored';
}

export interface ExternalEventStore {
  store(event: ExternalEvent): { event: ExternalEvent; duplicate: boolean; terminal: boolean };
  /**
   * Idempotently register the delivery row expected for an event/subscription.
   * Must be implemented as INSERT OR IGNORE / ON CONFLICT DO NOTHING (or an
   * equivalent upsert that preserves terminal state) because retryable source
   * duplicates and runtime retries can prepare the same (eventId, deliveryKey)
   * multiple times before delivery succeeds.
   */
  registerExpectedDelivery(
    eventId: string,
    deliveryKey: string,
    target: { workflowRunId: string; taskId: string; nodeId: string; agentName: string },
  ): void;
  /** Returns true when the delivery row is already terminal and should be skipped. */
  isDeliveryTerminal(eventId: string, deliveryKey: string): boolean;
  /** Looks up the source event id for a registered delivery key. */
  getEventIdForDeliveryKey(deliveryKey: string): string;
  markDeliveryDelivered(eventId: string, deliveryKey: string): void;
  markDeliveryFailed(
    eventId: string,
    deliveryKey: string,
    failure: { terminal: boolean; reason: string },
  ): void;
  markEventDeliveredIfAllDeliveriesDelivered(eventId: string): void;
  markEventFailedIfAnyDeliveryTerminalFailed(eventId: string): void;
  markEventFailedIfAllDeliveriesTerminal(eventId: string): void;
  markEventFailed(eventId: string, failure: { terminal: boolean; reason: string }): void;
  markEventIgnored(eventId: string, reason: 'no_matching_subscriptions'): void;
}
```

```typescript
class ExternalEventService implements ExternalEventPublisher {
  constructor(
    private readonly internalEventBus: InternalEventBus<InternalEventMap>,
    private readonly eventStore: ExternalEventStore,
  ) {}

  async publish(event: ExternalEvent): Promise<PublishResult> {
    // 1. Validate topic and required source fields.
    validateExternalEvent(event);

    // 2. Store and dedupe before emission. Unlike SpaceGitHubService.ingest(),
    // retryable duplicates are not swallowed: if the prior delivery state is
    // non-terminal, the event is re-emitted so delivery can retry.
    const stored = this.eventStore.store(event);
    if (stored.duplicate && stored.terminal) {
      return { eventId: stored.event.id, duplicate: true, state: 'duplicate_terminal' };
    }

    // 3. Publish the normalized event to the internal bus.
    // The event pipeline does NOT resolve tasks — task matching is a
    // workflow-node concern, not an event-pipeline concern.
    await this.internalEventBus.publish('externalEvent.published', {
      channel: Channels.space(event.spaceId),
      payload: { event },
    });

    return {
      eventId: event.id,
      duplicate: stored.duplicate,
      state: stored.duplicate ? 'retryable_duplicate' : 'published',
    };
  }
}
```

### ExternalEventService responsibilities

`ExternalEventService` owns cross-cutting behavior that applies to every extension:

1. **Validation** — all topics must satisfy the four-segment topic contract before publication.
2. **Source-level dedup** — a persistent `ExternalEventStore` tracks `(spaceId, source, dedupeKey)` and delivery state. Terminal duplicates (`delivered`, `failed`, `ignored`) are short-circuited; retryable states (`published`) are re-emitted so delivery can retry.
3. **Publication** — only deduped events are published as the internal fact `externalEvent.published`.

The service does NOT:
- Resolve events to tasks
- Match subscriptions or filter by scope
- Inspect workflow nodes
- Inject messages into agent sessions
- Interpret source-specific payload fields

This replaces the current GitHub-specific `SpaceGitHubService.ingest()` hot path for new event delivery. In particular, the service-level dedup store must not use unconditional `INSERT OR IGNORE` short-circuiting for retryable states; otherwise transient delivery failures become permanent event loss.

### GitHub extension as the reference implementation

```typescript
interface GitHubSpaceConfig {
  enabled: boolean;
  watchedRepos: { owner: string; repo: string; enabled: boolean }[];
  eventFilters?: {
    pullRequests?: boolean;
    reviews?: boolean;
    comments?: boolean;
    checks?: boolean;
  };
  polling?: { enabled: boolean; intervalMs?: number };
  webhooks?: { enabled: boolean };
}

class GitHubEventExtension implements HttpExternalEventExtension, RpcExternalEventExtension {
  readonly sourceId = 'github';
  readonly routes = [
    { method: 'POST', path: '/webhook/github/space', handle: this.handleWebhook.bind(this) },
  ] as const;

  private context?: ExternalEventExtensionContext;
  private pollTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;

  async start(context: ExternalEventExtensionContext): Promise<void> {
    this.context = context;
    this.stopped = false;
    const global = await context.config.getGlobalConfig(this.sourceId);
    if (!global.globallyEnabled || !global.capabilities.polling) return;

    // Use completion-scheduled polling instead of setInterval so a slow poll cycle
    // cannot overlap the next one and amplify duplicate fetches/rate-limit pressure.
    this.scheduleNextPoll();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
  }

  private scheduleNextPoll(): void {
    if (this.stopped) return;
    this.pollTimer = setTimeout(() => {
      void this.runPollCycle();
    }, GITHUB_POLL_INTERVAL_MS);
  }

  private async runPollCycle(): Promise<void> {
    try {
      await this.pollEnabledSpaces();
    } catch (err) {
      log.warn('GitHubEventExtension: polling failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.scheduleNextPoll();
    }
  }

  registerRpcHandlers(hub: MessageHub, context: ExternalEventExtensionContext): void {
    hub.onRequest('space.github.enable', async (data) => {
      const config = await this.enableForSpace(data);
      context.onSourceConfigChanged({ source: this.sourceId, spaceId: config.spaceId, kind: 'space_enabled' });
      return config;
    });

    hub.onRequest('space.github.disable', async (data) => {
      const config = await this.disableForSpace(data);
      context.onSourceConfigChanged({ source: this.sourceId, spaceId: config.spaceId, kind: 'space_disabled' });
      return config;
    });

    hub.onRequest('space.github.watchRepo', async (data) => {
      const watchedRepo = await this.watchRepo(data);
      context.onSourceConfigChanged({ source: this.sourceId, spaceId: watchedRepo.spaceId, kind: 'watched_repo_changed' });
      return watchedRepo;
    });

    hub.onRequest('space.github.listConfig', async (data) => this.listSpaceConfig(data));
    hub.onRequest('space.github.pollOnce', async (data) => ({ count: await this.pollSpace(data.spaceId) }));
  }

  private async handleWebhook(req: Request, context: ExternalEventExtensionContext): Promise<Response> {
    const global = await context.config.getGlobalConfig(this.sourceId);
    if (!global.globallyEnabled || !global.capabilities.webhooks) {
      return Response.json({ ignored: true, reason: 'github_extension_disabled' }, { status: 202 });
    }

    const raw = await req.text();
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch (err) {
      log.warn('GitHubEventExtension: invalid webhook JSON', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json({ ignored: true, reason: 'invalid_json' }, { status: 400 });
    }

    const normalized = normalizeGitHubWebhook(req.headers, payload);
    if (!normalized) return Response.json({ ignored: true });

    const targetSpaces = await this.resolveEnabledSpacesForWebhook(context, req, raw, normalized);
    const results = await Promise.allSettled(
      targetSpaces
        .filter((spaceConfig) => spaceConfig.enabled)
        .map(async (spaceConfig) => {
          try {
            await context.publisher.publish(toExternalEvent(spaceConfig.spaceId, normalized));
            return { spaceId: spaceConfig.spaceId, ok: true };
          } catch (err) {
            log.warn('GitHubEventExtension: failed to publish webhook for space', {
              spaceId: spaceConfig.spaceId,
              error: err instanceof Error ? err.message : String(err),
            });
            return { spaceId: spaceConfig.spaceId, ok: false };
          }
        }),
    );

    const failed = results
      .map((result) => result.status === 'fulfilled' ? result.value : { spaceId: 'unknown', ok: false })
      .filter((result) => !result.ok);

    return Response.json({
      message: 'Webhook received',
      published: results.length - failed.length,
      failed: failed.length,
    }, { status: failed.length > 0 ? 207 : 200 });
  }

  private async pollEnabledSpaces(): Promise<number> {
    if (!this.context) return 0;
    const spaces = await this.context.config.listEnabledSpaces(this.sourceId);
    const results = await Promise.allSettled(
      spaces.map(async (spaceConfig) => {
        try {
          return await this.pollSpace(spaceConfig.spaceId);
        } catch (err) {
          log.warn('GitHubEventExtension: polling failed for space', {
            spaceId: spaceConfig.spaceId,
            error: err instanceof Error ? err.message : String(err),
          });
          return 0;
        }
      }),
    );

    return results.reduce((count, result) => {
      if (result.status === 'fulfilled') return count + result.value;
      return count;
    }, 0);
  }

  async pollSpace(spaceId: string, fetchImpl: typeof fetch = fetch): Promise<number> {
    // Load this space's GitHub config, poll its enabled watched repos, normalize rows,
    // and publish ExternalEvent directly. No SpaceTask lookup and no session injection happen here.
  }
}
```

The normalization helpers currently living in `space-github.ts` move into this extension module:

- `normalizeSpaceGitHubWebhook(...)` → `normalizeGitHubWebhook(...)`
- `normalizePollingRow(...)` → `normalizeGitHubPollingRow(...)`
- `mapEventType(...)` stays with the extension because topic construction is source-specific

The extension may keep source-local tables such as `space_github_watched_repos` and an optional extension event log for diagnostics, but the authoritative cross-source event lifecycle belongs to `ExternalEventStore`. During migration, existing GitHub RPC names can remain as compatibility aliases, but new extension APIs should use a generic shape where possible: global source enablement, per-space source enablement, source-specific settings, and watched-resource configuration.

## 4. Event Subscription and Delivery (Workflow-Runtime Concern)

### Architecture

The event pipeline does **not** include a router. Subscription matching and event delivery are **workflow-runtime concerns**:

1. **ExternalEventService** publishes `externalEvent.published` to InternalEventBus.
2. **Workflow runtime** subscribes to the bus and matches events against active runtime subscription records.
3. **Gate/artifact scripts and agent MCP tools** create subscriptions during execution using `EventInterest` topic patterns.
4. **Node agents** receive matched events as structured messages via the existing `agent.message.inject` command.

The pipeline is a **dumb pipe**: validate, dedupe, publish. Everything else is a subscriber concern.

### Why no ExternalEventRouter

The original design included an `ExternalEventRouter` that owned subscription indexing (TopicTrie), scope filtering (`repo`/`global`/`task`), per-subscription delivery lifecycle, retry logic, and command dispatch. This violated the core principle in several ways:

1. **Scope is domain-specific** — `repo` scope is a GitHub concept. `task` scope couples the pipeline to the task system. Neither belongs in a source-agnostic pipeline.
2. **Watched repos are extension config** — which repos a space watches is a GitHub extension concern. The core pipeline should not know about repos.
3. **Topic patterns are sufficient** — the 4-segment topic format `{source}/{scope1}/{scope2}/{resource.action}` already encodes enough context for subscription matching. No additional scope layer is needed.
4. **Delivery retry is a workflow concern** — whether and how to retry event delivery is owned by the workflow runtime, not the event pipeline.

### Subscription matching

Subscription matching happens in the **workflow runtime**, not in a standalone router:

1. The workflow runtime subscribes to `externalEvent.published` on InternalEventBus.
2. Runtime scripts or agent tools create subscription records for active workflow runs using `EventInterest` topic patterns.
3. When an event arrives, the runtime matches its topic against active runtime subscriptions using glob-pattern matching.
4. Topic-pattern matching is the **only filter**. No scope layer. The topic `github/lsm/neokai/pull_request.review_submitted` already identifies the repo; `github/*/*/pull_request.*` catches all PR events.
5. Matched events are delivered to the target node's agent session via `agent.message.inject`.

The runtime can use a TopicTrie or simple linear scan — this is an implementation detail of the workflow system, not the event pipeline.

### Agent MCP tool for dynamic subscriptions

A new MCP tool exposed to node agents allows dynamic event subscription during execution:

```typescript
// MCP tool: subscribe_external_event
// Allows agents to subscribe to events matching a topic pattern at runtime.
interface SubscribeExternalEventParams {
  /** Glob pattern matching event topics. */
  topicPattern: string;
  /** Optional filter function (evaluated by the runtime, not the pipeline). */
  filter?: Record<string, unknown>;
}

// MCP tool: unsubscribe_external_event
// Removes a dynamic subscription.
interface UnsubscribeExternalEventParams {
  /** The topic pattern to unsubscribe. */
  topicPattern: string;
}
```

This allows agents to:
- Subscribe to specific topics based on their task context (e.g., a coder working on PR #42 subscribes to `github/lsm/neokai/pull_request.*` and filters by `prNumber: 42` in its own logic).
- Dynamically adjust subscriptions during execution.
- Inspect event payloads and decide relevance based on their own context — no pipeline-level interpretation needed.

### Per-subscription delivery tracking

Per-subscription delivery lifecycle (pending → delivered/failed) is tracked in `space_external_event_deliveries`, managed by the **workflow runtime**. The delivery table schema is unchanged:

```sql
CREATE TABLE space_external_event_deliveries (
  event_id TEXT NOT NULL,
  delivery_key TEXT NOT NULL,
  workflow_run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK(state IN ('pending', 'delivered', 'failed')),
  failure_reason TEXT,
  delivered_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(event_id, delivery_key),
  FOREIGN KEY (event_id) REFERENCES space_external_events(id) ON DELETE CASCADE
);
```

Event terminalization (`published` → `delivered`/`failed`) is advanced by the workflow runtime after all expected deliveries complete, using the same `ExternalEventStore` methods.

### How task-event association works

The workflow runtime knows which task each node belongs to and what PR/branch it's working on. The agent's context prompt already includes task, PR number, branch. The agent inspects event payload and decides relevance. No pipeline-level task matching needed.

## 5. Event Delivery Lifecycle

### State machine per event delivery

```
Event arrives → Dedup check → Published to InternalEventBus
                                        |
                        ┌───────────────┼───────────────┐
                        v               v               v
                  Session live   Session idle    No session
                        |               |               |
                        v               v               v
                  Inject via      Wake + inject   Queue in
                  injectMessage   injectMessage   pending_events
                        |               |               |
                        v               v               v
                  Mark delivered  Mark delivered  Mark queued
                                                   delivered
                                                   after flush
```

### Deduplication

Dedup happens at two different layers, each with a different key and responsibility:

1. **Source-level bus dedup** — persistent `(spaceId, source, dedupeKey)` in `ExternalEventStore`.
   - Purpose: prevent webhook/polling duplicates from becoming separate bus events.
   - Terminal duplicates (`delivered`, `failed`, `ignored`) are short-circuited.
   - Retryable duplicates (`published`) are re-emitted so transient delivery failures can retry.
   - This replaces `SpaceGitHubService.storeEvent()` as the authoritative dedup path for new external-event delivery.

2. **Per-subscription delivery dedup** — JSON tuple `[event.source, event.dedupeKey, subscription.taskId, subscription.nodeId, subscription.agentName, subscription.workflowRunId]`.
   - Purpose: prevent the same external event from being delivered twice to the same node agent within a run.
   - The tuple includes `event.source` because source-level dedupe is scoped by `(spaceId, source, dedupeKey)`: two extensions can legitimately emit the same `dedupeKey` in one space and must not share pending/delivered/retry bookkeeping.
   - The tuple includes `taskId` to isolate multi-task runs and `nodeId` to handle cases where the same agent name appears in multiple nodes within the same run.
   - The tuple is encoded structurally rather than delimiter-joined because `source`, `dedupeKey`, workflow identifiers, node IDs, and agent names are free-form strings.
   - It is tracked in-memory for fast duplicate suppression and persisted in `space_external_event_deliveries` after successful injection.

The workflow runtime marks per-subscription delivery as `delivered` only after successful injection, updates `ExternalEventStore` with the successful delivery key, and advances the source event to terminal `delivered` only once all expected deliveries are `delivered`. Failed injection/session-resolution paths remove `pendingDeliveries` and schedule retry rather than relying on extensions to re-publish the same event. If a delivery reaches terminal `failed`, the source event must be `failed` rather than later reclassified as `delivered` by another subscription's success. If no matching subscriptions are found, or if all matched subscriptions are already terminal and no preparation retry is pending, the runtime marks the source event terminal `ignored` so webhook+polling duplicates do not churn through matching forever.

### Wake-on-idle

When an event matches a subscription whose node execution is `idle` (agent session exists but finished its turn):

1. Dispatch `InternalCommandBus.dispatch('agent.message.inject', { sessionId, message, deliveryMode: 'defer', ... })`.
2. The command handler uses the existing defer mechanism under the hood: if idle → enqueue immediately; if busy → persist as deferred, replay after current turn.
3. No new wake mechanism needed — the existing deferred injection path already solves this.

### Node cancellation cleanup

When a node execution transitions to `cancelled`, runtime status-transition wiring must call `unregisterExecution(workflowRunId, taskId, nodeId, agentName)` immediately. This removes that node's subscriptions and handles queued/retrying deliveries:

1. Remove queued pending-node deliveries for the exact `[workflowRunId, taskId, nodeId, agentName]` key and mark them terminally failed with reason `node_execution_cancelled`.
2. Cancel per-delivery retry timers for the same tuple.
3. Call `markEventFailedIfAllDeliveriesTerminal(eventId)` for each failure so long-running runs do not keep source events retryable.

### Terminal run cleanup

When a workflow run transitions to `done` or `cancelled`, `clearRunInterests(workflowRunId)` removes subscriptions, retry timers, and in-memory pending queues. Queued/retrying deliveries are marked terminally failed:

1. Collect each queued `{ eventId, deliveryKey }` for the terminal run and fail it with reason `run_terminal_cleanup`.
2. For each failure, call `markDeliveryFailed(eventId, deliveryKey, { terminal: true, reason })` and then `markEventFailedIfAllDeliveriesTerminal(eventId)`.
3. Only then delete the in-memory queue, pending markers, retry counts, and timers.

### Queue for not-yet-started nodes

When a node execution is `pending` (no session yet):

1. The event is queued in an in-memory `Map<string, ExternalEvent[]>` keyed by a JSON tuple `[workflowRunId, taskId, nodeId, agentName]`.
2. When `TaskAgentManager` creates the node's session, it flushes queued events.
3. Queue is bounded: max 50 events per execution, oldest dropped with warning log.

**Known limitation — daemon restart**: The in-memory per-node pending queue is lost on daemon restart. For v1, this is accepted as a known delivery gap.

### Backpressure

- **Rate limiting**: If a single node receives > 10 events per minute, subsequent events are coalesced into a digest message.
- **Event TTL**: Events older than 5 minutes are dropped from the queue.
- **Handler overflow**: In v1, use the awaited `publish(...)` path for observability; if later throughput requires fire-and-forget behavior, use explicit `publishAsync(...)`.

## 6. Topic Trie Implementation (Workflow-Runtime Utility)

```typescript
/**
 * Simple trie for topic-pattern matching.
 * Supports * (single segment wildcard) at any position.
 *
 * This is a workflow-runtime utility, not an event-pipeline component.
 * The pipeline publishes events; the workflow runtime uses this trie
 * to match subscriptions against incoming event topics.
 */
class TopicTrie<T> {
  private root = new TrieNode<T>();

  /**
   * Insert a value at a glob pattern.
   * Pattern segments may contain segment-local `*` wildcards, e.g.
   * `github/*/*/pull_request.*` or `github/*/*/pull_request.review_*`.
   */
  insert(pattern: string, value: T): void {
    const segments = pattern.split('/');
    let node = this.root;
    for (const segment of segments) {
      const key = segment.toLowerCase();
      const children = key.includes('*') ? node.globChildren : node.exactChildren;
      if (!children.has(key)) {
        children.set(key, new TrieNode());
      }
      node = children.get(key)!;
    }
    if (!node.values) node.values = [];
    node.values.push(value);
  }

  /**
   * Lookup all values whose patterns match the given topic.
   * Returns all values from exact matches AND wildcard matches at each level.
   */
  lookup(topic: string): T[] {
    const segments = topic.split('/');
    const results: T[] = [];

    const walk = (node: TrieNode<T>, depth: number) => {
      if (depth === segments.length) {
        if (node.values) results.push(...node.values);
        return;
      }

      const segment = segments[depth].toLowerCase();

      const exact = node.exactChildren.get(segment);
      if (exact) walk(exact, depth + 1);

      for (const [patternSegment, child] of node.globChildren.entries()) {
        if (segmentMatches(patternSegment, segment)) {
          walk(child, depth + 1);
        }
      }
    };

    walk(this.root, 0);
    return results;
  }

  /**
   * Remove all values matching a predicate and prune empty child branches.
   */
  remove(predicate: (value: T) => boolean): void {
    const clean = (node: TrieNode<T>): boolean => {
      if (node.values) {
        node.values = node.values.filter(v => !predicate(v));
        if (node.values.length === 0) node.values = undefined;
      }

      for (const [segment, child] of node.exactChildren.entries()) {
        if (clean(child)) {
          node.exactChildren.delete(segment);
        }
      }
      for (const [segment, child] of node.globChildren.entries()) {
        if (clean(child)) {
          node.globChildren.delete(segment);
        }
      }

      return !node.values && node.exactChildren.size === 0 && node.globChildren.size === 0;
    };

    clean(this.root);
  }
}

function segmentMatches(pattern: string, segment: string): boolean {
  if (pattern === segment) return true;
  if (!pattern.includes('*')) return false;

  const regex = new RegExp(
    '^' + pattern.split('*').map(escapeRegex).join('[^/]*') + '$',
    'i',
  );
  return regex.test(segment);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

class TrieNode<T> {
  exactChildren: Map<string, TrieNode<T>> = new Map();
  globChildren: Map<string, TrieNode<T>> = new Map();
  values?: T[];
}
```

### Helper: `isReceivingStatus`

Determines whether a node execution should remain in the subscription index:

```typescript
import type { NodeExecutionStatus } from '@hyperneo/shared';

const NON_RECEIVING_STATES: ReadonlySet<NodeExecutionStatus> = new Set([
  'cancelled',
]);

function isReceivingStatus(status: NodeExecutionStatus): boolean {
  return !NON_RECEIVING_STATES.has(status);
}
```

**Complexity**:
- Insert: O(k) where k = segment count (~4-5)
- Lookup: Effectively O(2^k × m) in the common case
- Memory: O(n × k) where n = number of subscriptions

## 7. Wiring the GitHub Extension

### Target architecture

The GitHub integration is extracted into a first-class event extension. It no longer depends on `SpaceGitHubService.ingest()`, `space.githubEvent.routed`, or Task Agent notification delivery.

```text
GitHub webhook / polling
    → GitHubEventExtension
        → check global + per-space enablement
        → verify signature / fetch API pages
        → normalize raw GitHub payload
        → construct topic + dedupeKey
        → ExternalEventService.publish(ExternalEvent)
            → ExternalEventStore.store() + retry-aware dedup
            → InternalEventBus.publish('externalEvent.published', ...)
                → Workflow runtime subscribers
                    → InternalCommandBus.dispatch('agent.message.inject', ...)
```

### Changes to existing code

**Extract source-specific GitHub code from `SpaceGitHubService`:**

- Move webhook normalization (`normalizeSpaceGitHubWebhook`) into `github-event-extension.ts` / `github-normalizer.ts`.
- Move polling normalization (`normalizePollingRow`) into `github-event-extension.ts` / `github-normalizer.ts`.
- Move watched-repo configuration access into `GitHubEventExtensionRepository` or keep the existing `space_github_watched_repos` table behind that repository.
- Move `space.github.watchRepo`, `space.github.listWatchedRepos`, and `space.github.pollOnce` registration behind `RpcExternalEventExtension.registerRpcHandlers(...)` as compatibility RPCs.
- Register `/webhook/github/space` through the extension route registry rather than hard-coding a direct call to `spaceGitHubService.handleWebhook(req)` in `app.ts`.

**Remove direct Task Agent injection:** the old `scheduleTaskNotification()` / `flushTaskNotification()` path is not invoked by the primary webhook or polling routes. New node-level delivery goes through the workflow runtime and `agent.message.inject` command.

### GitHub extension topic construction

| GitHub normalized kind | `mapEventType(kind, action)` returns |
|---|---|
| `issue_comment` | `pull_request.comment_${action}` (PR comments only) |
| `pull_request_review` | `pull_request.review_${action}` |
| `pull_request_review_comment` | `pull_request.review_comment_${action}` |
| `pull_request` | `pull_request.${action}` |

```typescript
function mapEventType(kind: string, action: string): string | null {
  switch (kind) {
    case 'issue_comment': return `pull_request.comment_${action}`;
    case 'pull_request_review': return `pull_request.review_${action}`;
    case 'pull_request_review_comment': return `pull_request.review_comment_${action}`;
    case 'pull_request': return `pull_request.${action}`;
    default: return null;
  }
}
```

### ExternalEvent construction

```typescript
function toExternalEvent(spaceId: string, event: NormalizedGitHubEvent): ExternalEvent {
  const repoOwner = event.repoOwner.toLowerCase();
  const repoName = event.repoName.toLowerCase();
  const resourceAction = mapEventType(event.eventType, event.action);
  if (!resourceAction) throw new Error(`Unsupported GitHub event type: ${event.eventType}`);

  return {
    id: crypto.randomUUID(),
    spaceId,
    topic: `github/${repoOwner}/${repoName}/${resourceAction}`,
    occurredAt: event.occurredAt,
    ingestedAt: Date.now(),
    source: 'github',
    sourceEventId: event.deliveryId,
    summary: event.summary,
    externalUrl: event.externalUrl,
    payload: {
      eventType: event.eventType,
      action: event.action,
      source: event.source,
      prUrl: event.prUrl,
      prNumber: event.prNumber,
      repoOwner,
      repoName,
      branch: event.branch,
      deliveryId: event.deliveryId,
      externalId: event.externalId,
      actor: event.actor,
      body: event.body,
      rawPayload: event.rawPayload,
    },
    dedupeKey: event.dedupeKey,
  };
}
```

## 8. Migration Path

### DB schema changes

1. **Core bus event store** (`space_external_events`): persistent source-level event lifecycle for retry-aware dedup.

   ```sql
   CREATE TABLE space_external_events (
     id TEXT PRIMARY KEY,
     space_id TEXT NOT NULL,
     source TEXT NOT NULL,
     topic TEXT NOT NULL,
     dedupe_key TEXT NOT NULL,
     occurred_at INTEGER NOT NULL,
     ingested_at INTEGER NOT NULL,
     payload_json TEXT NOT NULL,
     state TEXT NOT NULL DEFAULT 'published',
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     UNIQUE(space_id, source, dedupe_key)
   );
   ```

   `state` values are `published`, `delivered`, `failed`, and `ignored`. `routed_task_id` is intentionally NOT stored — task resolution is the workflow runtime's responsibility.

2. **Core bus delivery store** (`space_external_event_deliveries`): persistent per-subscription delivery lifecycle.

   ```sql
   CREATE TABLE space_external_event_deliveries (
     event_id TEXT NOT NULL,
     delivery_key TEXT NOT NULL,
     workflow_run_id TEXT NOT NULL,
     task_id TEXT NOT NULL,
     node_id TEXT NOT NULL,
     agent_name TEXT NOT NULL,
     state TEXT NOT NULL DEFAULT 'pending',
     delivered_at INTEGER,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY(event_id, delivery_key)
   );
   ```

3. **Extension configuration**: global and per-space source configuration tables (`external_event_source_configs`, `space_external_event_source_configs`).

4. **Extension-owned GitHub configuration**: reuse or migrate the existing `space_github_watched_repos` table behind `GitHubEventExtensionRepository`. This table remains source-specific and is not queried by the event pipeline.

5. **No workflow schema change**: event interests are not stored in `space_workflows.nodes[].agents[]`. Runtime subscriptions are created by gate/artifact scripts and agent tools for active workflow runs.

### Type changes

1. Add `EventInterest` interface to `packages/shared/src/types/space.ts` (topic pattern + label only, no scope).
2. Do not add `eventInterests` to `WorkflowNodeAgent`; static workflow definitions should remain source-agnostic and reusable.
3. Validate runtime subscription topic patterns with `validateGlobPattern()` when scripts or tools create subscriptions.

### New files

```
packages/daemon/src/lib/external-events/
  ├── types.ts                    # ExternalEvent, extension, publisher interfaces
  ├── external-event-service.ts   # ExternalEventService publishes externalEvent.published
  ├── external-event-store.ts     # Persistent retry-aware source-level dedup
  ├── extension-manager.ts        # Global/per-space enablement + route/RPC registration
  ├── extension-config-store.ts   # Global + per-space source config
  ├── topic-trie.ts               # TopicTrie<T> implementation (workflow-runtime utility)
  ├── topic-validator.ts          # validateGlobPattern() helper
  └── index.ts                    # Public exports

packages/daemon/src/lib/external-events/github/
  ├── github-event-extension.ts   # GitHub webhook/polling → ExternalEventService
  ├── github-normalizer.ts        # GitHub webhook/polling normalization helpers
  ├── github-repository.ts        # watched repo config + extension diagnostics
  └── index.ts
```

Note: No `external-event-router.ts` — subscription matching is a workflow-runtime concern.

### Wiring into daemon startup

```typescript
// In daemon startup:
const externalEventStore = new ExternalEventStore(db);
const externalEventService = new ExternalEventService(
  internalEventBus,
  externalEventStore,
);

const extensionContext: ExternalEventExtensionContext = {
  publisher: externalEventService,
  config: externalEventExtensionConfigStore,
  onSourceConfigChanged(change) {
    // Source config changes are extension concerns, not pipeline concerns.
  },
};

const extensions: ExternalEventExtension[] = [
  new GitHubEventExtension(new GitHubEventExtensionRepository(db)),
];

for (const extension of extensions) {
  const globalConfig = await extensionContext.config.getGlobalConfig(extension.sourceId);
  if (!globalConfig.globallyEnabled) continue;
  if ('routes' in extension) routeRegistry.register(extension.routes, extensionContext);
  if ('registerRpcHandlers' in extension) extension.registerRpcHandlers(messageHub, extensionContext);
  await extension.start(extensionContext);
}
```

The workflow runtime (not the event pipeline) subscribes to `externalEvent.published`, matches topic patterns against active runtime subscription records, and dispatches `agent.message.inject` for matched events.

### Phased rollout

**Phase 1 (target MVP):**
- Add the shared `EventInterest` runtime subscription type.
- Implement `ExternalEventService`, `ExternalEventStore`, `TopicTrie`.
- Implement `ExternalEventExtension` interfaces and a minimal extension manager/config store.
- Extract `GitHubEventExtension` as the primary GitHub event source.
- Route GitHub PR events through `ExternalEventService` → `InternalEventBus` → workflow runtime subscription matching.

**Phase 2 (workflow-runtime hardening):**
- Keep `/webhook/github/space` and `space.github.pollOnce` on `GitHubEventExtension`; they no longer invoke `SpaceGitHubService.ingest()` or direct Task Agent notification delivery.
- Migrate remaining `space.github.*` RPC handling into `GitHubEventExtension`.
- Add persistent per-node delivery queue if restart-safe pending-node delivery is required.

**Phase 3 (future extensibility):**
- Slack, Jira, CI extensions.
- Custom extension API.
- UI for extension configuration.

## 9. Relationship to Existing Systems

| Existing system | Relationship |
|---|---|
| **InternalEventBus** | Carries the internal fact `externalEvent.published`. It does not persist external events; durability remains in `ExternalEventStore`. |
| **InternalCommandBus** | Owns the `agent.message.inject` command used by the workflow runtime to deliver events into agent sessions. |
| **MessageHub** | Remains client/RPC transport infrastructure for extension configuration RPCs. |
| **GitHubService** (Room pipeline) | Unchanged for Room compatibility. |
| **SpaceGitHubService** (legacy Space pipeline) | Retained only for explicit legacy diagnostics/tests and watched-repo compatibility helpers. Source-specific webhook/polling logic is extracted into `GitHubEventExtension`; primary delivery moves to workflow runtime. Direct Task Agent notification methods are not invoked by webhook or polling routes. |
| **GitHubEventExtension** | Source extension that owns GitHub webhook verification, polling, normalization, and direct publication to `ExternalEventService`. |
| **ExternalEventStore** | Core persistence and retry-aware source-level dedup across extensions. |

## 10. Key Design Decisions

### Why InternalEventBus instead of a source-specific hub?

The broader messaging refactor introduces `InternalEventBus` as the daemon-side semantic event layer. External source events should use that layer instead of introducing another generic bus or making GitHub own delivery semantics.

### Why deliver through `agent.message.inject` instead of AgentMessageRouter?

AgentMessageRouter is designed for agent-to-agent communication with channel topology authorization. External events are system-injected context, not agent-originated messages. The target design uses `InternalCommandBus.dispatch('agent.message.inject', ...)` so delivery remains explicit, testable, and observable.

### Why trie-based matching instead of regex?

1. **Performance**: Trie lookup walks O(2^k) paths; regex is O(n) per event.
2. **Composability**: Trie supports incremental add/remove; regex requires rebuilding.
3. **Debuggability**: Trie structure can be inspected; regex patterns are opaque.

### Why not extend SpaceGitHubService directly?

`SpaceGitHubService` mixes GitHub source ingestion, dedup, PR-to-task resolution, and session injection. The target architecture splits these: `GitHubEventExtension` owns source concerns, `ExternalEventStore` owns dedup, workflow runtime owns subscription matching and delivery.

### Why remove task resolution from the event pipeline?

The original design embedded `ExternalEventTaskResolver` inside `ExternalEventService`, which coupled the event pipeline to the task system. The simplified design keeps `ExternalEvent` as a pure normalization layer with opaque payload and removes `routed_task_id` from the schema.

### Why no ExternalEventRouter?

The original design included an `ExternalEventRouter` with scope filtering, watched-repo lookups, and delivery retry. This was wrong because:

1. **Scope is domain-specific** — `repo` scope is a GitHub concept. A Slack source has workspaces/channels, not repos. Scope filtering in the pipeline couples it to specific sources.
2. **Topic patterns are sufficient** — the 4-segment topic already encodes source, owner, repo. No additional scope layer is needed.
3. **Delivery retry is a workflow concern** — the workflow runtime knows about node sessions, idle states, and pending queues. The event pipeline should not.

## 11. Testing Strategy

### Unit tests

1. **TopicTrie**: Insert patterns, verify lookup returns correct values for exact and wildcard matches.
2. **ExternalEventStore**: Verify terminal duplicates are short-circuited, retryable duplicates are re-emitted, delivery lifecycle advances correctly.
3. **ExternalEventService**: Verify validation, dedup, and publication without task resolution or scope filtering.
4. **GitHubEventExtension**: Given webhook and polling payloads, verify enablement checks, topic construction, dedupe keys, and `ExternalEvent` construction.
5. **Topic pattern matching only**: Test topic-pattern matching (no scope filtering). Verify `github/lsm/neokai/pull_request.*` matches PR events for that repo, `github/*/*/pull_request.*` matches all repos.

### Integration tests

1. **End-to-end webhook flow**: POST a GitHub webhook payload. Verify the extension publishes the correct topic, and the coder node's subscription receives an injected message.

2. **Dedup across webhook + polling**: Publish the same event through both paths. Verify source-level dedup prevents duplicate bus events.

3. **Wake-on-idle delivery**: Set node execution to `idle`. Emit matching event. Verify `injectMessage` is called with `deliveryMode: 'defer'`.

4. **Pending node queuing**: Emit event for `pending` node. Verify event is queued and flushed when session is created.
