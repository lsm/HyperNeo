import type { AgentProcessingState, ModelInfo, ChatMessage } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk/sdk.d.ts';
import { useCallback, useMemo, useState } from 'preact/hooks';
import { switchCoordinatorMode, switchSandboxMode } from '../lib/api-helpers.ts';
import { getCurrentAction } from '../lib/status-actions.ts';
import { toast } from '../lib/toast.ts';
import { useModelSwitcher } from './useModelSwitcher.ts';

interface UseChatComposerControllerOptions {
  sessionId: string;
  agentState: AgentProcessingState;
  messages: ChatMessage[];
  isProcessing: boolean;
  coordinatorMode: boolean;
  setCoordinatorMode: (value: boolean) => void;
  sandboxEnabled: boolean;
  setSandboxEnabled: (value: boolean) => void;
}

export function useChatComposerController({
  sessionId,
  agentState,
  messages,
  isProcessing,
  coordinatorMode,
  setCoordinatorMode,
  sandboxEnabled,
  setSandboxEnabled,
}: UseChatComposerControllerOptions) {
  const [coordinatorSwitching, setCoordinatorSwitching] = useState(false);
  const [sandboxSwitching, setSandboxSwitching] = useState(false);

  const {
    currentModel,
    currentModelInfo,
    availableModels,
    switching: modelSwitching,
    loading: modelLoading,
    switchModel,
  } = useModelSwitcher(sessionId);

  const handleModelSwitchWithConfirmation = useCallback(
    async (model: ModelInfo) => {
      if (isProcessing) {
        const confirmed = confirm(
          'The agent is currently processing. Switching the model will interrupt the current operation. Continue?'
        );
        if (!confirmed) return;
      }

      const currentProvider = currentModelInfo?.provider ?? '';
      const targetProvider = model.provider ?? '';
      const isCrossProviderToAnthropic =
        targetProvider.startsWith('anthropic') && !currentProvider.startsWith('anthropic');
      if (isCrossProviderToAnthropic) {
        const confirmed = confirm(
          'Switching to an Anthropic model will remove thinking blocks from the conversation history to ensure API compatibility. Your messages and tool outputs will be preserved. Continue?'
        );
        if (!confirmed) return;
      }

      await switchModel(model);
    },
    [switchModel, isProcessing, currentModelInfo]
  );

  const handleCoordinatorModeChange = useCallback(
    async (newMode: boolean) => {
      if (isProcessing) {
        const confirmed = confirm(
          'The agent is currently processing. Changing coordinator mode will interrupt the current operation. Continue?'
        );
        if (!confirmed) return;
      }
      setCoordinatorSwitching(true);
      setCoordinatorMode(newMode);
      try {
        await switchCoordinatorMode(sessionId, newMode);
      } catch {
        setCoordinatorMode(!newMode);
        toast.error('Failed to toggle coordinator mode');
      } finally {
        setCoordinatorSwitching(false);
      }
    },
    [sessionId, isProcessing, setCoordinatorMode]
  );

  const handleSandboxModeChange = useCallback(
    async (newMode: boolean) => {
      if (isProcessing) {
        const confirmed = confirm(
          'The agent is currently processing. Changing sandbox mode will interrupt the current operation. Continue?'
        );
        if (!confirmed) return;
      }
      setSandboxSwitching(true);
      setSandboxEnabled(newMode);
      try {
        await switchSandboxMode(sessionId, newMode);
      } catch {
        setSandboxEnabled(!newMode);
        toast.error('Failed to toggle sandbox mode');
      } finally {
        setSandboxSwitching(false);
      }
    },
    [sessionId, isProcessing, setSandboxEnabled]
  );

  const { currentAction, streamingPhase } = useMemo(() => {
    if (agentState.status === 'queued') {
      return { currentAction: 'Message queued...', streamingPhase: null };
    }

    if (agentState.status === 'interrupted') {
      return { currentAction: 'Interrupted', streamingPhase: null };
    }

    if (agentState.status === 'processing') {
      const phase = agentState.phase;
      const latestMessage =
        messages.length > 0 ? (messages[messages.length - 1] as SDKMessage) : null;
      const action = getCurrentAction(latestMessage, true, {
        isCompacting: agentState.isCompacting,
        streamingPhase: phase,
        streamingStartedAt: agentState.streamingStartedAt,
      });
      return { currentAction: action, streamingPhase: phase };
    }

    return { currentAction: undefined, streamingPhase: null };
  }, [agentState, messages]);

  return {
    currentModel,
    currentModelInfo,
    availableModels,
    modelSwitching,
    modelLoading,
    switchModel,
    currentAction,
    streamingPhase,
    coordinatorMode,
    coordinatorSwitching,
    handleCoordinatorModeChange,
    sandboxEnabled,
    sandboxSwitching,
    handleSandboxModeChange,
    handleModelSwitchWithConfirmation,
  };
}
