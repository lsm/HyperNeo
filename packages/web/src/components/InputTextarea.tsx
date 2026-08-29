import type { ComponentChildren } from 'preact';
import type { MutableRef } from 'preact/hooks';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { cn } from '../lib/utils.ts';
import CommandAutocomplete from './CommandAutocomplete.tsx';
import ReferenceAutocomplete from './ReferenceAutocomplete.tsx';
import MentionAutocomplete from './space/MentionAutocomplete.tsx';
import type { ReferenceSearchResult } from '@hyperneo/shared';
import { REFERENCE_PATTERN } from '@hyperneo/shared';

export interface InputTextareaProps {
  content: string;
  onContentChange: (content: string) => void;
  onKeyDown: (e: KeyboardEvent) => void;
  onSubmit: () => void;
  disabled?: boolean;
  maxChars?: number;
  placeholder?: string;
  showCommandAutocomplete?: boolean;
  filteredCommands?: string[];
  selectedCommandIndex?: number;
  onCommandSelect?: (command: string) => void;
  onCommandClose?: () => void;
  showReferenceAutocomplete?: boolean;
  referenceResults?: ReferenceSearchResult[];
  selectedReferenceIndex?: number;
  onReferenceSelect?: (result: ReferenceSearchResult) => void;
  onReferenceClose?: () => void;
  showAgentMentionAutocomplete?: boolean;
  agentMentionCandidates?: Array<{ id: string; name: string }>;
  selectedAgentMentionIndex?: number;
  onAgentMentionSelect?: (name: string) => void;
  onSelect?: () => void;
  onAgentMentionClose?: () => void;
  isAgentWorking?: boolean;

  onStop?: () => void;
  onQueue?: () => void;
  onPaste?: (e: ClipboardEvent) => void;
  voiceControl?: ComponentChildren;
  recordingBody?: ComponentChildren;
  leadingElement?: ComponentChildren;
  leadingPaddingClass?: string;
  textareaRef?: MutableRef<HTMLTextAreaElement | null>;
  transparent?: boolean;
  onHeightChange?: (heightPx: number) => void;
}

