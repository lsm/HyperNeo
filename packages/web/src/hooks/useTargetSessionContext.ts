import type {
  ContextInfo,
  ModelInfo,
  SessionState,
  SpaceTaskActivityMember,
  ThinkingLevel,
} from '@neokai/shared';
import { useState, useEffect, useMemo, useCallback, useRef } from 'preact/hooks';
import { connectionManager } from '../lib/connection-manager.ts';
import { connectionState } from '../lib/state.ts';
import { toast } from '../lib/toast.ts';
import { useModelSwitcher } from './useModelSwitcher.ts';

export interface TaskComposerTarget {
  id: string;
  kind: 'node_agent';
  label: string;
  agentName?: string;
  nodeExecutionId?: string;
  /** Live agentSessionId of the backing node execution (from nodeExecutions.byRun). */
  nodeExecutionSessionId?: string;
  nodeName?: string;
  state?: string;
}

export interface UseTargetSessionContextResult {
  /** Resolved session ID for the targeted agent, or null if not started */
  targetSessionId: string | null;
  /** Current model ID (live or pre-configured) */
  currentModel: string;
  /** Current model info (live or pre-configured) */
  currentModelInfo: ModelInfo | null;
  /** All available models from the server */
  availableModels: ModelInfo[];
  /** Whether a model switch is in progress */
  modelSwitching: boolean;
  /** Whether models are being loaded */
  modelLoading: boolean;
  /** Current thinking level (live or pre-configured) */
  thinkingLevel: ThinkingLevel;
  /** Current context usage for the targeted session */
  contextInfo: ContextInfo | null;
  /** Whether the targeted agent is actively processing */
  isProcessing: boolean;
  /** Whether the targeted agent has a live session */
  isStarted: boolean;
  /** Switch model on the targeted session (or pre-configure) */
  switchModel: (model: ModelInfo) => Promise<void>;
  /** Set thinking level on the targeted session (or pre-configure) */
  setThinkingLevel: (level: ThinkingLevel) => Promise<void>;
}

/** Normalize an agent/target name for comparison, stripping suffixes and punctuation. */
function normalizeTargetName(name: string | null | undefined): string {
  return (name ?? '')
    .toLowerCase()
    .replace(/(?:\s+agent)+$/, '')
    .replace(/[\s_-]+/g, '');
}

/**
 * Resolve a composer target to its backing session ID.
 */
export function resolveTargetSessionId(
  target: TaskComposerTarget | null,
  activityMembers: SpaceTaskActivityMember[]
): string | null {
  if (!target) return null;
  // node_agent: prefer exact nodeExecutionId match, then fall back to agent name
  const member = activityMembers.find((m) => {
    if (m.kind !== 'node_agent') return false;
    if (target.nodeExecutionId) {
      return m.nodeExecution?.nodeExecutionId === target.nodeExecutionId;
    }
    return (
      normalizeTargetName(m.role) === normalizeTargetName(target.agentName) ||
      normalizeTargetName(m.nodeExecution?.agentName) === normalizeTargetName(target.agentName)
    );
  });
  return member?.sessionId ?? null;
}

/**
 * Hook that resolves the selected task-composer target to a live session
 * context (model, thinking, processing state) and supports pre-configuration
 * for agents that haven't started yet.
 */
