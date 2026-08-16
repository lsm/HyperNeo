/**
 * Session RPC Handlers
 *
 * ARCHITECTURE: Follows the 3-layer communication pattern:
 * - RPC handlers do minimal work and return fast (<100ms)
 * - Heavy operations are deferred to EventBus subscribers
 * - State updates are broadcast via State Channels
 */

import type {
  ImageContent,
  ListRuntimeMcpServersRequest,
  ListRuntimeMcpServersResponse,
  MessageContent,
  MessageDeliveryMode,
  MessageHub,
  MessageImage,
  ModelInfo,
  Session,
  SessionMetadata,
  HyperNeoActionMessage,
  RuntimeMcpServerEntry,
} from '@hyperneo/shared';
import { normalizeThinkingLevel } from '@hyperneo/shared';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
import { appendDraftText, generateUUID } from '@hyperneo/shared';
import type { SessionManager } from '../session-manager';
import type { CreateSessionRequest, UpdateSessionRequest } from '@hyperneo/shared';
import { isSDKUserMessage } from '@hyperneo/shared/sdk/type-guards';
import {
  clearModelsCache,
  hasRefreshBeenAttemptedFor,
  markRefreshAttemptedFor,
} from '../model-service.js';
import { getProviderRegistry } from '../providers/registry.js';
import { deliverAndMarkQueued, isMessageDeliveryV2Enabled } from '../agent/message-delivery';
import {
  archiveSDKSessionFiles,
  deleteSDKSessionFiles,
  scanSDKSessionFiles,
  identifyOrphanedSDKFiles,
} from '../sdk-session-file-manager';
import type { SpaceManager } from '../space/managers/space-manager';
import type { SpaceRuntimeService } from '../space/runtime/space-runtime-service';
import { Logger } from '../logger';

const log = new Logger('session-handlers');

/**
 * Hard cap on each stranded-provider availability probe. Some providers
 * (notably local Ollama) perform an unbounded `fetch` in `isAvailable()`; this
 * keeps a stalled/unreachable endpoint from blocking `models.list` on the warm
 * cached-response path.
 */
const STRANDED_PROBE_TIMEOUT_MS = 3000;

/**
 * How long a voice-append dedup id stays recognizable (see
 * session.appendVoiceDraft). The client outbox expires an entry 24h after it
 * ENQUEUES — which happens after the staging RPC rejects — while the daemon
 * logs the id at COMMIT time, strictly earlier. The margin covers that
 * ambiguity window (a staging timeout plus requeue latency), so the id
 * outlives every retry the client can still issue.
 */
const VOICE_APPEND_LOG_TTL_MS = 24 * 60 * 60 * 1000 + 5 * 60 * 1000;

function raceWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Detect registered-and-available providers whose models are absent from a
 * non-empty model cache (i.e. "stranded"). Used by `models.list` to self-heal a
 * stale cache without trusting it indefinitely within its TTL.
 *
 * Only providers that are both missing from `cachedModels` AND not already
 * probed in this cache's lifetime are checked, so the steady-state cost is
 * bounded to a single `isAvailable()` call per missing provider per cache
 * lifetime. Every probed provider is marked attempted (via
 * `markRefreshAttemptedFor`) so it is not re-probed on the next call — this is
 * what prevents a refresh storm when a connected provider's `getModels()`
 * persistently fails.
 *
 * Each probe is capped at `probeTimeoutMs` so a provider whose
 * `isAvailable()` never resolves (e.g. local Ollama with an unreachable
 * `OLLAMA_BASE_URL`) is treated as unavailable instead of blocking the
 * response.
 *
 * Returns the IDs of the probed providers that are available (the caller
 * refreshes the cache when this is non-empty).
 */
export async function detectStrandedProviders(
  cachedModels: ModelInfo[],
  probeTimeoutMs: number = STRANDED_PROBE_TIMEOUT_MS
): Promise<string[]> {
  const cachedProviders = new Set(
    cachedModels.map((m) => m.provider).filter((p): p is string => !!p)
  );
  const toProbe = getProviderRegistry()
    .getAll()
    .filter((p) => !cachedProviders.has(p.id) && !hasRefreshBeenAttemptedFor(p.id));
  if (toProbe.length === 0) return [];
  // Claim the providers BEFORE awaiting their probes. The filter + mark run
  // synchronously (no await between them), so on the single-threaded event loop
  // a concurrent models.list call reaching this point afterward sees these
  // providers as already attempted and skips them — preventing duplicate probes
  // and duplicate refreshModels() fan-out when several pickers list at once.
  markRefreshAttemptedFor(toProbe.map((p) => p.id));
  const stranded: string[] = [];
  await Promise.all(
    toProbe.map(async (provider) => {
      try {
        const available = await raceWithTimeout(
          Promise.resolve(provider.isAvailable()),
          probeTimeoutMs
        );
        if (available === true) stranded.push(provider.id);
      } catch {
        // isAvailable() probe rejected — treat as unavailable; don't refresh.
      }
    })
  );
  return stranded;
}

