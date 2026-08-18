import { renderHook, act } from '@testing-library/preact';
import { describe, it, expect, vi } from 'vitest';
import { useImageDropZone } from '../useImageDropZone.ts';

interface MockDataTransfer {
  types: string[];
  files: FileList;
  dropEffect: string;
}

function makeFileList(files: File[]): FileList {
  return {
    length: files.length,
    item: (index: number) => files[index] ?? null,
    [Symbol.iterator]: function* () {
      for (const file of files) yield file;
    },
  } as FileList;
}

function makeDragEvent(
  opts: { types?: string[]; files?: File[]; relatedTarget?: Node | null } = {}
): DragEvent {
  const currentTarget = document.createElement('div');
  const target = document.createElement('div');
  currentTarget.append(target);
  const files = opts.files ?? [];
  const dataTransfer: MockDataTransfer = {
    types: opts.types ?? [],
    files: makeFileList(files),
    dropEffect: 'none',
  };
  return {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    currentTarget,
    target,
    relatedTarget: opts.relatedTarget ?? null,
    dataTransfer: dataTransfer as unknown as DataTransfer,
  } as unknown as DragEvent;
}

describe('useImageDropZone', () => {
  it('activates isDragging on a file dragenter when enabled', () => {
    const onFiles = vi.fn();
    const { result } = renderHook(() => useImageDropZone(onFiles, true));
    expect(result.current.isDragging).toBe(false);
    act(() => {
      result.current.dragHandlers.onDragEnter(makeDragEvent({ types: ['Files'] }));
    });
    expect(result.current.isDragging).toBe(true);
  });

  it('does not activate for non-file drags', () => {
    const onFiles = vi.fn();
    const { result } = renderHook(() => useImageDropZone(onFiles, true));
    act(() => {
      result.current.dragHandlers.onDragEnter(makeDragEvent({ types: ['text/plain'] }));
    });
    expect(result.current.isDragging).toBe(false);
  });

  it('does not activate when disabled', () => {
    const onFiles = vi.fn();
    const { result } = renderHook(() => useImageDropZone(onFiles, false));
    act(() => {
      result.current.dragHandlers.onDragEnter(makeDragEvent({ types: ['Files'] }));
    });
    expect(result.current.isDragging).toBe(false);
  });

  it('sets dropEffect=copy on dragover when enabled', () => {
    const onFiles = vi.fn();
    const { result } = renderHook(() => useImageDropZone(onFiles, true));
    const evt = makeDragEvent({ types: ['Files'] });
    act(() => {
      result.current.dragHandlers.onDragOver(evt);
    });
    expect((evt.dataTransfer as unknown as MockDataTransfer).dropEffect).toBe('copy');
  });

  it('hides overlay on dragleave only when leaving the zone entirely', () => {
    const onFiles = vi.fn();
    const { result } = renderHook(() => useImageDropZone(onFiles, true));
    act(() => {
      result.current.dragHandlers.onDragEnter(makeDragEvent({ types: ['Files'] }));
    });
    expect(result.current.isDragging).toBe(true);

    const child = document.createElement('div');
    const evtInside = makeDragEvent({ relatedTarget: child });
    (evtInside.currentTarget as HTMLElement).append(child);

    act(() => {
      result.current.dragHandlers.onDragLeave(evtInside);
    });
    expect(result.current.isDragging).toBe(true);

    act(() => {
      result.current.dragHandlers.onDragLeave(makeDragEvent({ relatedTarget: document.body }));
    });
    expect(result.current.isDragging).toBe(false);
  });

  it('forwards dropped files to onFiles when enabled', () => {
    const onFiles = vi.fn();
    const { result } = renderHook(() => useImageDropZone(onFiles, true));
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    act(() => {
      result.current.dragHandlers.onDrop(makeDragEvent({ types: ['Files'], files: [file] }));
    });
    expect(onFiles).toHaveBeenCalledTimes(1);
    const dropped = onFiles.mock.calls[0][0] as FileList;
    expect(dropped.length).toBe(1);
    expect(dropped.item(0)).toBe(file);
  });

  it('does not forward files when disabled', () => {
    const onFiles = vi.fn();
    const { result } = renderHook(() => useImageDropZone(onFiles, false));
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    act(() => {
      result.current.dragHandlers.onDrop(makeDragEvent({ types: ['Files'], files: [file] }));
    });
    expect(onFiles).not.toHaveBeenCalled();
    expect(result.current.isDragging).toBe(false);
  });

  it('does not call onFiles when the drop carries no files', () => {
    const onFiles = vi.fn();
    const { result } = renderHook(() => useImageDropZone(onFiles, true));
    act(() => {
      result.current.dragHandlers.onDragEnter(makeDragEvent({ types: ['Files'] }));
    });
    expect(result.current.isDragging).toBe(true);
    act(() => {
      result.current.dragHandlers.onDrop(makeDragEvent({ types: ['Files'], files: [] }));
    });
    expect(onFiles).not.toHaveBeenCalled();
    expect(result.current.isDragging).toBe(false);
  });
});
