import { useState, useCallback, useRef, useEffect } from 'preact/hooks';
import type { RefObject } from 'preact';
import type { Signal } from '@preact/signals';
import type { MessageImage } from '@hyperneo/shared';
import { useFileAttachments, type AttachmentWithMetadata } from './useFileAttachments';
import { useAutoScroll } from './useAutoScroll';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

export interface UseChatBaseOptions<T = ChatMessage> {
  chatId: string;

  sendMessage: (content: string, images?: MessageImage[]) => Promise<void>;

  messages?: Signal<T[]>;

  autoScrollEnabled?: boolean;

  nearBottomThreshold?: number;

  persistDraft?: boolean;

  loadDraft?: () => Promise<string | undefined>;

  saveDraft?: (content: string) => Promise<void>;

  maxChars?: number;

  onValidationError?: (error: string) => void;
}

export interface UseChatBaseReturn {
  input: string;
  setInput: (content: string) => void;
  handleInput: (e: Event) => void;

  sending: boolean;
  sendMessage: () => Promise<void>;
  canSend: boolean;

  handleKeyDown: (e: KeyboardEvent) => void;

  attachments: AttachmentWithMetadata[];
  fileInputRef: RefObject<HTMLInputElement>;
  handleFileSelect: (e: Event) => Promise<void>;
  handleFileDrop: (files: File[]) => void;
  handleRemoveAttachment: (index: number) => void;
  openFilePicker: () => void;
  handlePaste: (e: ClipboardEvent) => Promise<void>;
  clearAttachments: () => void;
  restoreAttachments: (attachments: AttachmentWithMetadata[]) => void;

  messagesContainerRef: RefObject<HTMLDivElement>;
  messagesEndRef: RefObject<HTMLDivElement>;
  showScrollButton: boolean;
  scrollToBottom: (smooth?: boolean) => void;

  error: string | null;
  clearError: () => void;
}

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

  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const fileAttachments = useFileAttachments();

  const messageCount = messages?.value?.length ?? 0;

  const { showScrollButton, scrollToBottom } = useAutoScroll({
    containerRef: messagesContainerRef,
    endRef: messagesEndRef,
    enabled: autoScrollEnabled,
    messageCount,
    nearBottomThreshold,
  });

  useEffect(() => {
    if (persistDraft && loadDraft) {
      loadDraft().then((draft) => {
        if (draft) {
          setInput(draft);
        }
      });
    }
  }, [chatId, persistDraft, loadDraft]);

  const saveDraftTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!persistDraft || !saveDraft) return;

    if (saveDraftTimeoutRef.current) {
      clearTimeout(saveDraftTimeoutRef.current);
    }

    saveDraftTimeoutRef.current = setTimeout(() => {
      saveDraft(input);
    }, 500);

    return () => {
      if (saveDraftTimeoutRef.current) {
        clearTimeout(saveDraftTimeoutRef.current);
      }
    };
  }, [input, persistDraft, saveDraft]);

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

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const handleInput = useCallback(
    (e: Event) => {
      const target = e.target as HTMLTextAreaElement | HTMLInputElement;
      setInput(target.value);
      clearError();
    },
    [clearError]
  );

  const resetInput = useCallback(() => {
    setInput('');
    fileAttachments.clear();
    clearError();
  }, [fileAttachments, clearError]);

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
      scrollToBottom();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to send message';
      setError(errorMessage);
    } finally {
      setSending(false);
    }
  }, [input, validateInput, fileAttachments, sendMessageFn, resetInput, scrollToBottom]);

  const canSend = !sending;

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
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

  const handleFileDrop = useCallback(
    (files: File[]) => {
      const dataTransfer = new DataTransfer();
      for (const file of files) {
        dataTransfer.items.add(file);
      }
      fileAttachments.handleFileDrop(dataTransfer.files);
    },
    [fileAttachments]
  );

  const handlePaste = useCallback(
    async (e: ClipboardEvent) => {
      fileAttachments.handlePaste(e);
    },
    [fileAttachments]
  );

  const handleFileSelect = useCallback(
    async (e: Event) => {
      await fileAttachments.handleFileSelect(e);
    },
    [fileAttachments]
  );

  return {
    input,
    setInput,
    handleInput,

    sending,
    sendMessage: handleSendMessage,
    canSend,

    handleKeyDown,

    attachments: fileAttachments.attachments,
    fileInputRef: fileAttachments.fileInputRef,
    handleFileSelect,
    handleFileDrop,
    handleRemoveAttachment: fileAttachments.handleRemove,
    openFilePicker: fileAttachments.openFilePicker,
    handlePaste,
    clearAttachments: fileAttachments.clear,
    restoreAttachments: fileAttachments.restore,

    messagesContainerRef,
    messagesEndRef,
    showScrollButton,
    scrollToBottom,

    error,
    clearError,
  };
}