export function useTargetSessionContext({
  taskId,
  targets,
  selectedTarget,
  activityMembers,
  defaultAgentModels,
}: {
  taskId: string;
  targets: TaskComposerTarget[];
  selectedTarget: TaskComposerTarget | null;
  activityMembers: SpaceTaskActivityMember[];
  defaultAgentModels?: Map<string, string>;
}): UseTargetSessionContextResult {
  // Resolve the selected target to its backing session, then LATCH the result
  // per target. `composerTargets` (from the `nodeExecutions.byRun` LiveQuery)
  // and `activityMembers` (from `spaceTaskActivity.byTask`) are two independent
  // queries that can land on different ticks; while one is momentarily ahead of
  // the other — or during a re-snapshot that briefly omits the node-agent member
  // — `resolveTargetSessionId` returns null even though the session still exists.
  //
  // Without latching, that null flip propagates to `useInputDraft`'s
  // session-change effect, which clobbers the in-memory draft to '' and reloads
  // the (now stale) server draft — restoring text the user just deleted, or
  // leaving a stray fragment. Latching rides out the transient gap so the
  // resolved session stays stable until the target genuinely changes.
  const resolvedSessionId = useMemo(
    () => resolveTargetSessionId(selectedTarget, activityMembers),
    [selectedTarget, activityMembers]
  );
  // Latch the resolved session per (taskId, target) and hold it across a
  // transient resolution gap — but invalidate it the moment the backing
  // execution no longer reports that session as live.
  //
  // - taskId scoping: `SpaceTaskPane` stays mounted across task switches (no
  //   key=taskId on its render site) and target ids are reused across tasks
  //   (`node:<nodeId>:<agentName>`), so without taskId the prior task's session
  //   would leak into a freshly-selected task whose activity hasn't loaded.
  // - liveness via nodeExecutionSessionId: this is the execution's live
  //   `agentSessionId` from `nodeExecutions.byRun`. That query is NOT filtered by
  //   `agent_session_id IS NOT NULL`, so the execution (and nodeExecutionId)
  //   stays in composerTargets even after a worker is detached — but
  //   `detachSessionFromAllExecutions` sets the row's agentSessionId to null, so
  //   nodeExecutionSessionId drops while `spaceTaskActivity.byTask` (which DOES
  //   filter agent_session_id IS NOT NULL) drops the member. Holding the latch
  //   only while nodeExecutionSessionId still matches the latched session rides
  //   out the transient member desync (nodeExecutions.byRun still carries the
  //   live session id) yet clears immediately on detach, so a recovering agent is
  //   treated as not-started instead of staying wired to a canceled stale
  //   session.
  const latchedSessionRef = useRef<{
    key: string;
    sessionId: string;
    execSessionId?: string;
  } | null>(null);
  const latchKey = `${taskId}:${selectedTarget?.id ?? ''}`;
  const latched = latchedSessionRef.current;
  // The latch is valid while the target is unchanged AND the backing execution
  // still reports the latched session as live. `execSessionId` captured at latch
  // time distinguishes the two undefined cases: if we latched WITHOUT an
  // execution-level session signal (e.g. an agentName-only match), there is
  // nothing to refute, so trust the latch; if we latched WITH one, a current
  // nodeExecutionSessionId that no longer matches means the worker detached.
  const latchValid =
    latched?.key === latchKey &&
    (latched.execSessionId === undefined ||
      latched.execSessionId === selectedTarget?.nodeExecutionSessionId);
  const latchedSessionId = resolvedSessionId ?? (latchValid ? latched!.sessionId : null);
  let targetSessionId = latchedSessionId;
  if (resolvedSessionId) {
    latchedSessionRef.current = {
      key: latchKey,
      sessionId: resolvedSessionId,
      execSessionId: selectedTarget?.nodeExecutionSessionId,
    };
  }
  const isStarted = !!targetSessionId;

  // Use the shared model switcher for the target session.
  // When the agent hasn't started yet sessionId is null; useModelSwitcher
  // skips session.model.get but still loads the global catalogue.
  const modelSwitcher = useModelSwitcher(targetSessionId);

  // In-memory pre-configuration for not-yet-started agents.
  // Model preconfig stores id, provider, and the owning taskId so that
  // effective reads and auto-apply can guard against stale data after a
  // task switch.
  const [preConfiguredModel, setPreConfiguredModel] = useState<
    Map<string, { id: string; provider: string; taskId: string }>
  >(new Map());
  const [preConfiguredThinking, setPreConfiguredThinking] = useState<
    Map<string, { level: ThinkingLevel; taskId: string }>
  >(new Map());
  const [contextInfo, setContextInfo] = useState<ContextInfo | null>(null);

  // Track which targets have had each specific config type successfully
  // auto-applied, so we don't loop and so a missing model lookup doesn't
  // permanently suppress retries for the thinking config (or vice versa).
  const appliedModelRef = useRef<Set<string>>(new Set());
  const appliedThinkingRef = useRef<Set<string>>(new Set());
  // Track the last taskId we've seen so the auto-apply effect can skip the
  // first render cycle after a task switch (React batches state updates, so
  // the reset effect's new Maps won't be visible until the next commit).
  const lastTaskIdRef = useRef<string>(taskId);
  // Track the latest selectedTarget so async auto-apply continuations can
  // read the current selection instead of a stale closure value.
  const selectedTargetRef = useRef(selectedTarget);
  selectedTargetRef.current = selectedTarget;

  // Reset pre-configuration state when the active task changes so stale
  // settings from a previous task don't leak into the new one.
  useEffect(() => {
    setPreConfiguredModel(new Map());
    setPreConfiguredThinking(new Map());
    appliedModelRef.current = new Set();
    appliedThinkingRef.current = new Set();
    lastTaskIdRef.current = taskId;
  }, [taskId]);

  // Default model from workflow definition (keyed by target ID).
  const defaultModel = useMemo(() => {
    if (!selectedTarget || selectedTarget.kind !== 'node_agent') {
      return '';
    }
    return defaultAgentModels?.get(selectedTarget.id) ?? '';
  }, [selectedTarget, defaultAgentModels]);

  // Effective model: live when started, pre-configured/default when not.
  // Ignore preconfig entries that belong to a different task.
  const preConfigEntry = preConfiguredModel.get(selectedTarget?.id ?? '');
  const preConfigForCurrentTask =
    preConfigEntry && preConfigEntry.taskId === taskId ? preConfigEntry : undefined;
  const effectiveCurrentModel = isStarted
    ? modelSwitcher.currentModel
    : (preConfigForCurrentTask?.id ?? defaultModel);

  const effectiveCurrentModelInfo = isStarted
    ? modelSwitcher.currentModelInfo
    : (modelSwitcher.availableModels.find(
        (m) => m.id === effectiveCurrentModel && m.provider === preConfigForCurrentTask?.provider
      ) ??
      modelSwitcher.availableModels.find((m) => m.id === effectiveCurrentModel) ??
      null);

  // Thinking level — default to off.
  const [thinkingLevel, setLocalThinkingLevel] = useState<ThinkingLevel>('off');

  useEffect(() => {
    if (!targetSessionId) {
      setContextInfo(null);
      return;
    }

    let cancelled = false;
    let liveContextReceived = false;
    let joined = false;
    let unsubscribeSessionState: (() => void) | null = null;
    let unsubscribeContextUpdated: (() => void) | null = null;
    const channel = `session:${targetSessionId}`;
    const hub = connectionManager.getHubIfConnected();
    if (!hub) return;

    const applySessionState = (state: SessionState) => {
      setContextInfo(state.sessionInfo?.metadata?.lastContextInfo ?? null);
    };

    const setupContextSubscriptions = async () => {
      try {
        await hub.joinChannel(channel);
        joined = true;
        if (cancelled) {
          void hub.leaveChannel(channel);
          return;
        }

        unsubscribeSessionState = hub.onEvent<SessionState>('state.session', (state, context) => {
          if (cancelled) return;
          if (context.channel !== channel) return;
          applySessionState(state);
        });

        unsubscribeContextUpdated = hub.onEvent<ContextInfo>(
          'context.updated',
          (nextContextInfo, context) => {
            if (cancelled) return;
            if (context.channel !== channel) return;
            liveContextReceived = true;
            setContextInfo(nextContextInfo);
          }
        );

        const state = await hub.request<SessionState>('state.session', {
          sessionId: targetSessionId,
        });
        if (!cancelled && !liveContextReceived) {
          applySessionState(state);
        }
      } catch {
        // Ignore errors — keep the existing snapshot until the next successful state/event update.
      }
    };
    void setupContextSubscriptions();

    return () => {
      cancelled = true;
      unsubscribeSessionState?.();
      unsubscribeContextUpdated?.();
      if (joined) {
        void hub.leaveChannel(channel);
      }
    };
  }, [targetSessionId, connectionState.value]);

  // Load the live thinking level from the session whenever the target
  // session changes (e.g. switching to a different started agent).
  // Also re-fetch when the connection recovers so a transient disconnect
  // or early render while the hub is still connecting doesn't leave the
  // dropdown stuck on a stale local default.
  useEffect(() => {
    if (!targetSessionId) return;
    let cancelled = false;
    const loadThinkingLevel = async () => {
      try {
        const hub = connectionManager.getHubIfConnected();
        if (!hub) return;
        const result = (await hub.request('session.thinking.get', {
          sessionId: targetSessionId,
        })) as { thinkingLevel: ThinkingLevel };
        if (!cancelled) {
          setLocalThinkingLevel(result.thinkingLevel);
        }
      } catch {
        // Ignore errors — keep current thinking level
      }
    };
    loadThinkingLevel();
    return () => {
      cancelled = true;
    };
  }, [targetSessionId, connectionState.value]);

  // For unstarted targets, sync with pre-configured value (scoped to current task).
  useEffect(() => {
    if (!selectedTarget || isStarted) return;
    const entry = preConfiguredThinking.get(selectedTarget.id);
    const level = entry && entry.taskId === taskId ? entry.level : 'off';
    setLocalThinkingLevel(level);
  }, [selectedTarget?.id, isStarted, preConfiguredThinking, taskId]);

  // Destructure stable primitives from modelSwitcher to avoid effect re-runs
  // caused by the switcher object identity changing every render.
  const { availableModels: switcherModels, reload: reloadModelState } = modelSwitcher;

  // Auto-apply pre-configured settings when any target's session spawns.
  // Iterates over ALL targets so that background spawns (targets not currently
  // selected) still receive their pending preconfiguration.
  //
  // Each config type (model, thinking) is tracked independently via
  // appliedModelRef / appliedThinkingRef. If a model lookup misses because
  // switcherModels hasn't loaded yet, the model config stays unmarked while
  // the thinking config can still be applied. The missing model will be
  // retried on the next render cycle once models are available.
  //
  // Guard: skip the first render after taskId changes because React batches
  // the reset-effect's state updates; without this guard the effect would
  // read stale preconfiguration from the previous task.
  useEffect(() => {
    if (lastTaskIdRef.current !== taskId) {
      // taskId just changed but the reset-effect's state update hasn't
      // committed yet; defer auto-apply until the next render.
      lastTaskIdRef.current = taskId;
      return;
    }

    for (const target of targets) {
      const targetId = target.id;

      const preModel = preConfiguredModel.get(targetId);
      const preThinking = preConfiguredThinking.get(targetId);
      // Ignore entries that belong to a different task.
      const preModelCurrent = preModel && preModel.taskId === taskId ? preModel : undefined;
      const preThinkingCurrent =
        preThinking && preThinking.taskId === taskId ? preThinking : undefined;
      if (!preModelCurrent && !preThinkingCurrent) continue;

      const sessionId = resolveTargetSessionId(target, activityMembers);
      if (!sessionId) continue;

      const promises: Promise<unknown>[] = [];

      // Apply model switch
      if (preModelCurrent && !appliedModelRef.current.has(targetId)) {
        const modelInfo = switcherModels.find(
          (m) => m.id === preModelCurrent.id && m.provider === preModelCurrent.provider
        );
        if (modelInfo) {
          const hub = connectionManager.getHubIfConnected();
          if (hub) {
            promises.push(
              hub
                .request('session.model.switch', {
                  sessionId,
                  model: modelInfo.id,
                  provider: modelInfo.provider,
                })
                .then((result: unknown) => {
                  const { success } = result as { success: boolean };
                  if (success) {
                    appliedModelRef.current.add(targetId);
                    // Refresh useModelSwitcher state so the UI shows the
                    // newly applied model instead of the stale initial one.
                    if (target.id === selectedTargetRef.current?.id) {
                      reloadModelState();
                    }
                  }
                })
            );
          }
        }
      }

      // Apply thinking level
      if (preThinkingCurrent && !appliedThinkingRef.current.has(targetId)) {
        const hub = connectionManager.getHubIfConnected();
        if (hub) {
          promises.push(
            hub
              .request('session.thinking.set', {
                sessionId,
                level: preThinkingCurrent.level,
              })
              .then(() => {
                appliedThinkingRef.current.add(targetId);
                if (target.id === selectedTargetRef.current?.id) {
                  setLocalThinkingLevel(preThinkingCurrent.level);
                }
              })
          );
        }
      }

      if (promises.length === 0) continue;

      Promise.allSettled(promises);
    }
  }, [
    taskId,
    targets,
    activityMembers,

    preConfiguredModel,
    preConfiguredThinking,
    switcherModels,
    reloadModelState,
  ]);

  // Derive processing state from the activity member that owns this session.
  const isProcessing = useMemo(() => {
    if (!targetSessionId) return false;
    const member = activityMembers.find((m) => m.sessionId === targetSessionId);
    if (!member) return false;
    return member.processingStatus === 'processing' || member.processingStatus === 'queued';
  }, [targetSessionId, activityMembers]);

  const switchModel = useCallback(
    async (model: ModelInfo) => {
      if (!selectedTarget) return;
      if (!isStarted) {
        setPreConfiguredModel((prev) =>
          new Map(prev).set(selectedTarget.id, {
            id: model.id,
            provider: model.provider,
            taskId,
          })
        );
        toast.success(`Pre-configured ${selectedTarget.label} to use ${model.name}`);
        return;
      }
      await modelSwitcher.switchModel(model);
    },
    [isStarted, selectedTarget, modelSwitcher, taskId]
  );

  const setThinkingLevel = useCallback(
    async (level: ThinkingLevel) => {
      setLocalThinkingLevel(level);
      if (!isStarted || !targetSessionId) {
        if (selectedTarget) {
          setPreConfiguredThinking((prev) =>
            new Map(prev).set(selectedTarget.id, { level, taskId })
          );
        }
        return;
      }
      try {
        const hub = connectionManager.getHubIfConnected();
        if (!hub) {
          toast.error('Not connected to server');
          return;
        }
        await hub.request('session.thinking.set', {
          sessionId: targetSessionId,
          level,
        });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to set thinking level');
      }
    },
    [isStarted, targetSessionId, selectedTarget, taskId]
  );

  return {
    targetSessionId,
    currentModel: effectiveCurrentModel,
    currentModelInfo: effectiveCurrentModelInfo,
    availableModels: modelSwitcher.availableModels,
    modelSwitching: modelSwitcher.switching,
    modelLoading: modelSwitcher.loading,
    thinkingLevel,
    contextInfo,
    isProcessing,
    isStarted,
    switchModel,
    setThinkingLevel,
  };
}
