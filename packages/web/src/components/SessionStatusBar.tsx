import type { ContextInfo, ModelInfo, ThinkingLevel } from '@hyperneo/shared';
import { useSignalEffect } from '@preact/signals';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { useMessageHub } from '../hooks';
import { type ConnectionState, connectionState } from '../lib/state.ts';
import ConnectionStatus from './ConnectionStatus.tsx';
import ContextUsageBar from './ContextUsageBar.tsx';
import { ModelPicker } from './ModelPicker.tsx';
import { ContentContainer } from './ui/ContentContainer.tsx';

interface SessionStatusBarProps {
  sessionId: string;
  isProcessing: boolean;
  currentAction?: string;
  statusActivity?: string;
  streamingPhase?: 'initializing' | 'thinking' | 'streaming' | 'finalizing' | null;
  contextUsage?: ContextInfo;
  maxContextTokens?: number;
  currentModel: string;
  currentModelInfo: ModelInfo | null;
  availableModels: ModelInfo[];
  modelSwitching: boolean;
  modelLoading: boolean;
  onModelSwitch: (model: ModelInfo) => void;
  thinkingLevel?: ThinkingLevel;
  onThinkingLevelChange?: (level: ThinkingLevel) => Promise<void> | void;
  coordinatorSwitching?: boolean;
  isRecovering?: boolean;
}

export default function SessionStatusBar({
  sessionId: _sessionId,
  isProcessing,
  currentAction,
  statusActivity,
  streamingPhase,
  contextUsage,
  maxContextTokens,
  currentModel: _currentModel,
  currentModelInfo,
  availableModels,
  modelSwitching,
  modelLoading,
  onModelSwitch,
  thinkingLevel: thinkingLevelProp,
  onThinkingLevelChange,
  coordinatorSwitching = false,
  isRecovering = false,
}: SessionStatusBarProps) {
  const [connState, setConnState] = useState<ConnectionState>(connectionState.value);

  useSignalEffect(() => {
    setConnState(connectionState.value);
  });

  const { callIfConnected } = useMessageHub();

  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(thinkingLevelProp || 'off');
  useEffect(() => {
    setThinkingLevel(thinkingLevelProp || 'off');
  }, [thinkingLevelProp]);

  const handleThinkingLevelChange = useCallback(
    async (level: ThinkingLevel) => {
      setThinkingLevel(level);
      if (onThinkingLevelChange) {
        await onThinkingLevelChange(level);
        return;
      }
      await callIfConnected('session.thinking.set', {
        sessionId: _sessionId,
        level,
      });
    },
    [_sessionId, callIfConnected, onThinkingLevelChange]
  );

  return (
    <ContentContainer className="pb-2 flex items-center gap-4 justify-between">
      <ConnectionStatus
        connectionState={isRecovering && connState === 'connected' ? 'reconnecting' : connState}
        isProcessing={isRecovering ? false : isProcessing}
        currentAction={isRecovering ? undefined : currentAction}
        activity={isRecovering ? undefined : statusActivity}
        streamingPhase={isRecovering ? undefined : streamingPhase}
      />

      <div class="flex min-w-0 items-center gap-3 sm:gap-4">
        <ModelPicker
          menuId="session-preferences"
          align="right"
          activeModelInfo={currentModelInfo}
          activeModelLabel={_currentModel || 'Select model'}
          availableModels={availableModels}
          loading={modelLoading}
          disabled={modelSwitching || coordinatorSwitching || isRecovering}
          busy={modelSwitching}
          thinkingLevel={thinkingLevel}
          onSelectModel={(model) => void onModelSwitch(model)}
          onSelectThinking={(level) => void handleThinkingLevelChange(level)}
        />

        <div class="h-6 w-px bg-fg-faint" />

        <ContextUsageBar contextUsage={contextUsage} maxContextTokens={maxContextTokens} />
      </div>
    </ContentContainer>
  );
}
