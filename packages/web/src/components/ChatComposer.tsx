import type {
  ContextInfo,
  MessageDeliveryMode,
  MessageImage,
  ModelInfo,
  SessionFeatures,
  SessionType,
  ThinkingLevel,
} from '@hyperneo/shared';
import type { ComponentChildren } from 'preact';
import MessageInput from './MessageInput.tsx';
import SessionStatusBar from './SessionStatusBar.tsx';
import { borderColors } from '../lib/design-tokens.ts';
import type { SessionStore } from '../lib/session-store.ts';
import { cn } from '../lib/utils.ts';
import type { RegisterFileDropTarget } from '../hooks';

export interface ChatComposerProps {
  sessionId: string;
  readonly: boolean;
  sessionStatus?: string;
  sessionType?: SessionType;
  thinkingLevel?: ThinkingLevel;
  isProcessing: boolean;
  currentAction?: string;
  streamingPhase?: 'initializing' | 'thinking' | 'streaming' | 'finalizing' | null;
  contextUsage?: ContextInfo;
  features: SessionFeatures;
  currentModel: string;
  currentModelInfo: ModelInfo | null;
  availableModels: ModelInfo[];
  modelSwitching: boolean;
  modelLoading: boolean;
  autoScroll: boolean;
  coordinatorMode: boolean;
  coordinatorSwitching: boolean;
  sandboxEnabled: boolean;
  sandboxSwitching: boolean;
  isWaitingForInput: boolean;
  isConnected: boolean;
  isRecovering?: boolean;
  onModelSwitch: (model: ModelInfo) => void;
  onAutoScrollChange: (enabled: boolean) => void;
  onCoordinatorModeChange: (enabled: boolean) => void;
  onSandboxModeChange: (enabled: boolean) => void;
  onSend: (
    content: string,
    images?: MessageImage[],
    deliveryMode?: MessageDeliveryMode
  ) => Promise<void | boolean>;
  onOpenTools: () => void;
  agentMentionCandidates?: Array<{ id: string; name: string }>;
  inputPlaceholder?: string;
  onThinkingLevelChange?: (level: ThinkingLevel) => Promise<void> | void;
  inputLeadingElement?: ComponentChildren;
  inputLeadingPaddingClass?: string;
  onDraftActiveChange?: (hasDraft: boolean) => void;
  errorMessage?: string | null;
  supportsQueueDelivery?: boolean;
  registerDropTarget?: RegisterFileDropTarget;
  store?: SessionStore;
}

export const CHAT_COMPOSER_READABILITY_SCRIM_TEST_ID = 'chat-composer-readability-scrim';

export function ChatComposer({
  sessionId,
  readonly,
  sessionStatus,
  sessionType,
  thinkingLevel,
  isProcessing,
  currentAction,
  streamingPhase,
  contextUsage,
  features,
  currentModel,
  currentModelInfo,
  availableModels,
  modelSwitching,
  modelLoading,
  autoScroll,
  coordinatorMode,
  coordinatorSwitching,
  sandboxEnabled,
  sandboxSwitching,
  isWaitingForInput,
  isConnected,
  isRecovering,
  onModelSwitch,
  onAutoScrollChange,
  onCoordinatorModeChange,
  onSandboxModeChange,
  onSend,
  onOpenTools,
  agentMentionCandidates,
  inputPlaceholder,
  inputLeadingElement,
  inputLeadingPaddingClass,
  onDraftActiveChange,
  onThinkingLevelChange,
  errorMessage,
  supportsQueueDelivery,
  registerDropTarget,
  store,
}: ChatComposerProps) {
  return (
    <div class="chat-footer absolute bottom-0 left-0 right-0 z-10 isolate pt-4 bg-transparent">
      <div
        class="pointer-events-none absolute bottom-0 left-0 right-0 z-0 h-24"
        data-testid={CHAT_COMPOSER_READABILITY_SCRIM_TEST_ID}
        aria-hidden="true"
      >
        <div class="absolute inset-0 bg-gradient-to-t from-dark-900/90 via-dark-900/40 to-transparent" />
        <div class="absolute inset-0 backdrop-blur-[1px] [mask-image:linear-gradient(to_top,black_0%,black_55%,transparent_100%)] [-webkit-mask-image:linear-gradient(to_top,black_0%,black_55%,transparent_100%)]" />
      </div>
      <div class="relative z-10">
        {errorMessage && (
          <div class="px-3 mb-1">
            <p class="rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-xs text-red-300">
              {errorMessage}
            </p>
          </div>
        )}
        <SessionStatusBar
          sessionId={sessionId}
          isProcessing={isProcessing}
          currentAction={currentAction}
          streamingPhase={streamingPhase}
          contextUsage={contextUsage}
          maxContextTokens={currentModelInfo?.contextWindow}
          currentModel={currentModel}
          currentModelInfo={currentModelInfo}
          availableModels={availableModels}
          modelSwitching={modelSwitching}
          modelLoading={modelLoading}
          onModelSwitch={onModelSwitch}
          autoScroll={autoScroll}
          onAutoScrollChange={onAutoScrollChange}
          thinkingLevel={thinkingLevel}
          onThinkingLevelChange={onThinkingLevelChange}
          coordinatorSwitching={coordinatorSwitching}
          isRecovering={isRecovering}
        />

        {sessionStatus === 'archived' || sessionStatus === 'ended' ? (
          <div class="p-4">
            <div class="max-w-4xl mx-auto">
              <div
                class={cn(
                  'rounded-3xl border px-5 py-3 text-center',
                  'bg-dark-800/60 backdrop-blur-sm',
                  borderColors.ui.default
                )}
              >
                <span class="text-gray-400 text-sm flex items-center justify-center gap-2">
                  <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"
                    />
                  </svg>
                  {sessionStatus === 'ended' ? 'Session ended' : 'Session archived'}
                </span>
              </div>
            </div>
          </div>
        ) : (
          !readonly && (
            <MessageInput
              sessionId={sessionId}
              sessionType={sessionType}
              onSend={onSend}
              disabled={
                isWaitingForInput ||
                !isConnected ||
                isRecovering ||
                modelSwitching ||
                coordinatorSwitching ||
                sandboxSwitching
              }
              autoScroll={autoScroll}
              onAutoScrollChange={onAutoScrollChange}
              onOpenTools={onOpenTools}
              agentMentionCandidates={agentMentionCandidates}
              placeholder={inputPlaceholder}
              leadingElement={inputLeadingElement}
              leadingPaddingClass={inputLeadingPaddingClass}
              onDraftActiveChange={onDraftActiveChange}
              isProcessing={isProcessing}
              supportsQueueDelivery={supportsQueueDelivery}
              registerDropTarget={registerDropTarget}
              coordinatorMode={coordinatorMode}
              coordinatorSwitching={coordinatorSwitching}
              onCoordinatorModeChange={onCoordinatorModeChange}
              sandboxEnabled={sandboxEnabled}
              sandboxSwitching={sandboxSwitching}
              onSandboxModeChange={onSandboxModeChange}
              features={features}
              store={store}
            />
          )
        )}
      </div>
    </div>
  );
}
