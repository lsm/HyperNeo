import type { RefObject } from 'preact';
import { useState, useCallback, useRef } from 'preact/hooks';
import type { MessageImage } from '@hyperneo/shared';
import { toast } from '../lib/toast.ts';
import { fileToBase64, validateImageFile, extractImagesFromClipboard } from '../lib/file-utils.ts';

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
  openFilePicker: () => void;
  getImagesForSend: () => MessageImage[] | undefined;
  handlePaste: (e: ClipboardEvent) => void;
}

export function useFileAttachments(): UseFileAttachmentsResult {
  const [attachments, setAttachments] = useState<AttachmentWithMetadata[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const processFiles = useCallback(async (files: FileList | File[]) => {
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
        const errorMessage = error instanceof Error ? error.message : `Failed to read ${file.name}`;
        toast.error(errorMessage);
      }
    }
  }, []);

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

  const handleRemove = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const clear = useCallback(() => {
    setAttachments([]);
  }, []);

  const restore = useCallback((items: AttachmentWithMetadata[]) => {
    setAttachments(items);
  }, []);

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
    openFilePicker,
    getImagesForSend,
    handlePaste,
  };
}
