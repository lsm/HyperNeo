// @ts-nocheck

import { renderHook, act } from '@testing-library/preact';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useFileAttachments } from '../useFileAttachments.ts';
import { toast } from '../../lib/toast.ts';
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

function createMockFile(name: string, type: string, content: string = 'test content'): File {
  return new File([content], name, { type });
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

describe('useFileAttachments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateImageFile).mockReturnValue(null);
    vi.mocked(fileToBase64).mockResolvedValue('base64data');
    vi.mocked(extractImagesFromClipboard).mockImplementation((items: DataTransferItemList) => {
      const files: File[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) {
            files.push(file);
          }
        }
      }
      return files;
    });
  });

  describe('initialization', () => {
    it('should initialize with empty attachments', () => {
      const { result } = renderHook(() => useFileAttachments());

      expect(result.current.attachments).toEqual([]);
    });

    it('should provide fileInputRef', () => {
      const { result } = renderHook(() => useFileAttachments());

      expect(result.current.fileInputRef).toBeDefined();
      expect(result.current.fileInputRef.current).toBeNull();
    });

    it('should provide all required functions', () => {
      const { result } = renderHook(() => useFileAttachments());

      expect(typeof result.current.handleFileSelect).toBe('function');
      expect(typeof result.current.handleFileDrop).toBe('function');
      expect(typeof result.current.handleRemove).toBe('function');
      expect(typeof result.current.clear).toBe('function');
      expect(typeof result.current.restore).toBe('function');
      expect(typeof result.current.openFilePicker).toBe('function');
      expect(typeof result.current.getImagesForSend).toBe('function');
    });
  });

  describe('restore', () => {
    it('repopulates the attachment list (e.g. after a failed send clear)', () => {
      const { result } = renderHook(() => useFileAttachments());

      expect(result.current.attachments).toEqual([]);

      const snapshot = [
        {
          data: 'AAAA',
          media_type: 'image/png' as const,
          name: 'a.png',
          size: 4,
        },
        {
          data: 'BBBB',
          media_type: 'image/jpeg' as const,
          name: 'b.jpg',
          size: 4,
        },
      ];

      act(() => {
        result.current.restore(snapshot);
      });

      expect(result.current.attachments).toEqual(snapshot);
    });

    it('clear() then restore() round-trips back to the original attachments', () => {
      const { result } = renderHook(() => useFileAttachments());
      const snapshot = [
        {
          data: 'AAAA',
          media_type: 'image/png' as const,
          name: 'a.png',
          size: 4,
        },
      ];

      act(() => {
        result.current.restore(snapshot);
      });
      expect(result.current.attachments).toEqual(snapshot);

      const saved = result.current.attachments;

      act(() => {
        result.current.clear();
      });
      expect(result.current.attachments).toEqual([]);

      act(() => {
        result.current.restore(saved);
      });
      expect(result.current.attachments).toEqual(snapshot);
    });
  });

  describe('handleFileSelect edge cases', () => {
    it('should do nothing if no files selected', async () => {
      const { result } = renderHook(() => useFileAttachments());

      const input = {
        files: null,
        value: '',
      } as unknown as HTMLInputElement;

      const event = { target: input } as unknown as Event;

      await act(async () => {
        await result.current.handleFileSelect(event);
      });

      expect(result.current.attachments.length).toBe(0);
    });

    it('should do nothing if files is empty', async () => {
      const { result } = renderHook(() => useFileAttachments());

      const input = {
        files: createMockFileList([]),
        value: '',
      } as unknown as HTMLInputElement;

      const event = { target: input } as unknown as Event;

      await act(async () => {
        await result.current.handleFileSelect(event);
      });

      expect(result.current.attachments.length).toBe(0);
    });

    it('should reset input value after processing attempt', async () => {
      const { result } = renderHook(() => useFileAttachments());

      const file = createMockFile('test.png', 'image/png');
      const input = {
        files: createMockFileList([file]),
        value: 'test.png',
      } as unknown as HTMLInputElement;

      const event = { target: input } as unknown as Event;

      await act(async () => {
        try {
          await result.current.handleFileSelect(event);
        } catch {}
      });

      expect(input.value).toBe('');
    });
  });

  describe('clear', () => {
    it('should work when already empty', () => {
      const { result } = renderHook(() => useFileAttachments());

      act(() => {
        result.current.clear();
      });

      expect(result.current.attachments.length).toBe(0);
    });
  });

  describe('openFilePicker', () => {
    it('should call click on fileInputRef', () => {
      const { result } = renderHook(() => useFileAttachments());

      const clickMock = vi.fn(() => {});
      const mockInput = { click: clickMock } as unknown as HTMLInputElement;

      Object.defineProperty(result.current.fileInputRef, 'current', {
        value: mockInput,
        writable: true,
      });

      act(() => {
        result.current.openFilePicker();
      });

      expect(clickMock).toHaveBeenCalled();
    });

    it('should handle null fileInputRef', () => {
      const { result } = renderHook(() => useFileAttachments());

      act(() => {
        result.current.openFilePicker();
      });
    });
  });

  describe('getImagesForSend', () => {
    it('should return undefined when no attachments', () => {
      const { result } = renderHook(() => useFileAttachments());

      const images = result.current.getImagesForSend();

      expect(images).toBeUndefined();
    });
  });

  describe('function stability', () => {
    it('should return stable function references', () => {
      const { result, rerender } = renderHook(() => useFileAttachments());

      const firstHandleFileSelect = result.current.handleFileSelect;
      const firstHandleFileDrop = result.current.handleFileDrop;
      const firstHandleRemove = result.current.handleRemove;
      const firstClear = result.current.clear;
      const firstOpenFilePicker = result.current.openFilePicker;

      rerender();

      expect(result.current.handleFileSelect).toBe(firstHandleFileSelect);
      expect(result.current.handleFileDrop).toBe(firstHandleFileDrop);
      expect(result.current.handleRemove).toBe(firstHandleRemove);
      expect(result.current.clear).toBe(firstClear);
      expect(result.current.openFilePicker).toBe(firstOpenFilePicker);
    });
  });

  describe('handleRemove', () => {
    it('should be callable without throwing when no attachments', () => {
      const { result } = renderHook(() => useFileAttachments());

      act(() => {
        result.current.handleRemove(0);
      });

      expect(result.current.attachments.length).toBe(0);
    });

    it('should remove attachment at specified index', async () => {
      const { result } = renderHook(() => useFileAttachments());

      const file1 = createMockFile('test1.png', 'image/png');
      const file2 = createMockFile('test2.png', 'image/png');
      const input = {
        files: createMockFileList([file1, file2]),
        value: '',
      } as unknown as HTMLInputElement;
      const event = { target: input } as unknown as Event;

      await act(async () => {
        await result.current.handleFileSelect(event);
      });

      expect(result.current.attachments.length).toBe(2);

      act(() => {
        result.current.handleRemove(0);
      });

      expect(result.current.attachments.length).toBe(1);
      expect(result.current.attachments[0].name).toBe('test2.png');
    });
  });

  describe('file validation', () => {
    it('should show toast error when file validation fails', async () => {
      vi.mocked(validateImageFile).mockReturnValue('File too large');

      const { result } = renderHook(() => useFileAttachments());

      const file = createMockFile('large.png', 'image/png');
      const input = {
        files: createMockFileList([file]),
        value: '',
      } as unknown as HTMLInputElement;
      const event = { target: input } as unknown as Event;

      await act(async () => {
        await result.current.handleFileSelect(event);
      });

      expect(toast.error).toHaveBeenCalledWith('File too large');
      expect(result.current.attachments.length).toBe(0);
    });

    it('should skip invalid files but process valid ones', async () => {
      vi.mocked(validateImageFile)
        .mockReturnValueOnce('Invalid file type')
        .mockReturnValueOnce(null);

      const { result } = renderHook(() => useFileAttachments());

      const file1 = createMockFile('bad.txt', 'text/plain');
      const file2 = createMockFile('good.png', 'image/png');
      const input = {
        files: createMockFileList([file1, file2]),
        value: '',
      } as unknown as HTMLInputElement;
      const event = { target: input } as unknown as Event;

      await act(async () => {
        await result.current.handleFileSelect(event);
      });

      expect(toast.error).toHaveBeenCalledWith('Invalid file type');
      expect(result.current.attachments.length).toBe(1);
      expect(result.current.attachments[0].name).toBe('good.png');
    });
  });

  describe('file read errors', () => {
    it('should show toast error when file read fails', async () => {
      vi.mocked(fileToBase64).mockRejectedValue(new Error('Read error'));

      const { result } = renderHook(() => useFileAttachments());

      const file = createMockFile('test.png', 'image/png');
      const input = {
        files: createMockFileList([file]),
        value: '',
      } as unknown as HTMLInputElement;
      const event = { target: input } as unknown as Event;

      await act(async () => {
        await result.current.handleFileSelect(event);
      });

      expect(toast.error).toHaveBeenCalledWith('Read error');
      expect(result.current.attachments.length).toBe(0);
    });

    it('should show generic error when error has no message', async () => {
      vi.mocked(fileToBase64).mockRejectedValue('non-error');

      const { result } = renderHook(() => useFileAttachments());

      const file = createMockFile('test.png', 'image/png');
      const input = {
        files: createMockFileList([file]),
        value: '',
      } as unknown as HTMLInputElement;
      const event = { target: input } as unknown as Event;

      await act(async () => {
        await result.current.handleFileSelect(event);
      });

      expect(toast.error).toHaveBeenCalledWith('Failed to read test.png');
    });
  });

  describe('handleFileDrop', () => {
    it('should process dropped files', async () => {
      const { result } = renderHook(() => useFileAttachments());

      const file = createMockFile('dropped.png', 'image/png');
      const files = createMockFileList([file]);

      await act(async () => {
        await result.current.handleFileDrop(files);
      });

      expect(result.current.attachments.length).toBe(1);
      expect(result.current.attachments[0].name).toBe('dropped.png');
      expect(result.current.attachments[0].data).toBe('base64data');
    });

    it('should process multiple dropped files', async () => {
      const { result } = renderHook(() => useFileAttachments());

      const file1 = createMockFile('drop1.png', 'image/png');
      const file2 = createMockFile('drop2.jpg', 'image/jpeg');
      const files = createMockFileList([file1, file2]);

      await act(async () => {
        await result.current.handleFileDrop(files);
      });

      expect(result.current.attachments.length).toBe(2);
    });
  });

  describe('getImagesForSend with attachments', () => {
    it('should return stripped images when attachments exist', async () => {
      const { result } = renderHook(() => useFileAttachments());

      const file = createMockFile('test.png', 'image/png');
      const input = {
        files: createMockFileList([file]),
        value: '',
      } as unknown as HTMLInputElement;
      const event = { target: input } as unknown as Event;

      await act(async () => {
        await result.current.handleFileSelect(event);
      });

      const images = result.current.getImagesForSend();

      expect(images).toBeDefined();
      expect(images?.length).toBe(1);
      expect(images?.[0]).toEqual({
        data: 'base64data',
        media_type: 'image/png',
      });
      expect(images?.[0]).not.toHaveProperty('name');
      expect(images?.[0]).not.toHaveProperty('size');
    });
  });

  describe('successful file processing', () => {
    it('should add file with correct metadata', async () => {
      const { result } = renderHook(() => useFileAttachments());

      const file = createMockFile('photo.jpeg', 'image/jpeg');
      const input = {
        files: createMockFileList([file]),
        value: '',
      } as unknown as HTMLInputElement;
      const event = { target: input } as unknown as Event;

      await act(async () => {
        await result.current.handleFileSelect(event);
      });

      expect(result.current.attachments.length).toBe(1);
      expect(result.current.attachments[0]).toEqual({
        data: 'base64data',
        media_type: 'image/jpeg',
        name: 'photo.jpeg',
        size: file.size,
      });
    });
  });

  describe('clear with attachments', () => {
    it('should clear all attachments', async () => {
      const { result } = renderHook(() => useFileAttachments());

      const file = createMockFile('test.png', 'image/png');
      const input = {
        files: createMockFileList([file]),
        value: '',
      } as unknown as HTMLInputElement;
      const event = { target: input } as unknown as Event;

      await act(async () => {
        await result.current.handleFileSelect(event);
      });

      expect(result.current.attachments.length).toBe(1);

      act(() => {
        result.current.clear();
      });

      expect(result.current.attachments.length).toBe(0);
    });
  });

  describe('handlePaste', () => {
    function createMockPasteEvent(
      items: Array<{ kind: string; type: string; file?: File | null }>
    ): ClipboardEvent {
      const mockItems = { length: items.length } as DataTransferItemList;
      for (let i = 0; i < items.length; i++) {
        (mockItems as unknown as Record<number, DataTransferItem>)[i] = {
          kind: items[i].kind,
          type: items[i].type,
          getAsFile: () => items[i].file ?? null,
        };
      }
      return {
        clipboardData: { items: mockItems },
        preventDefault: vi.fn(),
      } as unknown as ClipboardEvent;
    }

    it('should return handlePaste as a function', () => {
      const { result } = renderHook(() => useFileAttachments());

      expect(typeof result.current.handlePaste).toBe('function');
    });

    it('should ignore paste events with no clipboardData', async () => {
      const { result } = renderHook(() => useFileAttachments());

      const event = {
        clipboardData: null,
      } as unknown as ClipboardEvent;

      await act(async () => {
        await result.current.handlePaste(event);
      });

      expect(result.current.attachments.length).toBe(0);
    });

    it('should ignore paste events with no image files (text-only clipboard)', async () => {
      const { result } = renderHook(() => useFileAttachments());

      const event = createMockPasteEvent([{ kind: 'string', type: 'text/plain' }]);

      await act(async () => {
        await result.current.handlePaste(event);
      });

      expect(result.current.attachments.length).toBe(0);
    });

    it('should process image files from paste event', async () => {
      const { result } = renderHook(() => useFileAttachments());

      const imageFile = createMockFile('pasted.png', 'image/png');
      const event = createMockPasteEvent([{ kind: 'file', type: 'image/png', file: imageFile }]);

      await act(async () => {
        await result.current.handlePaste(event);
      });

      expect(result.current.attachments.length).toBe(1);
      expect(result.current.attachments[0].name).toBe('pasted.png');
      expect(result.current.attachments[0].media_type).toBe('image/png');
      expect(result.current.attachments[0].data).toBe('base64data');
    });

    it('should NOT call preventDefault (text paste must still work)', async () => {
      const { result } = renderHook(() => useFileAttachments());

      const imageFile = createMockFile('pasted.png', 'image/png');
      const event = createMockPasteEvent([{ kind: 'file', type: 'image/png', file: imageFile }]);

      await act(async () => {
        await result.current.handlePaste(event);
      });

      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it('should process multiple pasted images', async () => {
      const { result } = renderHook(() => useFileAttachments());

      const file1 = createMockFile('paste1.png', 'image/png');
      const file2 = createMockFile('paste2.jpeg', 'image/jpeg');
      const event = createMockPasteEvent([
        { kind: 'file', type: 'image/png', file: file1 },
        { kind: 'file', type: 'image/jpeg', file: file2 },
      ]);

      await act(async () => {
        await result.current.handlePaste(event);
      });

      expect(result.current.attachments.length).toBe(2);
      expect(result.current.attachments[0].name).toBe('paste1.png');
      expect(result.current.attachments[1].name).toBe('paste2.jpeg');
    });
  });
});
