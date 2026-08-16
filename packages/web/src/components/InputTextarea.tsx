/**
 * InputTextarea Component
 *
 * iOS 26-style floating textarea input pill with auto-resize,
 * character counter, and send button.
 * Extracted from MessageInput.tsx for better separation of concerns.
 *
 * CURSOR PRESERVATION FIX:
 * This component uses an "uncontrolled with sync" pattern instead of the
 * standard controlled input pattern (`value={content}`). This is intentional.
 *
 * PROBLEM: Controlled inputs cause cursor position reset on every re-render.
 * When any prop changes (isAgentWorking, etc.) or when the parent re-renders,
 * Preact sets textarea.value = content. Even if the DOM already has the correct
 * value, setting element.value programmatically resets cursor position.
 *
 * SYMPTOMS:
 * - Lost keystrokes when typing fast
 * - Arrow keys "stop working" after a few presses (cursor keeps resetting)
 *
 * SOLUTION: Use useLayoutEffect to sync content to DOM only when they differ.
 * After user types, DOM already has the new value (browser updated it).
 * Our onInput updates the signal to match. On re-render, DOM === content,
 * so we skip the DOM write and cursor position is preserved.
 */

import type { ComponentChildren } from 'preact';
import type { MutableRef } from 'preact/hooks';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { cn } from '../lib/utils.ts';
import { borderColors } from '../lib/design-tokens.ts';
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
  // Command autocomplete
  showCommandAutocomplete?: boolean;
  filteredCommands?: string[];
  selectedCommandIndex?: number;
  onCommandSelect?: (command: string) => void;
  onCommandClose?: () => void;
  // Reference autocomplete
  showReferenceAutocomplete?: boolean;
  referenceResults?: ReferenceSearchResult[];
  selectedReferenceIndex?: number;
  onReferenceSelect?: (result: ReferenceSearchResult) => void;
  onReferenceClose?: () => void;
  // Agent mention autocomplete
  showAgentMentionAutocomplete?: boolean;
  agentMentionCandidates?: Array<{ id: string; name: string }>;
  selectedAgentMentionIndex?: number;
  onAgentMentionSelect?: (name: string) => void;
  /**
   * Fires on every caret/selection change of this textarea — including
   * collapsed caret moves (arrow keys, clicks) that do NOT emit the native
   * `select` event. Implemented via the document `selectionchange` event.
   */
  onSelect?: () => void;
  onAgentMentionClose?: () => void;
  // Agent state - passed as prop to avoid direct signal reads that cause re-renders
  isAgentWorking?: boolean;

  onStop?: () => void;
  onQueue?: () => void;
  onPaste?: (e: ClipboardEvent) => void;
  voiceControl?: ComponentChildren;
  /** When set, renders in place of the textarea (the voice waveform) and hides the send button / counters. */
  recordingBody?: ComponentChildren;
  /** Optional control rendered inside the input, on the left side */
  leadingElement?: ComponentChildren;
  /** Left padding class used when leadingElement is present */
  leadingPaddingClass?: string;
  /** Optional ref forwarded to the underlying textarea element */
  textareaRef?: MutableRef<HTMLTextAreaElement | null>;
  transparent?: boolean;
  onHeightChange?: (heightPx: number) => void;
}

