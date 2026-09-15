import type { RefObject } from 'preact';
import { useCallback, useLayoutEffect, useRef } from 'preact/hooks';
import { useSignal } from '@preact/signals';
import type { MessageImage } from '@hyperneo/shared';
import { toast } from '../lib/toast.ts';
import { fileToBase64, validateImageFile, extractImagesFromClipboard } from '../lib/file-utils.ts';
import {
  composerAttachmentsSignal,
  EMPTY_ATTACHMENTS,
  readPendingComposerAttachments,
  writePendingComposerAttachments,
} from '../lib/composer-attachment-store.ts';

export interface AttachmentWithMetadata extends MessageImage {
  name: string;
  size: number;
}

export interface UseFileAttachmentsResult {
  attachments: AttachmentWithMetadata[];
  fileInputRef: RefObject<HTMLInputElement>;
  handleFileSelect: (e: Event) => Promise<void>;
  handleFileDrop: (files: FileList) => Promise<void>;
  handleRemove: (index: number) => void;
  clear: () => void;
  restore: (attachments: AttachmentWithMetadata[]) => void;
  restoreAfterFailedSend: (attachments: AttachmentWithMetadata[]) => void;
  openFilePicker: () => void;
  getImagesForSend: () => MessageImage[] | undefined;
  handlePaste: (e: ClipboardEvent) => void;
}

export function useFileAttachments(sessionId?: string): UseFileAttachmentsResult {
  const ephemeralAttachments = useSignal<AttachmentWithMetadata[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const attachments = sessionId
    ? (composerAttachmentsSignal.value[sessionId] ?? EMPTY_ATTACHMENTS)
    : ephemeralAttachments.value;

  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const setAttachments = useCallback(
    (update: (prev: AttachmentWithMetadata[]) => AttachmentWithMetadata[]) => {
      const currentSessionId = sessionIdRef.current;
      if (currentSessionId) {
        writePendingComposerAttachments(
          currentSessionId,
          update(readPendingComposerAttachments(currentSessionId))
        );
      } else {
        ephemeralAttachments.value = update(ephemeralAttachments.value);
      }
    },
    [ephemeralAttachments]
  );

  const prevSessionIdRef = useRef(sessionId);
  useLayoutEffect(() => {
    const prevSessionId = prevSessionIdRef.current;
    prevSessionIdRef.current = sessionId;
    if (prevSessionId || !sessionId) return;
    const ephemeral = ephemeralAttachments.peek();
    if (ephemeral.length === 0) return;
    writePendingComposerAttachments(sessionId, [
      ...readPendingComposerAttachments(sessionId),
      ...ephemeral,
    ]);
    ephemeralAttachments.value = [];
  }, [sessionId, ephemeralAttachments]);

  const processFiles = useCallback(
    async (files: FileList | File[]) => {
      for (const file of Array.from(files)) {
        const error = validateImageFile(file);
        if (error) {
          toast.error(error);
          continue;
        }

        try {
          const base64Data = await fileToBase64(file);
          setAttachments((prev) => [
            ...prev,
            {
              data: base64Data,
              media_type: file.type as MessageImage['media_type'],
              name: file.name,
              size: file.size,
            },
          ]);
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : `Failed to read ${file.name}`;
          toast.error(errorMessage);
        }
      }
    },
    [setAttachments]
  );

  const handleFileSelect = useCallback(
    async (e: Event) => {
      const input = e.target as HTMLInputElement;
      const files = input.files;
      if (!files || files.length === 0) return;

      await processFiles(files);
      input.value = '';
    },
    [processFiles]
  );

  const handleFileDrop = useCallback(
    async (files: FileList) => {
      await processFiles(files);
    },
    [processFiles]
  );

  const handlePaste = useCallback(
    async (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      const imageFiles = extractImagesFromClipboard(items);
      if (imageFiles.length === 0) return;

      await processFiles(imageFiles);
    },
    [processFiles]
  );

  const handleRemove = useCallback(
    (index: number) => {
      setAttachments((prev) => prev.filter((_, i) => i !== index));
    },
    [setAttachments]
  );

  const clear = useCallback(() => {
    setAttachments(() => []);
  }, [setAttachments]);

  const restore = useCallback(
    (items: AttachmentWithMetadata[]) => {
      setAttachments(() => items);
    },
    [setAttachments]
  );

  const restoreAfterFailedSend = useCallback(
    (items: AttachmentWithMetadata[]) => {
      setAttachments((prev) => {
        const savedData = new Set(items.map((item) => item.data));
        return [...items, ...prev.filter((item) => !savedData.has(item.data))];
      });
    },
    [setAttachments]
  );

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const getImagesForSend = useCallback((): MessageImage[] | undefined => {
    if (attachments.length === 0) return undefined;
    return attachments.map(({ data, media_type }) => ({ data, media_type }));
  }, [attachments]);

  return {
    attachments,
    fileInputRef,
    handleFileSelect,
    handleFileDrop,
    handleRemove,
    clear,
    restore,
    restoreAfterFailedSend,
    openFilePicker,
    getImagesForSend,
    handlePaste,
  };
}
