import type { MessageDeliveryMode, MessageImage, SpaceTaskActivityMember } from '@hyperneo/shared';
import type { Ref } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import { ChatComposer } from '../ChatComposer.tsx';
import {
  useTargetSessionContext,
  type TaskComposerTarget,
  type RegisterFileDropTarget,
} from '../../hooks';
import { cn } from '../../lib/utils.ts';
import { getAgentColor } from './thread/space-task-thread-agent-colors';
import { agentInitial } from './thread/minimal/minimal-mock-data';
import { TaskToolsModal } from './TaskToolsModal.tsx';

interface TaskSessionChatComposerProps {
  mentionCandidates: Array<{ id: string; name: string }>;
  targets: TaskComposerTarget[];
  selectedTargetId: string | null;
  canSend: boolean;
  isSending: boolean;
  isProcessing?: boolean;
  autoScroll: boolean;
  errorMessage?: string | null;
  activityMembers: SpaceTaskActivityMember[];
  defaultAgentModels?: Map<string, string>;
  taskId: string;
  onAutoScrollChange: (enabled: boolean) => void;
  onTargetSelect: (targetId: string) => void;
  onDraftActiveChange?: (hasDraft: boolean) => void;
  onComposerRef?: Ref<HTMLDivElement>;
  onSend: (
    message: string,
    target: TaskComposerTarget | null,
    images?: MessageImage[],
    deliveryMode?: MessageDeliveryMode
  ) => Promise<boolean>;
  registerDropTarget?: RegisterFileDropTarget;
}

export function TaskCanvasToggleButton({
  active,
  onClick,
  class: className,
}: {
  active: boolean;
  onClick: () => void;
  class?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      class={cn(
        'inline-flex h-8 w-8 items-center justify-center rounded-full border shadow-sm transition-all focus:outline-none focus:ring-2 focus:ring-info/60 active:scale-95',
        active
          ? 'border-sky-400/40 bg-sky-500/15 text-info-soft ring-1 ring-info/30'
          : 'border-line-strong bg-surface-overlay/90 text-fg-muted hover:border-sky-500/40 hover:bg-sky-500/10 hover:text-info-soft',
        className
      )}
      data-testid="canvas-toggle"
      aria-label={active ? 'Hide canvas' : 'Show canvas'}
      aria-pressed={active}
      title={active ? 'Hide canvas' : 'Show canvas'}
    >
      <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width={2}
          d="M5.5 5.5h13v13h-13z"
        />
      </svg>
    </button>
  );
}

