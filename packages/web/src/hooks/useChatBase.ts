/**
 * useChatBase Hook
 *
 * A unified chat interface hook that composes reusable hooks (useFileAttachments,
 * useAutoScroll) with input management, message sending, and keyboard handling.
 *
 * This hook provides a complete foundation for chat UI components, handling:
 * - Text input state and validation
 * - File attachments (images) with drag/drop/paste support
 * - Auto-scroll behavior
 * - Keyboard shortcuts (Enter to send, Shift+Enter for newline)
 * - Draft persistence (optional)
 * - Error handling
 *
 * @example
 * ```typescript
 * const chat = useChatBase({
 *   chatId: sessionId,
 *   sendMessage: async (content, images) => {
 *     await hub.request('agent.sendMessage', { sessionId, content, images });
 *   },
 *   messages: sessionMessages,
 * });
 *
 * // In your JSX:
 * <input
 *   value={chat.input}
 *   onInput={chat.handleInput}
 *   onKeyDown={chat.handleKeyDown}
 * />
 * <button onClick={chat.sendMessage} disabled={!chat.canSend}>Send</button>
 * ```
 */

import { useState, useCallback, useRef, useEffect } from 'preact/hooks';
import type { RefObject } from 'preact';
import type { Signal } from '@preact/signals';
import type { MessageImage } from '@neokai/shared';
import { useFileAttachments, type AttachmentWithMetadata } from './useFileAttachments';
import { useAutoScroll } from './useAutoScroll';

/** Default message type for chat when no specific type is needed */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

export interface UseChatBaseOptions<T = ChatMessage> {
  /** Unique ID for this chat (sessionId or roomId) */
  chatId: string;

  /** How to send messages - must be provided */
  sendMessage: (content: string, images?: MessageImage[]) => Promise<void>;

  /** Optional message source - if not provided, manages internally */
  messages?: Signal<T[]>;

  /** Auto-scroll config - whether auto-scroll is enabled (default: true) */
  autoScrollEnabled?: boolean;

  /** Distance from bottom to consider "near bottom" in pixels (default: 200) */
  nearBottomThreshold?: number;

  /** Whether to persist drafts (requires loadDraft/saveDraft to be provided) */
  persistDraft?: boolean;

  /** Function to load persisted draft */
  loadDraft?: () => Promise<string | undefined>;

  /** Function to save draft */
  saveDraft?: (content: string) => Promise<void>;

  /** Maximum character limit for input (default: 500000) */
  maxChars?: number;

  /** Callback for validation errors */
  onValidationError?: (error: string) => void;
}

export interface UseChatBaseReturn {
  // Input state
  input: string;
  setInput: (content: string) => void;
  handleInput: (e: Event) => void;

  // Sending
  sending: boolean;
  sendMessage: () => Promise<void>;
  canSend: boolean;

  // Keyboard handling
  handleKeyDown: (e: KeyboardEvent) => void;

  // Attachments (compose useFileAttachments)
  attachments: AttachmentWithMetadata[];
  fileInputRef: RefObject<HTMLInputElement>;
  handleFileSelect: (e: Event) => Promise<void>;
  handleFileDrop: (files: File[]) => void;
  handleRemoveAttachment: (index: number) => void;
  openFilePicker: () => void;
  handlePaste: (e: ClipboardEvent) => Promise<void>;
  clearAttachments: () => void;
  restoreAttachments: (attachments: AttachmentWithMetadata[]) => void;

  // Auto-scroll (compose useAutoScroll)
  messagesContainerRef: RefObject<HTMLDivElement>;
  messagesEndRef: RefObject<HTMLDivElement>;
  showScrollButton: boolean;
  scrollToBottom: (smooth?: boolean) => void;

  // Errors
  error: string | null;
  clearError: () => void;
}

/**
 * Unified chat interface hook that composes file attachments, auto-scroll,
 * input management, and message sending into a single cohesive interface.
 */
