// @ts-nocheck

import { renderHook, act } from '@testing-library/preact';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useFileAttachments } from '../useFileAttachments.ts';
import {
  composerAttachmentsSignal,
  readPendingComposerAttachments,
  writePendingComposerAttachments,
} from '../../lib/composer-attachment-store.ts';
import {
  fileToBase64,
  validateImageFile,
  extractImagesFromClipboard,
} from '../../lib/file-utils.ts';

vi.mock('../../lib/toast.ts', () => ({
  toast: {
    error: vi.fn(),
  },
}));

vi.mock('../../lib/file-utils.ts', () => ({
  validateImageFile: vi.fn(),
  fileToBase64: vi.fn(),
  extractImagesFromClipboard: vi.fn(),
}));

function createMockFile(name: string, type: string): File {
  return new File(['test content'], name, { type });
}

function createMockFileList(files: File[]): FileList {
  const fileList = {
    length: files.length,
    item: (index: number) => files[index] || null,
    [Symbol.iterator]: function* () {
      for (const file of files) {
        yield file;
      }
    },
  } as FileList;

  files.forEach((file, index) => {
    Object.defineProperty(fileList, index, { value: file, enumerable: true });
  });

  return fileList;
}

function createPasteEvent(files: File[]): ClipboardEvent {
  const mockItems = { length: files.length } as DataTransferItemList;
  for (let i = 0; i < files.length; i++) {
    (mockItems as unknown as Record<number, DataTransferItem>)[i] = {
      kind: 'file',
      type: files[i].type,
      getAsFile: () => files[i],
    };
  }
  return {
    clipboardData: { items: mockItems },
  } as unknown as ClipboardEvent;
}

async function pasteImages(
  hookResult: { current: ReturnType<typeof useFileAttachments> },
  files: File[]
) {
  vi.mocked(extractImagesFromClipboard).mockReturnValueOnce(files);
  await act(async () => {
    await hookResult.current.handlePaste(createPasteEvent(files));
  });
}

