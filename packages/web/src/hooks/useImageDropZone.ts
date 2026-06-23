/**
 * useImageDropZone
 *
 * Drag-and-drop handlers + `isDragging` state for a file (image) drop target.
 * Extracted from MessageInput so the drop zone can be attached to a larger
 * container (e.g. the whole chat content column) instead of just the composer.
 *
 * Semantics match the original inline handlers:
 * - The overlay only activates for drags carrying files (`dataTransfer.types`
 *   includes `'Files'`) and only when `enabled` is true.
 * - `onDragLeave` only hides the overlay when the pointer leaves the zone
 *   entirely (`currentTarget === target`), so moving between child elements
 *   inside the zone does not flicker it off.
 * - `onDrop` forwards the dropped files to `onFiles` when enabled.
 */

import { useCallback, useState } from 'preact/hooks';

export type FileDropHandler = (files: FileList) => void | Promise<void>;

/**
 * A composer registers its file-drop handler upward (to the content column that
 * owns the drop zone) via this callback. Passing `null` clears the registration
 * (e.g. on unmount or while disabled).
 */
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
    // Only hide overlay when leaving the drop zone entirely.
    if (e.currentTarget === e.target) {
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