export function useChatBase<T = ChatMessage>(options: UseChatBaseOptions<T>): UseChatBaseReturn {
  const {
    chatId,
    sendMessage: sendMessageFn,
    messages,
    autoScrollEnabled = true,
    nearBottomThreshold = 200,
    persistDraft = false,
    loadDraft,
    saveDraft,
    maxChars = 500000,
    onValidationError,
  } = options;

  // Input state
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refs for auto-scroll
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Compose file attachments hook
  const fileAttachments = useFileAttachments();

  // Get message count for auto-scroll
  const messageCount = messages?.value?.length ?? 0;

  // Compose auto-scroll hook
  const { showScrollButton, scrollToBottom } = useAutoScroll({
    containerRef: messagesContainerRef,
    endRef: messagesEndRef,
    enabled: autoScrollEnabled,
    messageCount,
    nearBottomThreshold,
  });

  // Load draft on mount if persistence is enabled
  useEffect(() => {
    if (persistDraft && loadDraft) {
      loadDraft().then((draft) => {
        if (draft) {
          setInput(draft);
        }
      });
    }
  }, [chatId, persistDraft, loadDraft]);

  // Save draft when input changes (debounced)
  const saveDraftTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!persistDraft || !saveDraft) return;

    // Clear previous timeout
    if (saveDraftTimeoutRef.current) {
      clearTimeout(saveDraftTimeoutRef.current);
    }

    // Debounce draft saving
    saveDraftTimeoutRef.current = setTimeout(() => {
      saveDraft(input);
    }, 500);

    return () => {
      if (saveDraftTimeoutRef.current) {
        clearTimeout(saveDraftTimeoutRef.current);
      }
    };
  }, [input, persistDraft, saveDraft]);

  // Validation
  const validateInput = useCallback(
    (content: string): boolean => {
      if (!content.trim() && fileAttachments.attachments.length === 0) {
        const errorMsg = 'Message cannot be empty';
        if (onValidationError) {
          onValidationError(errorMsg);
        } else {
          setError(errorMsg);
        }
        return false;
      }

      if (content.length > maxChars) {
        const errorMsg = `Message exceeds ${maxChars.toLocaleString()} character limit`;
        if (onValidationError) {
          onValidationError(errorMsg);
        } else {
          setError(errorMsg);
        }
        return false;
      }

      return true;
    },
    [fileAttachments.attachments.length, maxChars, onValidationError]
  );

  // Clear error
  const clearError = useCallback(() => {
    setError(null);
  }, []);

  // Handle input change
  const handleInput = useCallback(
    (e: Event) => {
      const target = e.target as HTMLTextAreaElement | HTMLInputElement;
      setInput(target.value);
      clearError();
    },
    [clearError]
  );

  // Reset input and attachments after successful send
  const resetInput = useCallback(() => {
    setInput('');
    fileAttachments.clear();
    clearError();
  }, [fileAttachments, clearError]);

  // Send message
  const handleSendMessage = useCallback(async () => {
    const content = input.trim();

    if (!validateInput(content)) {
      return;
    }

    setSending(true);
    setError(null);

    try {
      const images = fileAttachments.getImagesForSend();
      await sendMessageFn(content, images);
      resetInput();
      // Scroll to bottom after sending
      scrollToBottom();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to send message';
      setError(errorMessage);
    } finally {
      setSending(false);
    }
  }, [input, validateInput, fileAttachments, sendMessageFn, resetInput, scrollToBottom]);

  // Can send if not currently sending
  const canSend = !sending;

  // Handle keyboard shortcuts
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Enter to send on desktop (no modifier keys)
      // Shift+Enter for newline (default behavior)
      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        // Only intercept if not in a mobile context (check for textarea)
        const target = e.target as HTMLTextAreaElement;
        if (target.tagName === 'TEXTAREA') {
          e.preventDefault();
          if (canSend) {
            handleSendMessage();
          }
        }
      }
    },
    [canSend, handleSendMessage]
  );

  // Handle file drop (adapted from FileList to File[])
  const handleFileDrop = useCallback(
    (files: File[]) => {
      // Create a fake FileList-like object for the hook
      const dataTransfer = new DataTransfer();
      for (const file of files) {
        dataTransfer.items.add(file);
      }
      fileAttachments.handleFileDrop(dataTransfer.files);
    },
    [fileAttachments]
  );

  // Handle paste (wrapped to return Promise)
  const handlePaste = useCallback(
    async (e: ClipboardEvent) => {
      fileAttachments.handlePaste(e);
    },
    [fileAttachments]
  );

  // Handle file select (wrapped to return Promise)
  const handleFileSelect = useCallback(
    async (e: Event) => {
      await fileAttachments.handleFileSelect(e);
    },
    [fileAttachments]
  );

  return {
    // Input state
    input,
    setInput,
    handleInput,

    // Sending
    sending,
    sendMessage: handleSendMessage,
    canSend,

    // Keyboard handling
    handleKeyDown,

    // Attachments
    attachments: fileAttachments.attachments,
    fileInputRef: fileAttachments.fileInputRef,
    handleFileSelect,
    handleFileDrop,
    handleRemoveAttachment: fileAttachments.handleRemove,
    openFilePicker: fileAttachments.openFilePicker,
    handlePaste,
    clearAttachments: fileAttachments.clear,
    restoreAttachments: fileAttachments.restore,

    // Auto-scroll
    messagesContainerRef,
    messagesEndRef,
    showScrollButton,
    scrollToBottom,

    // Errors
    error,
    clearError,
  };
}
