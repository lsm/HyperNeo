import { useCallback, useState } from 'preact/hooks';

export type FileDropHandler = (files: FileList) => void | Promise<void>;

export type RegisterFileDropTarget = (handler: FileDropHandler | null) => void;

export interface DragHandlers {
  onDragEnter: (e: DragEvent) => void;
  onDragOver: (e: DragEvent) => void;
  onDragLeave: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
}

export function useImageDropZone(
  onFiles: FileDropHandler,
  enabled: boolean
): {
  isDragging: boolean;
  dragHandlers: DragHandlers;
} {
  const [isDragging, setIsDragging] = useState(false);

  const handleDragEnter = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!enabled || !e.dataTransfer?.types.includes('Files')) return;
      setIsDragging(true);
    },
    [enabled]
  );

  const handleDragOver = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!enabled) return;
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'copy';
      }
    },
    [enabled]
  );

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const dropZone = e.currentTarget;
    const nextTarget = e.relatedTarget;
    if (!(dropZone instanceof Node) || !(nextTarget instanceof Node)) {
      setIsDragging(false);
      return;
    }
    if (!dropZone.contains(nextTarget)) {
      setIsDragging(false);
    }
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      if (!enabled) return;
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        void onFiles(files);
      }
    },
    [enabled, onFiles]
  );

  return {
    isDragging,
    dragHandlers: {
      onDragEnter: handleDragEnter,
      onDragOver: handleDragOver,
      onDragLeave: handleDragLeave,
      onDrop: handleDrop,
    },
  };
}