function extractMessageText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((block) => {
      if (typeof block !== 'object' || block === null) return '';
      const record = block as Record<string, unknown>;
      if (record.type === 'text' && typeof record.text === 'string') {
        return record.text;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function toReplayContent(
  content: string | Array<{ type: string; text?: string }>
): string | MessageContent[] | null {
  if (typeof content === 'string') {
    return content || null;
  }

  if (Array.isArray(content)) {
    if (content.some((block) => block.type !== 'text')) {
      return content as MessageContent[];
    }

    const textContent = content
      .filter(
        (block): block is { type: 'text'; text: string } => block.type === 'text' && !!block.text
      )
      .map((block) => block.text)
      .join('\n');
    return textContent || null;
  }

  return null;
}

export function setupSessionHandlers(
  messageHub: MessageHub,
  sessionManager: SessionManager,
  internalEventBus: InternalEventBus<DaemonInternalEventMap>,
  spaceManager: SpaceManager,
  spaceRuntimeService?: SpaceRuntimeService
): void {
  messageHub.onRequest('session.create', async (data) => {
    const req = data as CreateSessionRequest;
    if (
      req.worktreeMode !== undefined &&
      req.worktreeMode !== 'worktree' &&
      req.worktreeMode !== 'direct'
    ) {
      throw new Error(
        `Invalid worktreeMode: ${String(req.worktreeMode)}. Must be 'worktree' or 'direct'`
      );
    }

    const sessionId = await sessionManager.createSession({
      workspacePath: req.workspacePath,
      initialTools: req.initialTools,
      config: req.config,
      worktreeBaseBranch: req.worktreeBaseBranch,
      worktreeMode: req.worktreeMode,
      title: req.title,
      spaceId: req.spaceId,
      createdBy: req.createdBy ?? 'human',
    });

    // Add session to space if spaceId is provided
    if (req.spaceId) {
      const updatedSpace = await spaceManager.addSession(req.spaceId, sessionId);
      internalEventBus
        .publish('space.updated', {
          sessionId: 'global',
          spaceId: req.spaceId,
          space: updatedSpace,
        })
        .catch(() => {});
    }

    // Return the full session object so client can optimistically update
    const agentSession = sessionManager.getSession(sessionId);
    const session = agentSession?.getSessionData();

    // Attach space-agent-tools synchronously for ad-hoc Space sessions.
    // Doing this via the internalEventBus 'session.created' event would be racy:
    // the query can start (and freeze its MCP config) before the event
    // handler completes. Mirrors the pattern space-handlers.ts uses for
    // setupSpaceAgentSession on space.create.
    if (session && session.context?.spaceId && spaceRuntimeService) {
      try {
        await spaceRuntimeService.attachSpaceToolsToMemberSession(session);
      } catch (err) {
        log.warn(
          `Failed to attach space tools to session ${sessionId} (space ${session.context.spaceId}):`,
          err
        );
      }
    }

    // Broadcast to internalEventBus so other subscribers (StateManager, etc.) can react.
    // Kept for non-critical side effects; critical attachment above is synchronous.
    if (session) {
      internalEventBus.publish('session.created', { sessionId, session }).catch(() => {});
    }

    return { sessionId, session };
  });

  /**
   * List runtime-attached (in-process, SDK-type) MCP servers for a session.
   *
   * These are servers injected by SpaceRuntimeService, TaskAgentManager, and
   * similar subsystems via `mergeRuntimeMcpServers`. They never appear in the
   * skills registry or in file-based MCP settings, so the chat composer's
   * Tool Modal needs a separate path to surface them.
   *
   * Truth-based: reads the live `session.config.mcpServers` map and filters
   * to entries with `type === 'sdk'`. Anything future subsystems attach (e.g.
   * room-tools, coordinator-agents) will show up automatically.
   */
  messageHub.onRequest('session.listRuntimeMcpServers', async (data) => {
    const { sessionId } = data as ListRuntimeMcpServersRequest;
    const agentSession = await sessionManager.getSessionAsync(sessionId);
    if (!agentSession) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const mcpServers = agentSession.getSessionData().config?.mcpServers;
    const servers: RuntimeMcpServerEntry[] = [];
    if (mcpServers) {
      for (const [name, config] of Object.entries(mcpServers)) {
        // Only report in-process SDK-type servers. stdio/sse/http entries
        // are user-managed subprocess MCPs surfaced through config.mcp.get
        // and the file-MCP UI path.
        if ((config as { type?: string } | undefined)?.type === 'sdk') {
          servers.push({ name });
        }
      }
    }

    return { servers } satisfies ListRuntimeMcpServersResponse;
  });

  /**
   * Set worktree mode for a session
   * Called when user makes their choice in the worktree choice modal
   */
  messageHub.onRequest('session.setWorktreeMode', async (data) => {
    const { sessionId, mode } = data as { sessionId: string; mode: 'worktree' | 'direct' };

    // Validate input
    if (!sessionId || !mode) {
      throw new Error('Missing required fields: sessionId and mode');
    }

    if (mode !== 'worktree' && mode !== 'direct') {
      throw new Error(`Invalid mode: ${mode}. Must be 'worktree' or 'direct'`);
    }

    // Get session lifecycle from session manager
    const sessionLifecycle = sessionManager.getSessionLifecycle();

    // Complete worktree choice
    const updatedSession = await sessionLifecycle.completeWorktreeChoice(sessionId, mode);

    // Broadcast update to all clients
    messageHub.event('session.updated', updatedSession, {
      channel: `session:${sessionId}`,
    });

    return { success: true, session: updatedSession };
  });

  /**
   * Set workspace on an existing session (inline workspace selector flow)
   * Called when user selects a workspace via the inline WorkspaceSelector in chat
   */
  messageHub.onRequest('session.setWorkspace', async (data) => {
    const { sessionId, workspacePath, worktreeMode } = data as {
      sessionId: string;
      workspacePath: string;
      worktreeMode: 'worktree' | 'direct';
    };

    if (!sessionId || !workspacePath || !worktreeMode) {
      throw new Error('Missing required fields: sessionId, workspacePath, and worktreeMode');
    }

    if (worktreeMode !== 'worktree' && worktreeMode !== 'direct') {
      throw new Error(`Invalid worktreeMode: ${worktreeMode}. Must be 'worktree' or 'direct'`);
    }

    const sessionLifecycle = sessionManager.getSessionLifecycle();
    const updatedSession = await sessionLifecycle.setWorkspace(
      sessionId,
      workspacePath,
      worktreeMode
    );

    // Broadcast update to all clients
    messageHub.event('session.updated', updatedSession, {
      channel: `session:${sessionId}`,
    });

    return { success: true, session: updatedSession };
  });

  messageHub.onRequest(
    'session.list',
    async (data: { status?: string; includeArchived?: boolean } | undefined) => {
      const sessions = sessionManager.listSessions({
        status: data?.status,
        includeArchived: data?.includeArchived,
      });
      return { sessions };
    }
  );

  messageHub.onRequest('session.get', async (data) => {
    const { sessionId: targetSessionId } = data as { sessionId: string };
    const agentSession = await sessionManager.getSessionAsync(targetSessionId);

    if (!agentSession) {
      throw new Error('Session not found');
    }

    // Consume any staged voice transcript atomically: merge
    // inputDraftVoicePending into inputDraft and clear the staging field in one
    // synchronous write. Doing the merge server-side (rather than in the
    // client's debounced useInputDraft hook) means there is a single writer and
    // no window for a stale client snapshot or a cancelled debounce to lose the
    // transcript. The client just reads inputDraft, already merged. See
    // session.appendVoiceDraft for how the pending field is populated.
    // The staging field is cleared ONLY when the entire staged value merged: a
    // draft already at the character limit truncates it, and clearing then
    // would deterministically lose the transcript the client's toast promised
    // was saved — retain it instead so it survives until there is room.
    const beforeMerge = agentSession.getSessionData();
    const voicePending = beforeMerge.metadata?.inputDraftVoicePending;
    if (voicePending && voicePending.trim()) {
      const draft = beforeMerge.metadata?.inputDraft ?? '';
      const merged = appendDraftText(draft, voicePending);
      const fullyMerged =
        merged === `${draft}${voicePending}` || merged === `${draft} ${voicePending}`;
      // Only consume on a FULL merge. On a partial fit, write nothing and keep
      // the staged transcript: writing the prefix would duplicate it once room
      // appears and the merge retries.
      if (fullyMerged) {
        await sessionManager.updateSession(targetSessionId, {
          metadata: {
            inputDraft: merged,
            inputDraftVoicePending: null,
            inputDraftVersion: (beforeMerge.metadata?.inputDraftVersion ?? 0) + 1,
            // Stamp the version the LANDING'S OWN MERGE produced: a later
            // version movement past this mark is a subsequent folded write
            // (a stale save the folding branch re-anchored), not the merge —
            // mergeVoiceDraftBackup's stale-claim guard allows a mismatch
            // only while the current version still IS the merge's.
            inputDraftVoiceMergedVersion: (beforeMerge.metadata?.inputDraftVersion ?? 0) + 1,
          },
        } as Partial<Session>);
      }
    }

    const session = agentSession.getSessionData();

    return {
      session,
      activeTools: [],
      // File/workspace context (for display purposes)
      context: {
        files: [],
        workingDirectory: session.worktree?.worktreePath ?? session.workspacePath ?? null,
      },
      // Context info is in session.metadata.lastContextInfo
    };
  });

  // FIX: Session health check to detect and report stuck sessions
  // Use case: Diagnose sessions that can't be loaded (zombie sessions)
  // Returns: valid (boolean), error (string if invalid)
  messageHub.onRequest('session.validate', async (data) => {
    const { sessionId: targetSessionId } = data as { sessionId: string };
    try {
      const agentSession = await sessionManager.getSessionAsync(targetSessionId);
      return { valid: agentSession !== null, error: null };
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  /**
   * Return MCP servers injected from enabled skills for the given session.
   * Reflects the AppMcpServer.enabled flag: disabled servers are excluded even
   * if the wrapping skill is enabled. Useful for testing and debugging injection.
   */
  messageHub.onRequest('session.getSkillMcpServers', async (data) => {
    const { sessionId: targetSessionId } = data as { sessionId: string };
    const agentSession = await sessionManager.getSessionAsync(targetSessionId);
    if (!agentSession) {
      throw new Error(`Session not found: ${targetSessionId}`);
    }
    const servers = agentSession.optionsBuilder.getSkillMcpServers();
    return { servers };
  });

  messageHub.onRequest('session.update', async (data, _ctx) => {
    const {
      sessionId: targetSessionId,
      expectedDraftVersion,
      ...updates
    } = data as UpdateSessionRequest & {
      sessionId: string;
      expectedDraftVersion?: number;
    };

    // A draft write while a voice pending sequence is STAGED must refresh the
    // sequence's BASELINE snapshot: the pending eventually merges onto
    // whatever draft is current at merge time, and a stale baseline would make
    // reconciliation treat concurrently-typed text as transcript (restoring it
    // twice, or preserving already-sent text through a strip). The pending
    // itself lives in a separate field this update never touches, so a plain
    // metadata write here only re-anchors the merge point.
    const draftWrite = (updates.metadata as Partial<SessionMetadata> | undefined)?.inputDraft;
    // Whether this write took the transcript-folding branch (its ack carries
    // the applied value so the client can adopt it).
    let didFold = false;
    // A fold REFUSED because the transcripts cannot fit whole: the merged
    // draft is retained untouched. The ack marks the refusal (`foldRefused`)
    // so the client keeps its local content and its STALE version cache
    // instead of adopting the retained draft — the sent text was never
    // persisted, and advancing the cache would let the client's next save
    // apply as-is and clear the baseline, deleting the transcripts.
    let foldRefused = false;
    let retainedFoldValue: string | null = null;
    let retainedFoldVersion: number | undefined;
    if (draftWrite !== undefined) {
      const existing = sessionManager.getSessionFromDB(targetSessionId);
      const meta = existing?.metadata;
      if ((meta?.inputDraftVoicePending ?? '').trim() !== '') {
        (updates.metadata as Partial<SessionMetadata>).inputDraftVoiceBaseline = draftWrite ?? '';
        (updates.metadata as Partial<SessionMetadata>).inputDraftVersion =
          (meta?.inputDraftVersion ?? 0) + 1;
      } else if (typeof meta?.inputDraftVoiceBaseline === 'string') {
        // MERGED but still unreconciled (the baseline snapshot lingers after
        // the pending cleared): the draft holds baseline + transcripts, and a
        // STALE save — started before the merge landed — would overwrite the
        // transcripts outright (the dedup id only stops a replay, not this).
        // Whether the write already carries the transcripts is decided by the
        // DRAFT VERSION it echoes: the daemon bumps inputDraftVersion on every
        // draft mutation, so a writer that read the merged draft holds the
        // current version and is applied as-is, while a stale writer (absent
        // or older version — or one that coincidentally ends with the same
        // phrase, which a suffix comparison cannot tell apart) gets the
        // transcripts folded in.
        const baseline = meta.inputDraftVoiceBaseline;
        const draft = meta.inputDraft ?? '';
        let transcripts = '';
        if (draft.startsWith(`${baseline} `)) transcripts = draft.slice(baseline.length + 1);
        else if (draft.startsWith(baseline)) transcripts = draft.slice(baseline.length);
        const currentVersion = meta.inputDraftVersion ?? 0;
        const alreadyIncluded =
          expectedDraftVersion !== undefined && expectedDraftVersion === currentVersion;
        const written = draftWrite ?? '';
        const folded = alreadyIncluded
          ? written
          : transcripts
            ? appendDraftText(written, transcripts)
            : written;
        // The COMPLETE combination must fit, exactly as the pending merge and
        // backup-merge paths require: appendDraftText silently slices at the
        // character limit, `inputDraftVoicePending` is already cleared by the
        // merge, and persisting a truncated fold would irrecoverably drop the
        // transcript's tail while reporting success. A stale write too long
        // for the transcripts to fit is REFUSED instead — the merged draft
        // stays authoritative, the ack marks the refusal, and the client
        // keeps its unsaved text and stale version cache.
        const foldFits =
          alreadyIncluded ||
          !transcripts ||
          folded === `${written}${transcripts}` ||
          folded === `${written} ${transcripts}`;
        if (!foldFits) {
          delete (updates.metadata as Partial<SessionMetadata>).inputDraft;
          didFold = true; // the ack below carries the retained merged value
          foldRefused = true;
          retainedFoldValue = draft;
          retainedFoldVersion = currentVersion;
        } else {
          (updates.metadata as Partial<SessionMetadata>).inputDraft = folded || null;
        }
        // A version-current writer read the merged draft — its write IS the
        // reconciliation, so the snapshot clears. A STALE writer's fold instead
        // RE-ANCHORS the baseline to its (pre-merge) content with the sequence
        // id intact: the folded draft is again exactly baseline + transcripts,
        // so an in-flight or retrying clear's strip still recognizes the
        // sequence and reduces the draft to the transcripts alone — clearing
        // here would strand the strip (declined on the vanished snapshot) and
        // resurrect text the user had sent or cleared. (A REFUSED fold above
        // skips all of this: the merged draft and its snapshot are retained
        // untouched.)
        if (foldFits) {
          if (alreadyIncluded) {
            (updates.metadata as Partial<SessionMetadata>).inputDraftVoiceBaseline = null;
          } else {
            (updates.metadata as Partial<SessionMetadata>).inputDraftVoiceBaseline = written;
            didFold = true;
          }
          (updates.metadata as Partial<SessionMetadata>).inputDraftVersion = currentVersion + 1;
        }
      } else {
        // A plain draft write (no sequence involved) still bumps the version
        // so OTHER tabs' in-flight saves become recognizably stale.
        const currentVersion = meta?.inputDraftVersion ?? 0;
        (updates.metadata as Partial<SessionMetadata>).inputDraftVersion = currentVersion + 1;
      }
    }

    // Get roomId before updating to include in event payload
    const agentSessionForUpdate = sessionManager.getSession(targetSessionId);
    const roomIdForUpdate = agentSessionForUpdate?.getSessionData().context?.roomId;

    // Convert UpdateSessionRequest to Partial<Session>
    // config in UpdateSessionRequest is Partial<SessionConfig>, which is handled by
    // database.updateSession merging with existing config
    await sessionManager.updateSession(targetSessionId, updates as Partial<Session>);

    const updatedPayload = { ...updates, sessionId: targetSessionId, roomId: roomIdForUpdate };

    // Broadcast update event on session channel for per-session subscribers
    messageHub.event('session.updated', updatedPayload, {
      channel: `session:${targetSessionId}`,
    });

    // Room channel broadcasts removed with legacy Room feature retirement.

    // Echo the applied version when this write bumped it, so the client
    // advances its cached version on the acknowledgement — without it, every
    // later edit from that composer would echo the pre-write version and be
    // misclassified as stale (folded) by the daemon. A FOLDED write also
    // returns the applied VALUE: the caller must either adopt it (its local
    // content lacks the transcripts) or deliberately keep its version cache
    // stale — advancing without adopting would let its next edit apply as-is
    // and clear the baseline, deleting the transcript from the draft.
    const appliedMeta = (updates.metadata as Partial<SessionMetadata> | undefined) ?? {};
    const appliedVersion = appliedMeta.inputDraftVersion ?? retainedFoldVersion;
    return {
      success: true,
      ...(appliedVersion !== undefined ? { draftVersion: appliedVersion } : {}),
      ...(foldRefused ? { foldRefused: true } : {}),
      ...(didFold ? { draftValue: appliedMeta.inputDraft ?? retainedFoldValue ?? '' } : {}),
    };
  });

  // Stage a voice transcript that completed AFTER its composer unmounted (the
  // user navigated to another session mid-transcription) into a dedicated
  // `inputDraftVoicePending` metadata field. We must NOT write the live
  // inputDraft: the client's debounced draft save (useInputDraft) can still be
  // holding a stale local snapshot and would clobber an append made to
  // inputDraft. A separate field is never touched by those saves, so the
  // transcript survives until useInputDraft merges it into the draft once on
  // load. The read→write is one synchronous step (getFromDB + updateSession's
  // DB write both run before the first `await`), so concurrent writers cannot
  // interleave. Returns success/failure so the client's toast is honest.
  messageHub.onRequest('session.appendVoiceDraft', async (data, _ctx) => {
    const { sessionId, text, dedupId } = data as {
      sessionId: string;
      text: string;
      dedupId?: string;
    };
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new Error('Text to append is required');
    }
    const session = sessionManager.getSessionFromDB(sessionId);
    if (!session) throw new Error('Session not found');
    const metadata = session.metadata ?? {};
    // Idempotent replay guard for the client's durable outbox: the socket can
    // drop just after a successful write but before the ack, and a retry would
    // merge the transcript a second time. Skip when this entry's id already
    // merged. A LOG of timestamped ids (not just the last id) is retained so an
    // out-of-order replay — two tabs flushing the shared outbox, or an entry
    // that timed out after committing and is retried after a later one
    // committed — still dedups. Entries are kept for the client outbox's retry
    // lifetime (24h), NOT a small count cap: an entry can remain retryable for
    // that whole window while unrelated direct appends flow in, and a count
    // bound alone would evict its id and let the eventual replay double-append.
    // Only consulted when the client passes a dedupId; the live one-shot
    // staging path passes none and behaves exactly as before. The read→write
    // stays one synchronous step (no await between the check and the
    // updateSession DB write), so concurrent writers cannot interleave.
    const appendLogTtlCutoff = Date.now() - VOICE_APPEND_LOG_TTL_MS;
    const processedLog = (metadata.inputDraftVoiceAppendLog ?? []).filter(
      (entry) =>
        typeof entry?.id === 'string' &&
        typeof entry?.ts === 'number' &&
        entry.ts > appendLogTtlCutoff
    );
    if (dedupId && processedLog.some((entry) => entry.id === dedupId)) {
      // The replay's ack carries the ORIGINAL commit's sequence so the client
      // still learns the daemon's ordering for an entry whose first
      // acknowledgement was lost.
      const committed = processedLog.find((entry) => entry.id === dedupId);
      return {
        success: true,
        deduped: true,
        ...(typeof committed?.seq === 'number' ? { seq: committed.seq } : {}),
      };
    }
    const existingPending = metadata.inputDraftVoicePending ?? '';
    const pending = appendDraftText(existingPending, text);
    // Reject (rather than silently truncate) when the staged value is at the
    // character limit and the new transcript cannot fit whole — the client
    // reports the failure instead of claiming a save that dropped its tail.
    const fits =
      pending === `${existingPending}${text}` || pending === `${existingPending} ${text}`;
    if (!fits) throw new Error('Pending voice draft is at the character limit');
    const metadataUpdate: Partial<SessionMetadata> = { inputDraftVoicePending: pending };
    // DAEMON COMMIT ORDER for this entry: acknowledgements can publish out of
    // order across entries (a slower first append committing before a faster
    // second one whose ack lands first), and a client aggregate ordered by
    // arrival would then diverge from the merged draft it must tail-match
    // during reconciliation. The monotonic counter (not the log length, which
    // the TTL prunes) stamps every entry's true commit position.
    const commitSeq = (metadata.inputDraftVoiceAppendCounter ?? 0) + 1;
    if (!existingPending.trim()) {
      // A NEW pending sequence starts here: snapshot the draft it will merge
      // onto, tagged with a fresh sequence id. The daemon is the single writer
      // of the merge, so this baseline is the EXACT pre-sequence draft —
      // regardless of which tabs appended entries or which tab's get performs
      // the merge. session.get responses carry it so clients can structurally
      // separate the transcripts from the stale baseline, and
      // session.stripVoiceBaseline removes it on request — validated against
      // the SEQUENCE id too, since a newer sequence can replace the baseline
      // while leaving the draft text itself unchanged.
      metadataUpdate.inputDraftVoiceBaseline = metadata.inputDraft ?? '';
      metadataUpdate.inputDraftVoiceBaselineSeq = (metadata.inputDraftVoiceBaselineSeq ?? 0) + 1;
    }
    if (dedupId) {
      // Append after the TTL filter above prunes expired ids. NO count cap:
      // logged ids come only from outbox flushes (each tab's outbox holds at
      // most 20 entries), so growth within the TTL is inherently bounded —
      // and a count cap could evict an id whose outbox entry is still
      // retryable, letting its eventual replay double-append.
      metadataUpdate.inputDraftVoiceAppendLog = [
        ...processedLog,
        { id: dedupId, ts: Date.now(), seq: commitSeq },
      ];
    }
    metadataUpdate.inputDraftVoiceAppendCounter = commitSeq;
    const updates: UpdateSessionRequest = { metadata: metadataUpdate };
    await sessionManager.updateSession(sessionId, updates as Partial<Session>);
    messageHub.event(
      'session.updated',
      { ...updates, sessionId },
      {
        channel: `session:${sessionId}`,
      }
    );
    return { success: true, seq: commitSeq };
  });

  // Atomically clear the input draft ONLY if it still equals `expected`. The
  // unmounted voice send uses this to consume its click-time draft snapshot
  // without wiping newer edits persisted after the snapshot (the user reopened
  // the session, or another client saved). Read+write is one synchronous step
  // (getFromDB + updateSession's DB write both run before the first `await`),
  // so no concurrent draft save can land between the comparison and the clear.
  messageHub.onRequest('session.clearInputDraftIf', async (data, _ctx) => {
    const { sessionId, expected } = data as { sessionId: string; expected: string };
    if (typeof expected !== 'string') throw new Error('Expected draft value is required');
    const session = sessionManager.getSessionFromDB(sessionId);
    if (!session) throw new Error('Session not found');
    if ((session.metadata?.inputDraft ?? '').trim() !== expected.trim()) {
      return { cleared: false };
    }
    // A staged voice sequence re-anchors its baseline to the CLEARED draft:
    // the pending merges onto the (now empty) draft at the next session.get,
    // and a baseline still naming the old non-empty draft would make every
    // later reconciliation extract no transcript — letting a stale
    // session.update overwrite the only merged copy after the pending field
    // cleared.
    const staged = (session.metadata?.inputDraftVoicePending ?? '').trim() !== '';
    const updates: UpdateSessionRequest = {
      metadata: {
        inputDraft: null,
        ...(staged ? { inputDraftVoiceBaseline: '' } : {}),
        inputDraftVersion: (session.metadata?.inputDraftVersion ?? 0) + 1,
      },
    };
    await sessionManager.updateSession(sessionId, updates as Partial<Session>);
    messageHub.event(
      'session.updated',
      { ...updates, sessionId },
      {
        channel: `session:${sessionId}`,
      }
    );
    return { cleared: true };
  });

  // Atomically strip the pre-sequence baseline from the input draft, keeping
  // only the merged voice transcripts — the EXACT server-side counterpart of
  // the client's clear-before-merge reconciliation. The baseline snapshot (see
  // session.appendVoiceDraft) makes this precise: the merged draft is always
  // baseline + pending (joined by appendDraftText), so removing the baseline
  // prefix keeps EVERY transcript of the sequence regardless of which client
  // knows which entry landed. Conditional on BOTH the draft text the client
  // just read (`expected` — a NEWER draft saved by another client is never
  // stomped) and the SEQUENCE id it observed (`expectedSeq` — a newer sequence
  // can replace the baseline while leaving the draft text unchanged, and
  // stripping then would clear the merged transcript the caller meant to
  // keep). Read+write is one synchronous step, like clearInputDraftIf.
  messageHub.onRequest('session.stripVoiceBaseline', async (data, _ctx) => {
    const { sessionId, expected, expectedSeq } = data as {
      sessionId: string;
      expected: string;
      expectedSeq?: number;
    };
    if (typeof expected !== 'string') throw new Error('Expected draft value is required');
    const session = sessionManager.getSessionFromDB(sessionId);
    if (!session) throw new Error('Session not found');
    const metadata = session.metadata ?? {};
    const baseline = metadata.inputDraftVoiceBaseline;
    const draft = metadata.inputDraft ?? '';
    if (
      typeof baseline !== 'string' ||
      typeof expectedSeq !== 'number' ||
      metadata.inputDraftVoiceBaselineSeq !== expectedSeq ||
      draft.trim() !== expected.trim()
    ) {
      return { updated: false };
    }
    // Mirror appendDraftText's joining so the remainder is exactly the
    // transcripts (no leading separator).
    let value: string;
    if (draft === baseline) value = '';
    else if (draft.startsWith(`${baseline} `)) value = draft.slice(baseline.length + 1);
    else if (draft.startsWith(baseline)) value = draft.slice(baseline.length);
    else return { updated: false }; // draft diverged from the snapshot
    // Record WHICH sequence was stripped: a strip whose acknowledgement was
    // lost leaves the client still owing its clear, and its retry must
    // recognize the transcript-only draft as already-stripped rather than
    // clearing it as a sequence that never merged.
    const updates: UpdateSessionRequest = {
      metadata: {
        inputDraft: value || null,
        inputDraftVoiceBaseline: null,
        inputDraftVoiceLastStrippedSeq: expectedSeq,
        inputDraftVersion: (metadata.inputDraftVersion ?? 0) + 1,
      },
    };
    await sessionManager.updateSession(sessionId, updates as Partial<Session>);
    messageHub.event(
      'session.updated',
      { ...updates, sessionId },
      {
        channel: `session:${sessionId}`,
      }
    );
    return { updated: true, value };
  });

  // Atomically push a draft BACKUP onto the server draft WITHOUT discarding
  // voice transcripts the sequence merged. A backup holds save-suppressed
  // edits whose landing EXPIRED — the client's localStorage marker is gone, so
  // it can no longer reconcile locally — and pushing the transcript-free
  // backup with a bare session.update would clobber transcripts sitting in the
  // draft. The baseline snapshot separates them exactly: transcripts are
  // draft-minus-baseline (appendDraftText joining), so the write becomes
  // backup + transcripts. While the pending is still STAGED nothing has
  // merged, so the backup lands as the new draft and the baseline re-anchors
  // to it (mirroring session.update); a draft that diverged from the snapshot
  // means a newer writer intervened — decline rather than guess, the client
  // retries. Read+write is one synchronous step, like stripVoiceBaseline.
  messageHub.onRequest('session.mergeVoiceDraftBackup', async (data, _ctx) => {
    const { sessionId, content, claimId, expectedDraftVersion } = data as {
      sessionId: string;
      content: string;
      claimId?: string;
      expectedDraftVersion?: number;
    };
    if (typeof content !== 'string') throw new Error('Backup content is required');
    const session = sessionManager.getSessionFromDB(sessionId);
    if (!session) throw new Error('Session not found');
    const metadata = session.metadata ?? {};
    // Idempotent replay: this claim's merge already COMMITTED but its ack was
    // lost. Rewriting now would take the baseline-null branch (the first
    // commit cleared it) and replace the combined draft with the
    // transcript-free backup, permanently dropping the voice text. A LOG, not
    // a single marker: another tab's claim can commit while this claim's ack
    // is in flight, and a last-only marker would evict it before its retry.
    const claimLogCutoff = Date.now() - VOICE_APPEND_LOG_TTL_MS;
    const committedClaims = (metadata.inputDraftVoiceMergeClaimLog ?? []).filter(
      (entry) =>
        typeof entry?.id === 'string' && typeof entry?.ts === 'number' && entry.ts > claimLogCutoff
    );
    if (claimId && committedClaims.some((entry) => entry.id === claimId)) {
      return { merged: true, value: metadata.inputDraft ?? '' };
    }
    // STALE-CLAIM guard: the claim log only deduplicates identical ids, so a
    // NEWER tab's claim can commit (clearing the baseline, bumping the draft
    // version) while an OLDER claim is still in flight — its late arrival
    // would take the baseline-null plain-write branch and overwrite the newer
    // draft with older transcript-free content. An echoed expectedDraftVersion
    // that no longer matches marks a newer committed WRITE — but only when the
    // sequence is resolved (no live baseline snapshot): a version bump with
    // the snapshot still lingering and the pending CLEARED is the landing's
    // OWN merge (a session.get merged the pending transcript), which is
    // exactly the write this RPC exists to fold the backup with — declining
    // there would make the client retire its only durable copy of the
    // deferred edits. The merge STAMP distinguishes that merge from a
    // SUBSEQUENT folded save (a stale session.update the folding branch
    // re-anchored): the mismatch is the landing's own merge only while the
    // current version still IS the stamped merge version — anything later is
    // a newer writer's draft. A mismatch while the pending is still STAGED is
    // likewise always another tab's draft write (session.update bumps the
    // version and re-anchors the baseline to the newer text while the pending
    // waits): the staged branch would replace that newer draft with the older
    // backup. `stale` declines only the genuinely superseded claims.
    const baseline = metadata.inputDraftVoiceBaseline;
    const pendingStaged = (metadata.inputDraftVoicePending ?? '').trim() !== '';
    const mergeStamp = metadata.inputDraftVoiceMergedVersion;
    const postMergeWrite =
      typeof mergeStamp === 'number' &&
      typeof metadata.inputDraftVersion === 'number' &&
      metadata.inputDraftVersion !== mergeStamp;
    if (
      expectedDraftVersion !== undefined &&
      typeof metadata.inputDraftVersion === 'number' &&
      expectedDraftVersion !== metadata.inputDraftVersion &&
      (typeof baseline !== 'string' || pendingStaged || postMergeWrite)
    ) {
      return { merged: false, stale: true };
    }
    const draft = metadata.inputDraft ?? '';
    const trimmed = content.trim();
    const metadataUpdate: Partial<SessionMetadata> = {};
    if (typeof baseline !== 'string') {
      // No sequence staged or lingering — a plain draft write.
      metadataUpdate.inputDraft = trimmed || null;
    } else if ((metadata.inputDraftVoicePending ?? '').trim() !== '') {
      // Still staged: the pending merges onto whatever draft is current at
      // merge time, so re-anchor the baseline to the pushed backup.
      metadataUpdate.inputDraft = trimmed || null;
      metadataUpdate.inputDraftVoiceBaseline = trimmed;
    } else {
      // Merged: keep the transcripts, drop the stale pre-sequence baseline.
      let transcripts: string;
      if (draft === baseline) transcripts = '';
      else if (draft.startsWith(`${baseline} `)) transcripts = draft.slice(baseline.length + 1);
      else if (draft.startsWith(baseline)) transcripts = draft.slice(baseline.length);
      else return { merged: false };
      // The COMPLETE combination must fit, as the append and session.get
      // merge paths require: appendDraftText silently slices at the character
      // limit, and committing a truncated draft while reporting merged:true
      // would let the client retire its only durable copy of the lost tail.
      // Decline instead — the claim retries once the draft has room.
      const value = appendDraftText(trimmed, transcripts);
      const fits =
        transcripts === '' ||
        value === `${trimmed} ${transcripts}` ||
        value === `${trimmed}${transcripts}`;
      if (!fits) return { merged: false };
      metadataUpdate.inputDraft = value || null;
      metadataUpdate.inputDraftVoiceBaseline = null;
    }
    // Every branch mutates inputDraft — bump the draft version so OTHER
    // tabs' in-flight saves become recognizably stale against this write.
    metadataUpdate.inputDraftVersion = (metadata.inputDraftVersion ?? 0) + 1;
    if (claimId) {
      // Record the committed claim AFTER the branches above, so a retry of
      // THIS merge is recognized before any branch can rewrite the draft.
      // Appended to the TTL-pruned LOG with NO count cap: a still-retrying
      // claim's acknowledgement can arrive long after later claims commit,
      // and evicting its id would send the retry down the plain-write branch.
      metadataUpdate.inputDraftVoiceMergeClaimLog = [
        ...committedClaims,
        { id: claimId, ts: Date.now() },
      ];
    }
    const updates: UpdateSessionRequest = { metadata: metadataUpdate };
    await sessionManager.updateSession(sessionId, updates as Partial<Session>);
    messageHub.event(
      'session.updated',
      { ...updates, sessionId },
      {
        channel: `session:${sessionId}`,
      }
    );
    return { merged: true, value: metadataUpdate.inputDraft ?? '' };
  });

  messageHub.onRequest('session.delete', async (data, _ctx) => {
    const { sessionId: targetSessionId } = data as { sessionId: string };

    // Get context before deleting so we can include it in the event payload
    const agentSessionForDelete = sessionManager.getSession(targetSessionId);
    const contextForDelete = agentSessionForDelete?.getSessionData().context;
    const spaceIdForDelete = contextForDelete?.spaceId;

    // UI-only delete primitive (Task #85): removes worktree + SDK .jsonl + DB row.
    await sessionManager.deleteSessionResources(targetSessionId, 'ui_session_delete');

    // Remove from space so deleted sessions don't linger in space.sessionIds
    if (spaceIdForDelete) {
      try {
        const updatedSpace = await spaceManager.removeSession(spaceIdForDelete, targetSessionId);
        internalEventBus
          .publish('space.updated', {
            sessionId: 'global',
            spaceId: spaceIdForDelete,
            space: updatedSpace,
          })
          .catch(() => {});
      } catch {
        // Space may already be deleted — ignore
      }
    }

    return { success: true };
  });

  messageHub.onRequest('session.archive', async (data, _ctx) => {
    const { sessionId: targetSessionId, confirmed = false } = data as {
      sessionId: string;
      confirmed?: boolean;
    };

    const agentSession = await sessionManager.getSessionAsync(targetSessionId);
    if (!agentSession) {
      throw new Error('Session not found');
    }

    const session = agentSession.getSessionData();

    // Commits-ahead confirmation check still lives here so the UI can
    // surface pending work before data is archived. The actual
    // archive work (stop agent, archive SDK files, remove worktree,
    // stamp DB row) is funnelled through the UI-only primitive
    // `sessionManager.archiveSessionResources` (Task #85).
    // Note: `session` aliases the live AgentSession data, so fields like
    // `session.worktree` and `session.context` can mutate once archive
    // runs. Snapshot anything we need after the archive now.
    const hadWorktree = !!session.worktree;
    const roomIdForArchive = session.context?.roomId;
    const spaceIdForArchive = session.context?.spaceId;
    let commitsRemoved = 0;
    if (session.worktree) {
      const { WorktreeManager } = await import('../worktree-manager');
      const worktreeManager = new WorktreeManager();
      const commitStatus = await worktreeManager.getCommitsAhead(session.worktree);

      if (!confirmed && commitStatus.hasCommitsAhead) {
        return {
          success: false,
          requiresConfirmation: true,
          commitStatus,
        };
      }
      commitsRemoved = commitStatus.commits.length;
    }

    try {
      await sessionManager.archiveSessionResources(targetSessionId, 'ui_session_archive');
    } catch (error) {
      throw new Error(
        `Failed to archive: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // Remove the session from its Space only after archive succeeds. Doing this
    // before the commits-ahead confirmation gate would evict a still-active
    // session from its Space whenever the user cancels the confirmation dialog
    // (the probe returns requiresConfirmation without archiving).
    if (spaceIdForArchive) {
      try {
        const updatedSpace = await spaceManager.removeSession(spaceIdForArchive, targetSessionId);
        internalEventBus
          .publish('space.updated', {
            sessionId: 'global',
            spaceId: spaceIdForArchive,
            space: updatedSpace,
          })
          .catch(() => {});
      } catch {
        // Space may already be deleted — ignore
      }
    }

    // Broadcast session.updated so RoomStore and session subscribers stay in sync.
    const archivedPayload = {
      sessionId: targetSessionId,
      status: 'archived',
      roomId: roomIdForArchive,
    };
    messageHub.event('session.updated', archivedPayload, {
      channel: `session:${targetSessionId}`,
    });

    return {
      success: true,
      requiresConfirmation: false,
      ...(hadWorktree ? { commitsRemoved } : {}),
    };
  });

  // Handle message sending to a session
  // ARCHITECTURE: Fast RPC handler - emits event, returns immediately
  // EventBus-centric pattern: RPC → emit event → SessionManager handles persistence
  messageHub.onRequest('message.send', async (data) => {
    const {
      sessionId: targetSessionId,
      content,
      images,
      deliveryMode = 'immediate',
    } = data as {
      sessionId: string;
      content: string;
      images?: Array<MessageImage | ImageContent>;
      deliveryMode?: MessageDeliveryMode;
    };

    if (deliveryMode !== 'immediate' && deliveryMode !== 'defer') {
      throw new Error('Invalid deliveryMode');
    }

    // Verify session exists before emitting event.
    // RESIDUAL: a cancelled workflow sub-session's DB row is preserved (Task #85),
    // so getSessionAsync can lazily reload + restart it here even though the task/run
    // is cancelled. The inject + rehydrate paths guard against this, but this generic
    // message.send path lacks task/run status (no nodeExecutionRepo). The
    // cancellation-token pass closes it: expose isSessionForTerminalCancel(sessionId)
    // on TaskAgentManager (which has the deps), wire it as an optional callback into
    // session-handlers via the RPC registration, and call it before this line.
    // See PR #2292 residual section.
    const agentSession = await sessionManager.getSessionAsync(targetSessionId);
    if (!agentSession) {
      throw new Error('Session not found');
    }

    // Generate messageId immediately for return
    const messageId = generateUUID();

    // Persist and start the agent turn before acknowledging; actual SDK queue
    // delivery is async and recovered by the query lifecycle manager.
    await sessionManager.sendUserMessage({
      sessionId: targetSessionId,
      messageId,
      content,
      images,
      deliveryMode,
    });

    return { messageId };
  });

  // Handle session interruption
  // ARCHITECTURE: Fire-and-forget via EventBus, AgentSession subscribes
  messageHub.onRequest('client.interrupt', async (data) => {
    const { sessionId: targetSessionId } = data as { sessionId: string };

    // Verify session exists before emitting event
    const agentSession = await sessionManager.getSessionAsync(targetSessionId);
    if (!agentSession) {
      throw new Error('Session not found');
    }

    // Fire-and-forget: emit event, AgentSession handles it
    internalEventBus
      .publish('agent.interruptRequest', { sessionId: targetSessionId })
      .catch((error) => {
        log.warn(`Failed to emit agent.interruptRequest for session ${targetSessionId}:`, error);
      });

    return { accepted: true };
  });

  // Handle getting current model information
  messageHub.onRequest('session.model.get', async (data) => {
    const { sessionId: targetSessionId } = data as { sessionId: string };

    const agentSession = await sessionManager.getSessionAsync(targetSessionId);
    if (!agentSession) {
      throw new Error('Session not found');
    }

    // Get current model ID (may be an alias like "default")
    const rawModelId = agentSession.getCurrentModel().id;
    const sessionProvider = agentSession.getSessionData().config.provider;

    if (!sessionProvider) {
      throw new Error('Session has no provider configured');
    }

    // Resolve alias to full model ID for consistency with session.model.switch
    // Pass provider so same-ID models are disambiguated by provider context
    const { resolveModelAlias, getModelInfo } = await import('../model-service.js');
    const currentModelId = await resolveModelAlias(rawModelId, 'global', sessionProvider);
    const modelInfo = await getModelInfo(currentModelId, 'global', sessionProvider);

    return {
      currentModel: currentModelId,
      modelInfo,
    };
  });

  // Handle model switching
  // Returns synchronous result for test compatibility and immediate feedback
  messageHub.onRequest('session.model.switch', async (data) => {
    const {
      sessionId: targetSessionId,
      model,
      provider,
    } = data as {
      sessionId: string;
      model: string;
      /** Explicit provider ID — always supply this from the UI model picker. */
      provider?: string;
    };

    if (!provider) {
      throw new Error('Missing required field: provider');
    }

    const agentSession = await sessionManager.getSessionAsync(targetSessionId);
    if (!agentSession) {
      throw new Error('Session not found');
    }

    // Call handleModelSwitch directly - returns {success, model, error}
    const result = await agentSession.handleModelSwitch(model, provider);

    // Broadcast model switch result via state channels for UI updates
    if (result.success) {
      messageHub.event(
        'session.updated',
        { model: result.model },
        { channel: `session:${targetSessionId}` }
      );
    }

    return result;
  });

  // Handle coordinator mode switching
  // Updates config and auto-restarts query so the new agent/tools take effect
  messageHub.onRequest('session.coordinator.switch', async (data) => {
    const { sessionId: targetSessionId, coordinatorMode } = data as {
      sessionId: string;
      coordinatorMode: boolean;
    };

    const agentSession = await sessionManager.getSessionAsync(targetSessionId);
    if (!agentSession) {
      throw new Error('Session not found');
    }

    const session = agentSession.getSessionData();
    const previousMode = session.config.coordinatorMode ?? false;

    if (previousMode === coordinatorMode) {
      return { success: true, coordinatorMode };
    }

    // Update session config
    await sessionManager.updateSession(targetSessionId, {
      config: { ...session.config, coordinatorMode },
    });

    // Restart only when a query is already live. For pre-turn sessions, the
    // next user message starts a fresh query with the updated config.
    const result = agentSession.isQueryActiveOrStarting()
      ? await agentSession.resetQuery({ restartQuery: true })
      : { success: true as const };

    // Broadcast update for UI
    messageHub.event(
      'session.updated',
      { config: { coordinatorMode } },
      { channel: `session:${targetSessionId}` }
    );

    return { success: result.success, coordinatorMode, error: result.error };
  });

  // Handle sandbox mode switching
  // Updates config and auto-restarts query so the new sandbox settings take effect
  messageHub.onRequest('session.sandbox.switch', async (data) => {
    const { sessionId: targetSessionId, sandboxEnabled } = data as {
      sessionId: string;
      sandboxEnabled: boolean;
    };

    const agentSession = await sessionManager.getSessionAsync(targetSessionId);
    if (!agentSession) {
      throw new Error('Session not found');
    }

    const session = agentSession.getSessionData();
    const previousMode = session.config.sandbox?.enabled ?? true;

    if (previousMode === sandboxEnabled) {
      return { success: true, sandboxEnabled };
    }

    // Update session config - preserve existing sandbox settings, only toggle enabled
    const updatedSandbox = {
      ...session.config.sandbox,
      enabled: sandboxEnabled,
    };

    await sessionManager.updateSession(targetSessionId, {
      config: { ...session.config, sandbox: updatedSandbox },
    });

    // Restart only when a query is already live. For pre-turn sessions, the
    // next user message starts a fresh query with the updated sandbox config.
    const result = agentSession.isQueryActiveOrStarting()
      ? await agentSession.resetQuery({ restartQuery: true })
      : { success: true as const };

    // Broadcast update for UI
    messageHub.event(
      'session.updated',
      { config: { sandbox: updatedSandbox } },
      { channel: `session:${targetSessionId}` }
    );

    return { success: result.success, sandboxEnabled, error: result.error };
  });

  // Handle thinking level changes
  // Levels: off, think8k, think16k, think24k, think32k
  // - off: No thinking budget
  // - think8k/16k/24k/32k: Token budget set via maxThinkingTokens
  // Backward compatibility: legacy 'auto' is treated as 'off'.
  // Note: "ultrathink" keyword is NOT auto-appended - users must type it manually
  messageHub.onRequest('session.thinking.set', async (data) => {
    const { sessionId: targetSessionId, level } = data as {
      sessionId: string;
      level: string;
    };

    const agentSession = await sessionManager.getSessionAsync(targetSessionId);
    if (!agentSession) {
      throw new Error('Session not found');
    }

    // Normalize level (accepts legacy 'auto' for backward compatibility)
    const thinkingLevel = normalizeThinkingLevel(level);

    // Update session config with new thinkingLevel
    await sessionManager.updateSession(targetSessionId, {
      config: {
        ...agentSession.getSessionData().config,
        thinkingLevel,
      },
    });

    // Broadcast the thinking level change
    messageHub.event(
      'session.updated',
      { config: { thinkingLevel } },
      { channel: `session:${targetSessionId}` }
    );

    return { success: true, thinkingLevel };
  });

  messageHub.onRequest('session.thinking.get', async (data) => {
    const { sessionId: targetSessionId } = data as { sessionId: string };

    const agentSession = await sessionManager.getSessionAsync(targetSessionId);
    if (!agentSession) {
      throw new Error('Session not found');
    }

    const thinkingLevel = normalizeThinkingLevel(
      agentSession.getSessionData().config.thinkingLevel
    );
    return { thinkingLevel };
  });

  // Handle listing available models
  messageHub.onRequest('models.list', async (data) => {
    try {
      const { getAvailableModels, refreshModels } = await import('../model-service.js');

      const params = data as {
        forceRefresh?: boolean;
        useCache?: boolean;
      };
      const forceRefresh = params?.forceRefresh ?? params?.useCache === false;
      let didRefresh = forceRefresh;

      if (forceRefresh) {
        await refreshModels();
      }

      let availableModels = getAvailableModels('global');

      // If cache is empty and we're not already forcing refresh, do a forced refresh.
      // This handles the case where the cache was just cleared (e.g., after OAuth
      // account changes) so the next models.list call re-evaluates provider availability.
      if (!forceRefresh && availableModels.length === 0) {
        await refreshModels();
        availableModels = getAvailableModels('global');
        didRefresh = true;
      }

      // Self-heal a stale non-empty cache: a registered-and-available provider
      // whose models are absent (e.g. its getModels() failed transiently when
      // the cache was built, or credentials were hydrated without a
      // cache-clearing event) would otherwise stay hidden until the 4h TTL.
      // Probe each missing provider once per cache lifetime and refresh if any
      // is available. The tried-set guard (model-service) prevents a refresh
      // storm when a provider's getModels() persistently fails.
      //
      // This also runs on the freshly-rebuilt catalog from the empty-cache
      // branch above, so a provider whose getModels() transiently failed
      // *during that rebuild* is recovered on this call rather than the next.
      if (!forceRefresh && availableModels.length > 0) {
        const stranded = await detectStrandedProviders(availableModels);
        if (stranded.length > 0) {
          const providersBefore = new Set(
            availableModels.map((m) => m.provider).filter((p): p is string => !!p)
          );
          await refreshModels();
          availableModels = getAvailableModels('global');
          didRefresh = true;
          // If the refresh actually recovered models for a provider that was
          // absent, notify pickers. Concurrent models.list callers that already
          // returned the stale catalog were claimed out of probing (the tried-set
          // marks providers before awaiting), so they won't otherwise see the
          // recovered provider until their next fetch. Bounded to one emit per
          // recovered provider per cache lifetime by the tried-set.
          const recovered = availableModels.some(
            (m) => !!m.provider && !providersBefore.has(m.provider)
          );
          if (recovered) {
            internalEventBus.publishAsync('providers.changed', { sessionId: 'global' });
          }
        }
      }

      return {
        models: availableModels.map((m) => ({
          id: m.id,
          display_name: m.name,
          description: m.description,
          alias: m.alias,
          provider: m.provider,
          contextWindow: m.contextWindow,
          context_window: m.contextWindow,
          // Preserve per-model thinking mode so the picker stays granular for
          // models like Kimi K3 after a switch, without waiting for a reload.
          thinkingModes: m.thinkingModes,
          type: 'model' as const,
        })),
        cached: !didRefresh && availableModels.length > 0,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to list models: ${errorMessage}`);
    }
  });

  // Handle clearing the model cache
  messageHub.onRequest('models.clearCache', async () => {
    clearModelsCache();
    return { success: true };
  });

  // FIX: Handle getting current agent processing state
  // Called by clients after subscribing to agent.state to get initial snapshot
  messageHub.onRequest('agent.getState', async (data) => {
    const { sessionId: targetSessionId } = data as { sessionId: string };

    const agentSession = await sessionManager.getSessionAsync(targetSessionId);
    if (!agentSession) {
      throw new Error('Session not found');
    }

    const state = agentSession.getProcessingState();

    // Return current state (don't publish - this is just a query, not a state change)
    return { state };
  });

  // Handle manual cleanup of orphaned worktrees
  messageHub.onRequest('worktree.cleanup', async (data) => {
    const { workspacePath: resolvedPath } = data as { workspacePath?: string };
    if (!resolvedPath) {
      throw new Error('workspacePath is required');
    }
    const cleanedPaths = await sessionManager.cleanupOrphanedWorktrees(resolvedPath);

    return {
      success: true,
      cleanedPaths,
      message: `Cleaned up ${cleanedPaths.length} orphaned worktree(s)`,
    };
  });

  // Scan SDK session files in ~/.claude/projects/ for a workspace
  messageHub.onRequest('sdk.scan', async (data) => {
    const { workspacePath } = data as { workspacePath: string };

    // Scan SDK project directory
    const files = scanSDKSessionFiles(workspacePath);

    // Get session categories from database (need all sessions for orphan detection)
    const sessions = sessionManager.listSessions({ includeArchived: true });
    const activeIds = new Set(sessions.filter((s) => s.status === 'active').map((s) => s.id));
    const archivedIds = new Set(sessions.filter((s) => s.status === 'archived').map((s) => s.id));

    // Identify orphaned files
    const orphaned = identifyOrphanedSDKFiles(files, activeIds, archivedIds);

    return {
      success: true,
      workspacePath,
      summary: {
        totalFiles: files.length,
        totalSize: files.reduce((sum, f) => sum + f.size, 0),
        orphanedFiles: orphaned.length,
        orphanedSize: orphaned.reduce((sum, f) => sum + f.size, 0),
      },
      files,
      orphaned,
    };
  });

  // Cleanup SDK session files (archive or delete)
  messageHub.onRequest('sdk.cleanup', async (data) => {
    const { workspacePath, mode, sdkSessionIds } = data as {
      workspacePath: string;
      mode: 'archive' | 'delete';
      sdkSessionIds?: string[];
    };

    const errors: string[] = [];
    let processedCount = 0;
    let totalSize = 0;

    // Get files to clean
    let filesToClean = scanSDKSessionFiles(workspacePath);
    if (sdkSessionIds && sdkSessionIds.length > 0) {
      filesToClean = filesToClean.filter((f) => sdkSessionIds.includes(f.sdkSessionId));
    }

    // Process each file
    for (const file of filesToClean) {
      const kaiSessionId = file.kaiSessionIds[0] || 'orphan';

      if (mode === 'delete') {
        const result = deleteSDKSessionFiles(workspacePath, file.sdkSessionId, kaiSessionId);
        if (result.success) {
          processedCount++;
          totalSize += result.deletedSize;
        } else {
          errors.push(...result.errors);
        }
      } else {
        const result = archiveSDKSessionFiles(workspacePath, file.sdkSessionId, kaiSessionId);
        if (result.success) {
          processedCount++;
          totalSize += result.totalSize;
        } else {
          errors.push(...result.errors);
        }
      }
    }

    return {
      success: errors.length === 0,
      mode,
      processedCount,
      totalSize,
      errors,
    };
  });

  // Handle resetting the SDK agent query
  // This forcefully terminates and restarts the SDK query stream
  // Use case: Recovering from stuck "queued" state or unresponsive SDK
  messageHub.onRequest('session.resetQuery', async (data) => {
    const { sessionId: targetSessionId, restartQuery = true } = data as {
      sessionId: string;
      restartQuery?: boolean;
    };

    // Verify session exists
    const agentSession = await sessionManager.getSessionAsync(targetSessionId);
    if (!agentSession) {
      throw new Error('Session not found');
    }

    // Call resetQuery directly and return the result
    // This allows the client to get immediate feedback on success/failure
    const result = await agentSession.resetQuery({ restartQuery, hardReset: true });

    // Also emit event for StateManager to update clients
    await internalEventBus.publish('agent.reset', {
      sessionId: targetSessionId,
      success: result.success,
      error: result.error,
    });

    return result;
  });

  // Handle restarting the query while preserving the SDK session.
  // Unlike resetQuery which clears pending messages and resets state,
  // this method preserves pending messages and attempts to resume
  // the same SDK session for conversation continuity.
  // Use case: Manual restart from UI to refresh the agent without losing context
  messageHub.onRequest('session.restart', async (data) => {
    const { sessionId: targetSessionId } = data as { sessionId: string };

    // Verify session exists
    const agentSession = await sessionManager.getSessionAsync(targetSessionId);
    if (!agentSession) {
      throw new Error('Session not found');
    }

    try {
      // Call restart directly - preserves SDK session and pending messages
      await agentSession.restart();

      // Emit event so StateManager and UI can react to the restart
      await internalEventBus.publish('agent.restart', {
        sessionId: targetSessionId,
        success: true,
      });

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await internalEventBus.publish('agent.restart', {
        sessionId: targetSessionId,
        success: false,
        error: errorMessage,
      });
      return { success: false, error: errorMessage };
    }
  });

  // Handle cancelling a pending rate limit auto-retry
  messageHub.onRequest('session.cancelRateLimitRetry', async (data) => {
    const { sessionId: targetSessionId } = data as { sessionId: string };
    const agentSession = await sessionManager.getSessionAsync(targetSessionId);
    if (!agentSession) {
      throw new Error('Session not found');
    }
    agentSession.cancelRateLimitRetry();
    return { success: true };
  });

  // Handle immediately retrying after a rate limit (bypassing cooldown)
  messageHub.onRequest('session.retryNowAfterRateLimit', async (data) => {
    const { sessionId: targetSessionId } = data as { sessionId: string };
    const agentSession = await sessionManager.getSessionAsync(targetSessionId);
    if (!agentSession) {
      throw new Error('Session not found');
    }
    await agentSession.retryNowAfterRateLimit();
    return { success: true };
  });

  // Handle triggering deferred messages to be sent (manual mode)
  // Use case: When user wants to manually send all deferred messages
  // ARCHITECTURE: Fire-and-forget via EventBus, AgentSession handles the actual sending
  messageHub.onRequest('session.query.trigger', async (data) => {
    const { sessionId: targetSessionId } = data as { sessionId: string };

    // Verify session exists before emitting event
    const agentSession = await sessionManager.getSessionAsync(targetSessionId);
    if (!agentSession) {
      throw new Error('Session not found');
    }

    // Call handleQueryTrigger directly and return result
    // This is synchronous because the UI needs immediate feedback on how many messages were sent
    const result = await agentSession.handleQueryTrigger();

    return result;
  });

  // Handle getting count of messages by status (for UI display)
  // Use case: Show "3 messages pending" in Manual mode UI
  messageHub.onRequest('session.messages.countByStatus', async (data) => {
    const { sessionId: targetSessionId, status } = data as {
      sessionId: string;
      status: 'deferred' | 'enqueued' | 'consumed';
    };

    const agentSession = await sessionManager.getSessionAsync(targetSessionId);
    if (!agentSession) {
      throw new Error('Session not found');
    }

    // Get session to access database through sessionManager
    const session = agentSession.getSessionData();

    // Get database through sessionManager for read-only operation
    const db = sessionManager.getDatabase();
    const count = db.getMessageCountByStatus(session.id, status);

    return { count };
  });

  // List user messages by send status for queue UX
  messageHub.onRequest('session.messages.byStatus', async (data) => {
    const {
      sessionId: targetSessionId,
      status,
      limit = 20,
    } = data as {
      sessionId: string;
      status: 'deferred' | 'enqueued' | 'consumed';
      limit?: number;
    };

    if (!['deferred', 'enqueued', 'consumed'].includes(status)) {
      throw new Error('Invalid status');
    }

    const agentSession = await sessionManager.getSessionAsync(targetSessionId);
    if (!agentSession) {
      throw new Error('Session not found');
    }

    const db = sessionManager.getDatabase();
    const all = db
      .getMessagesByStatus(targetSessionId, status)
      .filter((message) => isSDKUserMessage(message));
    // `total` lets the queue-preview UI distinguish "N messages" from "first N
    // of M" when the client's limit truncates the list.
    const messages = all.slice(0, limit).map((message) => ({
      dbId: message.dbId,
      uuid: message.uuid ?? '',
      timestamp: message.timestamp,
      status,
      text: extractMessageText(message.message.content),
    }));

    return { messages, total: all.length };
  });

  // Remove a message that has not yet been consumed by the SDK.
  messageHub.onRequest('session.messages.removePending', async (data) => {
    const { sessionId: targetSessionId, messageDbId } = data as {
      sessionId?: string;
      messageDbId?: string;
    };

    if (!targetSessionId || !messageDbId) {
      throw new Error('sessionId and messageDbId are required');
    }

    const agentSession = await sessionManager.getSessionAsync(targetSessionId);
    if (!agentSession) {
      throw new Error('Session not found');
    }

    const removed = await agentSession.revokePendingDelivery(messageDbId, 'remove');
    if (!removed.changed) {
      return { removed: false };
    }

    await internalEventBus.publish('messages.statusChanged', {
      sessionId: targetSessionId,
      messageIds: [removed.dbId],
      status: 'removed',
    });

    return {
      removed: true,
      messageId: removed.dbId,
      status: 'enqueued',
      removedFromMemory: removed.removedFromMemory,
    };
  });

  // Move one current-turn steer message back to the next-turn queue.
  messageHub.onRequest('session.messages.deferPending', async (data) => {
    const { sessionId: targetSessionId, messageDbId } = data as {
      sessionId?: string;
      messageDbId?: string;
    };

    if (!targetSessionId || !messageDbId) {
      throw new Error('sessionId and messageDbId are required');
    }

    const agentSession = await sessionManager.getSessionAsync(targetSessionId);
    if (!agentSession) {
      throw new Error('Session not found');
    }

    const deferred = await agentSession.revokePendingDelivery(messageDbId, 'defer');
    if (!deferred.changed) {
      return { deferred: false };
    }

    await internalEventBus.publish('messages.statusChanged', {
      sessionId: targetSessionId,
      messageIds: [deferred.dbId],
      status: 'deferred',
    });

    return {
      deferred: true,
      messageId: deferred.dbId,
      status: 'deferred',
      removedFromMemory: deferred.removedFromMemory,
    };
  });

  // Promote one next-turn message into the current steer queue.
  messageHub.onRequest('session.messages.promotePending', async (data) => {
    const { sessionId: targetSessionId, messageDbId } = data as {
      sessionId?: string;
      messageDbId?: string;
    };

    if (!targetSessionId || !messageDbId) {
      throw new Error('sessionId and messageDbId are required');
    }

    const agentSession = await sessionManager.getSessionAsync(targetSessionId);
    if (!agentSession) {
      throw new Error('Session not found');
    }

    const db = sessionManager.getDatabase();
    const message = db
      .getMessagesByStatus(targetSessionId, 'deferred')
      .find((queuedMessage) => queuedMessage.dbId === messageDbId);

    if (!message || !isSDKUserMessage(message) || !message.uuid) {
      return { promoted: false };
    }

    const replayContent = toReplayContent(message.message.content);
    if (!replayContent) {
      return { promoted: false };
    }

    db.updateMessageStatus([message.dbId], 'enqueued');
    await internalEventBus.publish('messages.statusChanged', {
      sessionId: targetSessionId,
      messageIds: [message.dbId],
      status: 'enqueued',
    });

    if (isMessageDeliveryV2Enabled()) {
      // Durable: route the promoted message through the durable owner via the
      // queued-marker wrapper — the handler drives it as a turn/steer with the
      // full at-least-once + synchronous-consumed-flip guarantees, and the
      // queued marker is set for a turn so a concurrent `deliveryMode:'defer'`
      // send isn't mis-converted to immediate (a steer) while this job waits to
      // be claimed. (Codex review.) Idempotent via getActiveDeliveryRole.
      await deliverAndMarkQueued({
        jobQueue: db.getJobQueueRepo(),
        stateManager: agentSession.stateManager,
        sessionId: targetSessionId,
        messageUuid: message.uuid,
        origin: 'chat',
      });
    } else {
      await agentSession.startQueryAndEnqueue(message.uuid, replayContent);
    }

    return {
      promoted: true,
      messageId: message.dbId,
      status: 'enqueued',
    };
  });

  // Retry a failed user message immediately (manual "Retry" affordance). Reopens
  // the `failed` row to `enqueued` and re-enqueues its durable delivery job so
  // the handler re-drives it. Mirrors the promotePending / Space idempotent
  // retry pattern (reopenDeliveryByUuid + deliverAndMarkQueued). Used by the
  // per-message Retry button shown on `deliveryStatus === 'failed'`.
  messageHub.onRequest('session.messages.retry', async (data) => {
    const { sessionId: targetSessionId, messageDbId } = data as {
      sessionId?: string;
      messageDbId?: string;
    };

    if (!targetSessionId || !messageDbId) {
      throw new Error('sessionId and messageDbId are required');
    }

    const db = sessionManager.getDatabase();
    // Terminal sessions cannot accept a retry: an `archived` session's worktree
    // + subprocess are torn down (the delivery handler rejects it), and an
    // `ended` session would otherwise start another provider turn the UI has
    // disabled. Reject upfront so the RPC does not report success only to fail
    // again (Codex #5). The check MUST precede getSessionAsync(): hydrating an
    // EVICTED session constructs + caches a new AgentSession whose constructor
    // schedules replayPendingMessagesForImmediateMode (microtask), which
    // enqueues a durable delivery job for every pending row — and the delivery
    // handler's archived barrier does not cover `ended`, so hydration alone
    // would start provider turns for other pending prompts despite this RPC
    // returning { retried: false }. (Codex P2.)
    const persistedStatus = db.getSession(targetSessionId)?.status;
    if (persistedStatus === 'archived' || persistedStatus === 'ended') {
      return { retried: false };
    }

    const agentSession = await sessionManager.getSessionAsync(targetSessionId);
    if (!agentSession) {
      throw new Error('Session not found');
    }

    const message = db
      .getMessagesByStatus(targetSessionId, 'failed')
      .find((queuedMessage) => queuedMessage.dbId === messageDbId);

    if (!message || !isSDKUserMessage(message) || !message.uuid) {
      return { retried: false };
    }

    const reopenedId = db.getSDKMessageRepo().reopenDeliveryByUuid(targetSessionId, message.uuid);
    if (!reopenedId) {
      return { retried: false };
    }

    // Roll the row back to `failed` if anything after the reopen throws — the
    // status broadcast OR creating the new delivery owner — mirroring the
    // ordinary-chat enqueue path's atomicity. Otherwise the row is left
    // `enqueued` with no active job and no Retry button until an orphan-
    // reconciler pass repairs it (Codex #6 + review).
    const rollbackToFailed = async () => {
      const rolledBack = db
        .getSDKMessageRepo()
        .markDeliveryFailedByUuid(targetSessionId, message.uuid!);
      if (rolledBack) {
        await internalEventBus.publish('messages.statusChanged', {
          sessionId: targetSessionId,
          messageIds: [rolledBack],
          status: 'failed',
        });
      }
    };

    try {
      // Inside the protected block: a rejecting messages.statusChanged
      // subscriber throws AFTER the failed→enqueued flip but before the job
      // exists — it must roll the row back too, not strand it (Codex review).
      await internalEventBus.publish('messages.statusChanged', {
        sessionId: targetSessionId,
        messageIds: [reopenedId],
        status: 'enqueued',
      });

      if (isMessageDeliveryV2Enabled()) {
        await deliverAndMarkQueued({
          jobQueue: db.getJobQueueRepo(),
          stateManager: agentSession.stateManager,
          sessionId: targetSessionId,
          messageUuid: message.uuid,
          origin: 'chat',
        });
      } else {
        const replayContent = toReplayContent(message.message.content);
        if (replayContent) {
          await agentSession.startQueryAndEnqueue(message.uuid, replayContent);
        }
      }
    } catch (err) {
      await rollbackToFailed();
      throw err;
    }

    return {
      retried: true,
      messageId: reopenedId,
      status: 'enqueued',
    };
  });

  /**
   * Handle the user's response to an sdk_resume_choice action message.
   *
   * - 'start_fresh': clears sdkSessionId and sdkOriginPath so the next
   *   message starts a brand new SDK session.
   * - 'leave_as_is': keeps the existing sdkSessionId; the SDK will handle
   *   the missing transcript (likely producing a "No conversation found" error
   *   and starting fresh on its own, but the user chose not to intervene).
   *
   * Either way, the action message is marked as resolved and re-broadcast so
   * the UI can update the buttons to a "done" state, and the query is started.
   */
  messageHub.onRequest('session.sdkResumeChoice', async (data) => {
    const {
      sessionId: targetSessionId,
      choice,
      messageUuid,
    } = data as {
      sessionId: string;
      choice: 'start_fresh' | 'leave_as_is';
      messageUuid: string;
    };

    if (!targetSessionId || !choice || !messageUuid) {
      throw new Error('Missing required fields: sessionId, choice, messageUuid');
    }

    if (choice !== 'start_fresh' && choice !== 'leave_as_is') {
      throw new Error(`Invalid choice: ${choice}. Must be 'start_fresh' or 'leave_as_is'`);
    }

    const agentSession = await sessionManager.getSessionAsync(targetSessionId);
    if (!agentSession) {
      throw new Error('Session not found');
    }

    const db = sessionManager.getDatabase();

    if (choice === 'start_fresh') {
      // Clear SDK session state so next query starts a fresh SDK conversation.
      // `undefined` causes the repository to write NULL to the DB column via `?? null`.
      db.updateSession(targetSessionId, { sdkSessionId: undefined, sdkOriginPath: undefined });
      const session = agentSession.getSessionData();
      session.sdkSessionId = undefined;
      session.sdkOriginPath = undefined;
    }

    // Mark the action message as resolved and re-broadcast it so the UI
    // can update the buttons to their "answered" state.
    const resolvedMessage: HyperNeoActionMessage = {
      type: 'hyperneo_action',
      uuid: messageUuid,
      session_id: targetSessionId,
      action: 'sdk_resume_choice',
      resolved: true,
      chosenOption: choice,
      timestamp: Date.now(),
    };

    // Update the persisted copy (we look up by uuid in sdk_message JSON).
    // Use updateHyperNeoActionMessageByUuid so we don't need to carry the rowId.
    db.updateHyperNeoActionMessageByUuid(targetSessionId, messageUuid, resolvedMessage);

    messageHub.event(
      'state.sdkMessages.delta',
      { added: [resolvedMessage], timestamp: Date.now() },
      { channel: `session:${targetSessionId}` }
    );

    // Now start (or restart) the query so the user's pending message is processed.
    try {
      await agentSession.restart();
      if (agentSession.getSessionData().config.queryMode !== 'manual') {
        await agentSession.replayPendingMessagesForImmediateMode();
      }
    } catch (err) {
      log.warn(`session.sdkResumeChoice: restart after choice failed: ${err}`);
    }

    return { success: true };
  });
}