/**
 * Floating textarea input with send/stop buttons
 */
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

  // Sync content prop to textarea DOM only when they differ
  // This prevents cursor position reset during re-renders caused by signal changes
  // or other prop updates. Using useLayoutEffect for synchronous DOM updates.
  //
  // KEY INSIGHT: When user types, the browser updates DOM value immediately.
  // Our onInput handler then updates the signal/state to match DOM.
  // On the next render, content === textarea.value, so we skip the DOM write.
  // This preserves cursor position because we never programmatically set value
  // when it already matches.
  // NOTE: `recordingBody` is a dependency because while it is shown the textarea
  // is unmounted; when it clears, a FRESH textarea mounts with an empty DOM value
  // and unchanged `content` — without this dep the sync below would not re-run
  // and the draft would render blank (while still being submitted on Send).
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    // Only update DOM if the value actually differs
    if (textarea.value !== content) {
      // Save cursor position before updating
      const { selectionStart, selectionEnd } = textarea;

      // Update value
      textarea.value = content;

      // Restore cursor position (clamped to valid range)
      // This handles external content changes (e.g., loading draft, clearing)
      const maxPos = content.length;
      textarea.setSelectionRange(Math.min(selectionStart, maxPos), Math.min(selectionEnd, maxPos));
    }
  }, [content, recordingBody]);

  // Auto-resize textarea.
  // Uses useLayoutEffect so the height is recalculated synchronously
  // before paint. This ensures the composer padding (driven by
  // syncMessagesContainerPadding in MessageInput) always measures the
  // correct footer height before auto-scroll fires on a new message.
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

  // While recording (no textarea) keep the footer height in sync with the fixed
  // 40px waveform body so the messages bottom padding stays correct.
  useEffect(() => {
    if (recordingBody) onHeightChange?.(40);
  }, [recordingBody, onHeightChange]);

  // Focus on mount, and re-focus when the textarea remounts after a recording
  // (the recording body replaces it in the DOM).
  useEffect(() => {
    if (!recordingBody) textareaRef.current?.focus();
  }, [recordingBody]);

  // Continuous caret/selection tracking. The native `select` event does not
  // fire for collapsed caret moves (plain arrow keys or clicks), so we listen
  // to the document-level `selectionchange` and forward only the events that
  // belong to THIS textarea. Consumers rely on this for voice transcript
  // placement whenever the textarea is (or is about to be) gone.
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

  // Count @ref{} tokens in content — use REFERENCE_PATTERN.source to get a fresh regex
  // instance each render, avoiding stale lastIndex from the shared global-flag regex.
  const refCount = [...content.matchAll(new RegExp(REFERENCE_PATTERN.source, 'g'))].length;

  // Shared agent Stop-generation button (normal right cluster only). It is NOT
  // rendered while recording: the recording row has its own red stop (the mic
  // slot) and two stop buttons must never coexist. The agent keeps running and
  // can be stopped again once the recording ends (a transcription can run up
  // to ~2 min).
  const renderAgentStopButton = () => (
    <button
      type="button"
      onClick={onStop}
      disabled={disabled}
      title="Stop generation"
      aria-label="Stop generation"
      data-testid="stop-button"
      class={cn(
        'w-9 h-9 rounded-full flex items-center justify-center transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60',
        !disabled
          ? 'bg-red-500/90 text-white hover:bg-red-600 active:scale-95'
          : 'bg-dark-700/50 text-gray-500 cursor-not-allowed'
      )}
    >
      <svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
        <rect x="6" y="6" width="12" height="12" rx="2" />
      </svg>
    </button>
  );

  return (
    <div class="relative min-w-0 flex-1">
      {/* Autocomplete menus — only one shown at a time; agent mention takes highest priority */}
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
          transparent ? 'bg-transparent backdrop-blur-sm' : 'bg-dark-800/60 backdrop-blur-sm',
          disabled
            ? borderColors.ui.disabled
            : transparent
              ? 'border-dark-600/80 focus-within:bg-dark-800/30'
              : `${borderColors.ui.input} focus-within:bg-dark-800/80`
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
        {/* Textarea - Uncontrolled with sync pattern
				    We DON'T use value={content} here because controlled inputs cause
				    cursor position reset on every re-render. Instead, we sync content
				    to the DOM via useLayoutEffect only when they actually differ.
				    See the useLayoutEffect above for details. */}
        {recordingBody ? (
          // Recording row: waveform + voice controls laid out in flow (no
          // absolute positioning), so nothing can overlap regardless of how
          // many controls the parent passes in. Symmetric 6px insets (pl-1.5 /
          // pr-1.5) seat the X (cancel) and the stop/send buttons flush into
          // the pill's rounded ends, tracing its curve.
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
              `block w-full ${textareaLeftPadding} ${textareaRightPadding} py-2.5 text-gray-100 resize-none bg-transparent`,
              'placeholder:text-gray-500 text-base leading-normal',
              'focus:outline-none'
            )}
            style={{
              height: '40px',
              maxHeight: '200px',
            }}
          />
        )}

        {/* Character Counter */}
        {!recordingBody && showCharCount && (
          <div
            class={cn(
              'absolute top-1 right-14 text-xs',
              charCount >= maxChars ? 'text-red-400' : 'text-gray-500'
            )}
          >
            {charCount}/{maxChars}
          </div>
        )}

        {/* Reference Badge — shows count of @ref{} tokens in content */}
        {!recordingBody && refCount > 0 && (
          <div
            class="absolute -bottom-6 left-0 flex items-center gap-1 text-xs text-gray-400"
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

        {/* Send or Stop Button — hidden while recording; the voice controls are
            rendered in the in-flow recording row above instead. */}
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
                      'w-9 h-9 rounded-full border flex items-center justify-center transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60',
                      hasContent && !disabled
                        ? 'border-blue-400/30 bg-blue-500/10 text-blue-200 hover:bg-blue-500/20 hover:text-blue-100 active:scale-95'
                        : 'border-dark-700/40 bg-dark-700/50 text-gray-500 cursor-not-allowed'
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
                        ? 'bg-amber-400 text-dark-950 hover:bg-amber-300 active:scale-95 focus-visible:ring-amber-300/70'
                        : 'bg-blue-500 text-white hover:bg-blue-600 active:scale-95 focus-visible:ring-blue-400/70'
                      : 'bg-dark-700/50 text-gray-500 cursor-not-allowed'
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