export function InputTextarea({
  content,
  onContentChange,
  onKeyDown,
  onSubmit,
  disabled,
  maxChars = 100000,
  placeholder = 'Ask or make anything...',
  showAgentMentionAutocomplete = false,
  agentMentionCandidates = [],
  selectedAgentMentionIndex = 0,
  onAgentMentionSelect,
  onSelect,
  onAgentMentionClose,
  showCommandAutocomplete = false,
  filteredCommands = [],
  selectedCommandIndex = 0,
  onCommandSelect,
  onCommandClose,
  showReferenceAutocomplete = false,
  referenceResults,
  selectedReferenceIndex,
  onReferenceSelect,
  onReferenceClose,
  isAgentWorking = false,
  onStop,
  onQueue,
  onPaste,
  voiceControl,
  recordingBody,
  leadingElement,
  leadingPaddingClass,
  textareaRef: externalTextareaRef,
  transparent = false,
  onHeightChange,
}: InputTextareaProps) {
  const internalTextareaRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = externalTextareaRef ?? internalTextareaRef;
  const [isMultiline, setIsMultiline] = useState(false);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    if (textarea.value !== content) {
      const { selectionStart, selectionEnd } = textarea;

      textarea.value = content;

      const maxPos = content.length;
      textarea.setSelectionRange(Math.min(selectionStart, maxPos), Math.min(selectionEnd, maxPos));
    }
  }, [content, recordingBody]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.style.height = 'auto';
    textarea.style.minHeight = '40px';
    const newHeight = Math.min(Math.max(40, textarea.scrollHeight), 200);
    textarea.style.height = `${newHeight}px`;
    setIsMultiline(newHeight > 45);
    onHeightChange?.(newHeight);
  }, [content, onHeightChange, recordingBody]);

  useEffect(() => {
    if (recordingBody) onHeightChange?.(40);
  }, [recordingBody, onHeightChange]);

  useEffect(() => {
    if (!recordingBody) textareaRef.current?.focus();
  }, [recordingBody]);

  useEffect(() => {
    if (!onSelect) return;
    const handler = () => {
      const active = document.activeElement;
      if (active && textareaRef.current && active === textareaRef.current) {
        onSelect();
      }
    };
    document.addEventListener('selectionchange', handler);
    return () => {
      document.removeEventListener('selectionchange', handler);
    };
  }, [onSelect, textareaRef]);

  const charCount = content.length;
  const showCharCount = charCount > maxChars * 0.8;
  const hasContent = content.trim().length > 0;
  const showStop = isAgentWorking && !hasContent && !!onStop;
  const showQueue = isAgentWorking && hasContent && !!onQueue;
  const textareaLeftPadding = leadingElement ? (leadingPaddingClass ?? 'pl-28') : 'pl-5';
  const controlCount = 1 + (showQueue ? 1 : 0) + (voiceControl ? 1 : 0);
  const textareaRightPadding = controlCount >= 3 ? 'pr-36' : controlCount === 2 ? 'pr-24' : 'pr-14';

  const refCount = [...content.matchAll(new RegExp(REFERENCE_PATTERN.source, 'g'))].length;

  const renderAgentStopButton = () => (
    <button
      type="button"
      onClick={onStop}
      disabled={disabled}
      title="Stop generation"
      aria-label="Stop generation"
      data-testid="stop-button"
      class={cn(
        'w-9 h-9 rounded-full flex items-center justify-center transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/60',
        !disabled
          ? 'bg-danger/90 text-on-danger hover:bg-danger active:scale-95'
          : 'bg-fill-strong/50 text-fg-faint cursor-not-allowed'
      )}
    >
      <svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
        <rect x="6" y="6" width="12" height="12" rx="2" />
      </svg>
    </button>
  );

  return (
    <div class="relative min-w-0 flex-1">
      {showAgentMentionAutocomplete && onAgentMentionSelect && onAgentMentionClose ? (
        <MentionAutocomplete
          agents={agentMentionCandidates}
          selectedIndex={selectedAgentMentionIndex}
          onSelect={onAgentMentionSelect}
          onClose={onAgentMentionClose}
        />
      ) : showReferenceAutocomplete && onReferenceSelect && onReferenceClose ? (
        <ReferenceAutocomplete
          results={referenceResults ?? []}
          selectedIndex={selectedReferenceIndex ?? 0}
          onSelect={onReferenceSelect}
          onClose={onReferenceClose}
        />
      ) : (
        showCommandAutocomplete &&
        onCommandSelect &&
        onCommandClose && (
          <CommandAutocomplete
            commands={filteredCommands}
            selectedIndex={selectedCommandIndex}
            onSelect={onCommandSelect}
            onClose={onCommandClose}
          />
        )
      )}

      <div
        class={cn(
          'relative rounded-3xl border transition-all',
          transparent ? 'bg-transparent backdrop-blur-sm' : 'bg-surface-raised/60 backdrop-blur-sm',
          disabled
            ? 'border-line/30'
            : transparent
              ? 'border-line-strong/80 focus-within:bg-surface-raised/30'
              : 'border-line-strong focus-within:bg-surface-raised/80'
        )}
      >
        {leadingElement && !recordingBody && (
          <div
            class={cn(
              'absolute left-1.5 z-10',
              isMultiline ? 'bottom-1.5' : 'top-1/2 -translate-y-1/2'
            )}
          >
            {leadingElement}
          </div>
        )}
        {recordingBody ? (
          <div class="flex h-10 w-full items-center gap-2 pl-1.5 pr-1.5">
            <div class="min-w-0 flex-1">{recordingBody}</div>
            {voiceControl}
          </div>
        ) : (
          <textarea
            ref={textareaRef}
            onInput={(e) => onContentChange((e.target as HTMLTextAreaElement).value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            disabled={disabled}
            placeholder={placeholder}
            maxLength={maxChars}
            rows={1}
            class={cn(
              `block w-full ${textareaLeftPadding} ${textareaRightPadding} py-2.5 text-fg resize-none bg-transparent`,
              'placeholder:text-fg-faint text-base leading-normal',
              'focus:outline-none'
            )}
            style={{
              height: '40px',
              maxHeight: '200px',
            }}
          />
        )}

        {!recordingBody && showCharCount && (
          <div
            class={cn(
              'absolute top-1 right-14 text-xs',
              charCount >= maxChars ? 'text-danger' : 'text-fg-faint'
            )}
          >
            {charCount}/{maxChars}
          </div>
        )}

        {!recordingBody && refCount > 0 && (
          <div
            class="absolute -bottom-6 left-0 flex items-center gap-1 text-xs text-fg-muted"
            data-testid="reference-badge"
          >
            <svg
              class="w-3 h-3"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              stroke-width={2}
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"
              />
            </svg>
            <span>
              {refCount} {refCount === 1 ? 'reference' : 'references'}
            </span>
          </div>
        )}

        {!recordingBody && (
          <div
            class={cn(
              'absolute right-1.5 flex items-center gap-3',
              isMultiline ? 'bottom-1.5' : 'top-1/2 -translate-y-1/2'
            )}
          >
            {voiceControl}
            {showStop ? (
              renderAgentStopButton()
            ) : (
              <>
                {showQueue && (
                  <button
                    type="button"
                    onClick={onQueue}
                    disabled={disabled || !hasContent}
                    title="Queue for next turn (Tab)"
                    aria-label="Queue for next turn"
                    data-testid="queue-button"
                    class={cn(
                      'w-9 h-9 rounded-full border flex items-center justify-center transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
                      hasContent && !disabled
                        ? 'border-blue-400/30 bg-accent/10 text-accent-soft hover:bg-accent/20 hover:text-accent-soft active:scale-95'
                        : 'border-line/40 bg-fill-strong/50 text-fg-faint cursor-not-allowed'
                    )}
                  >
                    <svg
                      class="w-4 h-4"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      stroke-width={2.3}
                    >
                      <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        d="M4 7h11a4 4 0 010 8H7m0 0l3-3m-3 3l3 3"
                      />
                    </svg>
                  </button>
                )}
                <button
                  type="button"
                  onClick={onSubmit}
                  disabled={disabled || !hasContent}
                  title={
                    isAgentWorking
                      ? 'Steer current turn (Enter or Cmd+Enter)'
                      : 'Send message (Enter or Cmd+Enter)'
                  }
                  aria-label={isAgentWorking ? 'Steer current turn' : 'Send message'}
                  data-testid="send-button"
                  class={cn(
                    'w-9 h-9 rounded-full flex items-center justify-center transition-all duration-200 focus-visible:outline-none focus-visible:ring-2',
                    hasContent && !disabled
                      ? isAgentWorking
                        ? 'bg-warning text-on-warning hover:bg-warning active:scale-95 focus-visible:ring-warning/70'
                        : 'bg-accent text-accent-fg hover:bg-accent-hover active:scale-95 focus-visible:ring-accent/70'
                      : 'bg-fill-strong/50 text-fg-faint cursor-not-allowed'
                  )}
                >
                  <svg
                    class="w-4.5 h-4.5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    stroke-width={2.5}
                  >
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      d="M5 10l7-7m0 0l7 7m-7-7v18"
                    />
                  </svg>
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