export function TaskSessionChatComposer({
  mentionCandidates,
  targets,
  selectedTargetId,
  canSend,
  isSending,
  isProcessing: _isProcessingProp,
  autoScroll,
  errorMessage,
  activityMembers,
  defaultAgentModels,
  taskId,
  onAutoScrollChange,
  onTargetSelect,
  onDraftActiveChange,
  onComposerRef,
  onSend,
  registerDropTarget,
}: TaskSessionChatComposerProps) {
  const [targetMenuOpen, setTargetMenuOpen] = useState(false);
  const [toolsModalOpen, setToolsModalOpen] = useState(false);

  const selectedTarget = useMemo(
    () => targets.find((target) => target.id === selectedTargetId) ?? targets[0] ?? null,
    [targets, selectedTargetId]
  );
  const selectedTargetColor = selectedTarget ? getAgentColor(selectedTarget.label) : '#66A7FF';
  const selectedTargetInitial = selectedTarget ? agentInitial(selectedTarget.label) : 'A';

  const {
    targetSessionId,
    currentModel,
    currentModelInfo,
    availableModels,
    modelSwitching,
    modelLoading,
    thinkingLevel,
    contextInfo,
    isProcessing: targetIsProcessing,
    isStarted,
    switchModel,
    setThinkingLevel,
  } = useTargetSessionContext({
    taskId,
    targets,
    selectedTarget,
    activityMembers,
    defaultAgentModels,
  });

  const handleSend = async (
    content: string,
    images?: MessageImage[],
    deliveryMode?: MessageDeliveryMode
  ): Promise<boolean> => {
    return onSend(content, selectedTarget, images, deliveryMode);
  };

  const handleOpenTools = () => {
    setToolsModalOpen(true);
  };

  const isNotStarted = selectedTarget?.kind === 'node_agent' && !isStarted;

  const targetPicker =
    targets.length > 0 ? (
      <div class="relative">
        <button
          type="button"
          class={cn(
            'group inline-flex h-9 w-9 items-center justify-center rounded-full border border-surface/30 text-sm font-bold text-accent-fg shadow-sm ring-1 ring-line/10 transition-transform hover:scale-105 focus:outline-none focus:ring-2 focus:ring-accent/70 active:scale-95',
            isNotStarted && 'ring-amber-400/40'
          )}
          style={{ backgroundColor: selectedTargetColor }}
          onClick={() => setTargetMenuOpen((open) => !open)}
          data-testid="task-composer-target-trigger"
          aria-label="Select message recipient"
          aria-haspopup="menu"
          aria-expanded={targetMenuOpen}
          title={selectedTarget ? `Send to ${selectedTarget.label}` : 'Select recipient'}
        >
          <span>{selectedTargetInitial}</span>
        </button>
        {targetMenuOpen && (
          <div
            class="absolute bottom-full left-0 z-50 mb-2 w-64 overflow-hidden rounded-lg border border-line bg-surface-overlay shadow-xl shadow-black/30"
            data-testid="task-composer-target-menu"
          >
            <div class="border-b border-line px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-fg-muted">
              Send Message To
            </div>
            <div class="max-h-72 overflow-y-auto py-1">
              {targets.map((target) => (
                <button
                  key={target.id}
                  type="button"
                  class={cn(
                    'flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-fill-strong/70',
                    target.id === selectedTarget?.id && 'bg-accent/15 text-accent-soft'
                  )}
                  onClick={() => {
                    onTargetSelect(target.id);
                    setTargetMenuOpen(false);
                  }}
                  data-testid="task-composer-target-option"
                >
                  <span class="min-w-0">
                    <span class="block truncate text-fg">{target.label}</span>
                    <span class="block truncate text-xs text-fg-muted">
                      {`${target.nodeName ?? 'Workflow'}${target.state ? ` · ${target.state}` : ''}`}
                    </span>
                  </span>
                  {target.id === selectedTarget?.id && (
                    <span class="text-xs font-medium text-accent-soft">Selected</span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    ) : null;

  return (
    <div ref={onComposerRef} class="relative z-10" data-testid="task-session-chat-composer">
      {isNotStarted && (
        <div class="px-3 pb-1">
          <div class="flex items-center gap-1.5 rounded border border-warning/20 bg-warning/10 px-2 py-1">
            <svg
              class="w-3 h-3 text-warning flex-shrink-0"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            <span class="text-[11px] text-warning">
              {selectedTarget?.label} hasn't started yet — model and thinking pre-configuration will
              apply when the session spawns.
            </span>
          </div>
        </div>
      )}
      <ChatComposer
        sessionId={targetSessionId ?? ''}
        readonly={false}
        isProcessing={targetIsProcessing}
        supportsQueueDelivery
        thinkingLevel={thinkingLevel}
        features={{
          coordinator: false,
          worktree: false,
          rewind: false,
          archive: false,
          sessionInfo: false,
        }}
        currentModel={currentModel}
        currentModelInfo={currentModelInfo}
        availableModels={availableModels}
        modelSwitching={modelSwitching}
        modelLoading={modelLoading}
        contextUsage={contextInfo ?? undefined}
        autoScroll={autoScroll}
        coordinatorMode={false}
        coordinatorSwitching={false}
        sandboxEnabled={false}
        sandboxSwitching={false}
        isWaitingForInput={!canSend || isSending}
        isConnected={true}
        onModelSwitch={switchModel}
        onAutoScrollChange={onAutoScrollChange}
        onCoordinatorModeChange={() => {}}
        onSandboxModeChange={() => {}}
        onSend={handleSend}
        onOpenTools={handleOpenTools}
        onThinkingLevelChange={setThinkingLevel}
        agentMentionCandidates={mentionCandidates}
        inputPlaceholder={
          selectedTarget ? `Message ${selectedTarget.label}...` : 'Select a target agent...'
        }
        inputLeadingElement={targetPicker}
        inputLeadingPaddingClass={targetPicker ? 'pl-12' : undefined}
        onDraftActiveChange={onDraftActiveChange}
        errorMessage={errorMessage}
        registerDropTarget={registerDropTarget}
      />
      <TaskToolsModal
        isOpen={toolsModalOpen}
        onClose={() => setToolsModalOpen(false)}
        sessionId={targetSessionId}
        agentLabel={selectedTarget?.label ?? ''}
      />
    </div>
  );
}
