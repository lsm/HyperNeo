import type {
  ContextInfo,
  ModelInfo,
  SessionState,
  SpaceTaskActivityMember,
  ThinkingLevel,
} from '@hyperneo/shared';
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
  nodeExecutionSessionId?: string;
  nodeId?: string;
  nodeName?: string;
  state?: string;
}

export interface UseTargetSessionContextResult {
  targetSessionId: string | null;
  currentModel: string;
  currentModelInfo: ModelInfo | null;
  availableModels: ModelInfo[];
  modelSwitching: boolean;
  modelLoading: boolean;
  thinkingLevel: ThinkingLevel;
  contextInfo: ContextInfo | null;
  isProcessing: boolean;
  isStarted: boolean;
  switchModel: (model: ModelInfo) => Promise<void>;
  setThinkingLevel: (level: ThinkingLevel) => Promise<void>;
}

function normalizeTargetName(name: string | null | undefined): string {
  return (name ?? '')
    .toLowerCase()
    .replace(/(?:\s+agent)+$/, '')
    .replace(/[\s_-]+/g, '');
}

export function resolveTargetSessionId(
  target: TaskComposerTarget | null,
  activityMembers: SpaceTaskActivityMember[]
): string | null {
  if (!target) return null;
  const matchesNodeAndName = (m: SpaceTaskActivityMember): boolean => {
    if (m.kind !== 'node_agent') return false;
    if (m.nodeExecution?.status === 'cancelled' || m.nodeExecution?.status === 'pending') {
      return false;
    }
    if (target.nodeExecutionId && m.nodeExecution?.nodeExecutionId === target.nodeExecutionId) {
      return true;
    }
    const nameMatches =
      normalizeTargetName(m.role) === normalizeTargetName(target.agentName) ||
      normalizeTargetName(m.nodeExecution?.agentName) === normalizeTargetName(target.agentName);
    const nodeMatches = !target.nodeId || m.nodeExecution?.nodeId === target.nodeId;
    if (m.nodeExecution?.isCurrentPostApproval === true) {
      const exactNameMatch =
        m.role === target.agentName || m.nodeExecution?.agentName === target.agentName;
      return nodeMatches && exactNameMatch;
    }
    if (target.nodeExecutionId) return false;
    return nodeMatches && nameMatches;
  };
  const candidates = activityMembers.filter(matchesNodeAndName);
  if (candidates.length === 0) return null;
  const current =
    candidates.find((m) => m.nodeExecution?.isCurrentPostApproval === true) ?? candidates[0];
  const resolved = current.sessionId ?? null;
  if (
    !target.nodeExecutionId &&
    target.nodeExecutionSessionId &&
    resolved &&
    resolved !== target.nodeExecutionSessionId
  ) {
    return target.nodeExecutionSessionId;
  }
  return resolved;
}

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
  const resolvedSessionId = useMemo(
    () => resolveTargetSessionId(selectedTarget, activityMembers),
    [selectedTarget, activityMembers]
  );
  const latchedSessionRef = useRef<{
    key: string;
    sessionId: string;
    execSessionId?: string;
  } | null>(null);
  const latchKey = `${taskId}:${selectedTarget?.id ?? ''}`;
  const latched = latchedSessionRef.current;
  const execSessionId = selectedTarget?.nodeExecutionSessionId;
  const latchValid =
    latched?.key === latchKey &&
    (latched.execSessionId === undefined || latched.execSessionId === execSessionId);
  const latchedSessionId = resolvedSessionId ?? (latchValid ? latched!.sessionId : null);
  const nodeExecutionLoaded = selectedTarget?.nodeExecutionId !== undefined;
  const resolvedConsistent = !nodeExecutionLoaded || execSessionId === resolvedSessionId;
  let targetSessionId = resolvedSessionId && !resolvedConsistent ? null : latchedSessionId;
  if (resolvedSessionId && resolvedConsistent && execSessionId !== undefined) {
    latchedSessionRef.current = { key: latchKey, sessionId: resolvedSessionId, execSessionId };
  }
  const isStarted = !!targetSessionId;

  const modelSwitcher = useModelSwitcher(targetSessionId);

  const [preConfiguredModel, setPreConfiguredModel] = useState<
    Map<string, { id: string; provider: string; taskId: string }>
  >(new Map());
  const [preConfiguredThinking, setPreConfiguredThinking] = useState<
    Map<string, { level: ThinkingLevel; taskId: string }>
  >(new Map());
  const [contextInfo, setContextInfo] = useState<ContextInfo | null>(null);

  const appliedModelRef = useRef<Set<string>>(new Set());
  const appliedThinkingRef = useRef<Set<string>>(new Set());
  const lastTaskIdRef = useRef<string>(taskId);
  const selectedTargetRef = useRef(selectedTarget);
  selectedTargetRef.current = selectedTarget;

  useEffect(() => {
    setPreConfiguredModel(new Map());
    setPreConfiguredThinking(new Map());
    appliedModelRef.current = new Set();
    appliedThinkingRef.current = new Set();
    lastTaskIdRef.current = taskId;
  }, [taskId]);

  const defaultModel = useMemo(() => {
    if (!selectedTarget || selectedTarget.kind !== 'node_agent') {
      return '';
    }
    return defaultAgentModels?.get(selectedTarget.id) ?? '';
  }, [selectedTarget, defaultAgentModels]);

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
      } catch {}
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
      } catch {}
    };
    loadThinkingLevel();
    return () => {
      cancelled = true;
    };
  }, [targetSessionId, connectionState.value]);

  useEffect(() => {
    if (!selectedTarget || isStarted) return;
    const entry = preConfiguredThinking.get(selectedTarget.id);
    const level = entry && entry.taskId === taskId ? entry.level : 'off';
    setLocalThinkingLevel(level);
  }, [selectedTarget?.id, isStarted, preConfiguredThinking, taskId]);

  const { availableModels: switcherModels, reload: reloadModelState } = modelSwitcher;

  useEffect(() => {
    if (lastTaskIdRef.current !== taskId) {
      lastTaskIdRef.current = taskId;
      return;
    }

    for (const target of targets) {
      const targetId = target.id;

      const preModel = preConfiguredModel.get(targetId);
      const preThinking = preConfiguredThinking.get(targetId);
      const preModelCurrent = preModel && preModel.taskId === taskId ? preModel : undefined;
      const preThinkingCurrent =
        preThinking && preThinking.taskId === taskId ? preThinking : undefined;
      if (!preModelCurrent && !preThinkingCurrent) continue;

      const sessionId = resolveTargetSessionId(target, activityMembers);
      if (!sessionId) continue;
      const targetExecSessionId = target.nodeExecutionSessionId;
      const targetNodeExecutionLoaded = target.nodeExecutionId !== undefined;
      const targetResolvedConsistent =
        !targetNodeExecutionLoaded || targetExecSessionId === sessionId;
      if (!targetResolvedConsistent) continue;

      const promises: Promise<unknown>[] = [];

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
                    if (target.id === selectedTargetRef.current?.id) {
                      reloadModelState();
                    }
                  }
                })
            );
          }
        }
      }

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