describe('useFileAttachments session persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    composerAttachmentsSignal.value = {};
    vi.mocked(validateImageFile).mockReturnValue(null);
    vi.mocked(fileToBase64).mockImplementation(async (file: File) => `b64:${file.name}`);
    vi.mocked(extractImagesFromClipboard).mockReturnValue([]);
  });

  it('restores pasted attachments when the hook remounts for the same session', async () => {
    const first = renderHook(() => useFileAttachments('session-a'));
    await pasteImages(first.result, [createMockFile('pasted.png', 'image/png')]);
    expect(first.result.current.attachments).toHaveLength(1);

    first.unmount();

    const second = renderHook(() => useFileAttachments('session-a'));
    expect(second.result.current.attachments).toHaveLength(1);
    expect(second.result.current.attachments[0]).toEqual({
      data: 'b64:pasted.png',
      media_type: 'image/png',
      name: 'pasted.png',
      size: expect.any(Number),
    });
    expect(second.result.current.getImagesForSend()).toEqual([
      { data: 'b64:pasted.png', media_type: 'image/png' },
    ]);
  });

  it('keeps explicit removals across remounts', async () => {
    const first = renderHook(() => useFileAttachments('session-a'));
    await pasteImages(first.result, [
      createMockFile('one.png', 'image/png'),
      createMockFile('two.png', 'image/png'),
    ]);
    expect(first.result.current.attachments).toHaveLength(2);

    act(() => {
      first.result.current.handleRemove(0);
    });
    first.unmount();

    const second = renderHook(() => useFileAttachments('session-a'));
    expect(second.result.current.attachments).toHaveLength(1);
    expect(second.result.current.attachments[0].name).toBe('two.png');
  });

  it('drops persisted attachments after clear() so a remount starts empty', async () => {
    const first = renderHook(() => useFileAttachments('session-a'));
    await pasteImages(first.result, [createMockFile('pasted.png', 'image/png')]);

    act(() => {
      first.result.current.clear();
    });
    first.unmount();

    const second = renderHook(() => useFileAttachments('session-a'));
    expect(second.result.current.attachments).toEqual([]);
    expect(second.result.current.getImagesForSend()).toBeUndefined();
  });

  it('isolates pending attachments per session', async () => {
    const first = renderHook(() => useFileAttachments('session-a'));
    await pasteImages(first.result, [createMockFile('pasted.png', 'image/png')]);
    first.unmount();

    const other = renderHook(() => useFileAttachments('session-b'));
    expect(other.result.current.attachments).toEqual([]);

    const restored = renderHook(() => useFileAttachments('session-a'));
    expect(restored.result.current.attachments).toHaveLength(1);
  });

  it('persists restore() snapshots (failed-send recovery) across remounts', () => {
    const first = renderHook(() => useFileAttachments('session-a'));
    const snapshot = [
      {
        data: 'AAAA',
        media_type: 'image/png' as const,
        name: 'a.png',
        size: 4,
      },
    ];

    act(() => {
      first.result.current.restore(snapshot);
    });
    first.unmount();

    const second = renderHook(() => useFileAttachments('session-a'));
    expect(second.result.current.attachments).toEqual(snapshot);
  });

  it('does not persist when no sessionId is provided', async () => {
    const first = renderHook(() => useFileAttachments());
    await pasteImages(first.result, [createMockFile('pasted.png', 'image/png')]);
    expect(first.result.current.attachments).toHaveLength(1);
    first.unmount();

    const second = renderHook(() => useFileAttachments());
    expect(second.result.current.attachments).toEqual([]);
    expect(composerAttachmentsSignal.value).toEqual({});
  });

  it('swaps to the stored list when sessionId changes mid-mount', async () => {
    const { result, rerender } = renderHook(({ sessionId }) => useFileAttachments(sessionId), {
      initialProps: { sessionId: 'session-a' },
    });

    await pasteImages(result, [createMockFile('pasted.png', 'image/png')]);
    expect(result.current.attachments).toHaveLength(1);

    rerender({ sessionId: 'session-b' });
    expect(result.current.attachments).toEqual([]);

    rerender({ sessionId: 'session-a' });
    expect(result.current.attachments).toHaveLength(1);
    expect(result.current.attachments[0].name).toBe('pasted.png');
  });

  it('keeps two mounted composers for the same session in sync', async () => {
    const a = renderHook(() => useFileAttachments('session-a'));
    const b = renderHook(() => useFileAttachments('session-a'));

    await act(async () => {
      await pasteImages(a.result, [createMockFile('pasted.png', 'image/png')]);
    });

    expect(a.result.current.attachments).toHaveLength(1);
    expect(b.result.current.attachments).toHaveLength(1);
  });

  it('processes dropped files through the session store as well', async () => {
    const first = renderHook(() => useFileAttachments('session-a'));
    const file = createMockFile('dropped.png', 'image/png');

    await act(async () => {
      await first.result.current.handleFileDrop(createMockFileList([file]));
    });
    first.unmount();

    const second = renderHook(() => useFileAttachments('session-a'));
    expect(second.result.current.attachments).toHaveLength(1);
    expect(second.result.current.attachments[0].name).toBe('dropped.png');
  });
});

describe('composer-attachment-store', () => {
  beforeEach(() => {
    composerAttachmentsSignal.value = {};
  });

  it('returns an empty list for unknown sessions', () => {
    expect(readPendingComposerAttachments('missing')).toEqual([]);
  });

  it('drops the session entry when cleared instead of storing an empty list', () => {
    writePendingComposerAttachments('session-a', [
      { data: 'AAAA', media_type: 'image/png', name: 'a.png', size: 4 },
    ]);
    expect('session-a' in composerAttachmentsSignal.value).toBe(true);

    writePendingComposerAttachments('session-a', []);
    expect(composerAttachmentsSignal.value).toEqual({});
    expect(readPendingComposerAttachments('session-a')).toEqual([]);
  });

  it('clearing an untouched session is a no-op', () => {
    writePendingComposerAttachments('session-a', []);
    expect(composerAttachmentsSignal.value).toEqual({});
  });
});
