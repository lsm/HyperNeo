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
import { composeDraftWhole, generateUUID, matchesDraftOrComposition } from '@hyperneo/shared';
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

    // PURE read: never persists anything. A staged voice transcript
    // (inputDraftVoicePending) is presented as the COMPOSITION of draft +
    // pending — joined exactly like appendDraftText joins them — so the client
    // sees the text it will send, while the pending itself stays staged and
    // durable until a draft write that contains it ("adoption") or the
    // voice-aware send-clear (message.persisted / clearInputDraftIf) consumes
    // it. When the composition would exceed the character limit, the draft is
    // returned alone: appendDraftText slices silently, and presenting a
    // truncated composition would let a client save it back and durably drop
    // the transcript's tail. The pending simply waits for room.
    let session = agentSession.getSessionData();
    const voicePending = session.metadata?.inputDraftVoicePending;
    if (voicePending && voicePending.trim()) {
      const draft = session.metadata?.inputDraft ?? '';
      const composed = composeDraftWhole(draft, voicePending);
      if (composed !== null && session.metadata) {
        session = { ...session, metadata: { ...session.metadata, inputDraft: composed } };
      }
    }

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
    const { sessionId: targetSessionId, ...updates } = data as UpdateSessionRequest & {
      sessionId: string;
    };

    // DAEMON-COORDINATED voice drafts: a draft write replaces the typing part
    // (`inputDraft`) with exactly what the client shows, and the staged
    // transcript (`inputDraftVoicePending`) is consumed only when the write
    // demonstrably carries it —
    // - A NON-EMPTY write containing the pending's text is an ADOPTION: the
    //   composer read the composed draft (session.get presents typing +
    //   pending as one string) and saved what it saw, transcript included.
    //   Clearing the pending here makes the adoption durable in one write.
    //   (A writer that merely typed the same words clears it too — the texts
    //   are identical, so nothing is visibly lost.)
    // - A write WITHOUT the pending keeps it staged: a composer whose saved
    //   text does not contain the transcript never wipes it. The check is
    //   CONTAINMENT, not awareness — a short transcript appearing as a
    //   coincidental substring of an unrelated write ("ok" inside "looks ok
    //   to me") is consumed too. The words already exist in the saved text,
    //   so no distinct transcript is lost, but this is not an absolute
    //   never-wipe guarantee against coincidental substrings.
    // - An EMPTY write is a TYPING CLEAR only and never consumes the pending —
    //   even when the stored draft is empty. An empty STORED draft means the
    //   composer's typing was not persisted yet (inside its save debounce),
    //   not that the composer showed a voice-only draft: keying the discard
    //   on the stored draft silently dropped transcripts whose composer never
    //   saw them (a landing deferred by typing, then a send or clear inside
    //   the debounce window). A DELIBERATE discard of a displayed composition
    //   is expressed by the composer that displayed it, through the
    //   composition-aware atomic session.clearInputDraftIf below.
    // There is no version protocol: concurrent typing is last-writer-wins,
    // exactly like every non-voice draft in the app.
    const draftWrite = (updates.metadata as Partial<SessionMetadata> | undefined)?.inputDraft;
    if (draftWrite !== undefined) {
      const existing = sessionManager.getSessionFromDB(targetSessionId);
      const meta = existing?.metadata;
      const pending = meta?.inputDraftVoicePending;
      const pendingStaged = !!pending && pending.trim() !== '';
      const written = draftWrite ?? '';
      if (pendingStaged && written.trim() !== '' && written.includes(pending.trim())) {
        // Adoption: the write carries the staged transcript. The needle is
        // trimmed so a pending staged UNTRIMMED by a pre-PR daemon (before
        // staging normalized) is still adoptable by the web's trimmed
        // saves; freshly staged values are already trimmed, so this is
        // equivalence for them.
        (updates.metadata as Partial<SessionMetadata>).inputDraftVoicePending = null;
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
    return { success: true };
  });

  // Stage a voice transcript that completed AFTER its composer unmounted (the
  // user navigated to another session mid-transcription) into a dedicated
  // `inputDraftVoicePending` metadata field. We must NOT write the live
  // inputDraft: the client's debounced draft save (useInputDraft) can still be
  // holding a stale local snapshot and would clobber an append made to
  // inputDraft. A separate field is never touched by those saves, so the
  // transcript survives until a draft write that CONTAINS it adopts it or the
  // voice-aware send-clear (message.persisted / clearInputDraftIf) consumes
  // it; `session.get` presents draft + staging as one composition on
  // read. The read→write is one synchronous step (getFromDB + updateSession's
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
    // The dedup log's own type filter silently drops non-string ids, so an
    // unvalidated id would append once, never match on replay, and
    // double-append — the exact failure the log exists to prevent.
    if (dedupId !== undefined && typeof dedupId !== 'string') {
      throw new Error('dedupId must be a string when provided');
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
      return { success: true, deduped: true };
    }
    // Normalize at staging: trim BOTH sides before joining. The incoming
    // transcript is trimmed because STT output routinely carries trailing
    // whitespace, and the web's debounced saves persist TRIMMED text — an
    // untrimmed staging could never be found by the adoption containment
    // check once only trimmed writes remain, leaving a transcript that
    // duplicates in every read and can never be adopted away. The EXISTING
    // pending is trimmed to heal values staged by a pre-PR daemon (which
    // joined untrimmed) the next time an append flows through.
    const existingPending = (metadata.inputDraftVoicePending ?? '').trim();
    const stagedText = text.trim();
    // Reject (rather than silently truncate) when the staged value is at the
    // character limit and the new transcript cannot fit whole — the client
    // reports the failure instead of claiming a save that dropped its tail.
    const pending = composeDraftWhole(existingPending, stagedText);
    if (pending === null) throw new Error('Pending voice draft is at the character limit');
    const metadataUpdate: Partial<SessionMetadata> = { inputDraftVoicePending: pending };
    if (dedupId) {
      // Append after the TTL filter above prunes expired ids. NO count cap:
      // logged ids come only from outbox flushes (each tab's outbox holds at
      // most 20 entries), so growth within the TTL is inherently bounded —
      // and a count cap could evict an id whose outbox entry is still
      // retryable, letting its eventual replay double-append.
      metadataUpdate.inputDraftVoiceAppendLog = [...processedLog, { id: dedupId, ts: Date.now() }];
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
    // Tell the MOUNTED composer (if any) that a transcript just committed, so
    // it re-reads and shows the composed draft. The event is the daemon's
    // replacement for every client-side landing marker: tabs no longer
    // coordinate through localStorage — a tab that misses the event (socket
    // down, channel not yet joined) converges on its next session.get
    // (navigation or reload) or a later landing, and the pending itself is
    // durable until consumed. (A bare empty write or a typing-only send
    // deliberately leaves an unseen staging in place.) Emitted only
    // for a GENUINE commit: a deduped replay already had its landing
    // announced by the original commit.
    messageHub.event('session.voiceLanded', { sessionId }, { channel: `session:${sessionId}` });
    return { success: true };
  });

  // Atomically clear the input draft ONLY if it still equals `expected` (or
  // the composition of the draft and a staged voice transcript — the sender
  // then read the composed draft and its message carries the voice). The
  // unmounted voice send uses this to consume its click-time draft snapshot
  // without wiping newer edits persisted after the snapshot (the user reopened
  // the session, or another client saved). The MOUNTED composer's deliberate
  // clear uses it the same way: `expected` is the content the composer last
  // displayed, so a composition match is a discard the user actually saw,
  // while a no-match leaves any staged transcript in place (the follow-up bare
  // empty write clears typing only and never consumes it — see session.update
  // above). Read+write is one synchronous step
  // (getFromDB + updateSession's DB write both run before the first `await`),
  // so no concurrent draft save can land between the comparison and the clear.
  messageHub.onRequest('session.clearInputDraftIf', async (data, _ctx) => {
    const { sessionId, expected } = data as { sessionId: string; expected: string };
    if (typeof expected !== 'string') throw new Error('Expected draft value is required');
    const session = sessionManager.getSessionFromDB(sessionId);
    if (!session) throw new Error('Session not found');
    const draft = session.metadata?.inputDraft ?? '';
    const pending = session.metadata?.inputDraftVoicePending ?? '';
    const match = matchesDraftOrComposition(draft, pending, expected);
    if (!match) {
      return { cleared: false };
    }
    // The staged transcript is consumed ONLY on a composition match: the sent
    // message carried it. A direct (typing-only) match means the sender never
    // saw the staged voice — it stays for the next draft.
    const updates: UpdateSessionRequest = {
      metadata: {
        inputDraft: null,
        ...(match === 'composition' ? { inputDraftVoicePending: null } : {}),
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
