import type { ContextInfo, ModelInfo, SessionConfig, ThinkingLevel } from '@hyperneo/shared';
import {
  oxapCodexDefaultThinking,
  oxapThinkingOptions,
} from '@hyperneo/shared/types/oxap-harnesses';
import { useSignalEffect } from '@preact/signals';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { useMessageHub } from '../hooks';
import { type ConnectionState, connectionState } from '../lib/state.ts';
import ConnectionStatus from './ConnectionStatus.tsx';
import ContextUsageBar from './ContextUsageBar.tsx';
import { ModelPicker } from './ModelPicker.tsx';
import { toast } from '../lib/toast.ts';
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
  modelLocked?: boolean;
  modelLoading: boolean;
  onModelSwitch: (model: ModelInfo) => void;
  harness?: SessionConfig['harness'];
  provider?: string;
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
  modelLocked,
  modelLoading,
  onModelSwitch,
  harness,
  provider,
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

  const defaultThinking =
    (harness === 'oxap-codex' && oxapCodexDefaultThinking(currentModelInfo)) || 'off';
  const options = oxapThinkingOptions(harness, currentModelInfo);
  const currentThinking = options.some(({ value }) => value === thinkingLevelProp)
    ? (thinkingLevelProp ?? defaultThinking)
    : defaultThinking;
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(currentThinking);
  useEffect(() => setThinkingLevel(currentThinking), [currentThinking]);

  const handleThinkingLevelChange = useCallback(
    async (level: ThinkingLevel) => {
      if (harness === 'oxap-codex') {
        try {
          const result = await callIfConnected<{ success: boolean }>('session.thinking.set', {
            sessionId: _sessionId,
            level,
          });
          if (result?.success) setThinkingLevel(level);
        } catch (error) {
          toast.error(error instanceof Error ? error.message : String(error));
        }
        return;
      }
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
    [_sessionId, callIfConnected, harness, onThinkingLevelChange]
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
          harness={harness ?? 'sdk'}
          provider={provider}
          loading={modelLoading}
          disabled={modelLocked || modelSwitching || coordinatorSwitching || isRecovering}
          busy={modelSwitching}
          thinkingLevel={thinkingLevel}
          thinkingOptions={options}
          onSelectModel={(model) => void onModelSwitch(model)}
          onSelectThinking={(level) => void handleThinkingLevelChange(level)}
        />

        <div class="h-6 w-px bg-fg-faint" />

        <ContextUsageBar contextUsage={contextUsage} maxContextTokens={maxContextTokens} />
      </div>
    </ContentContainer>
  );
}
