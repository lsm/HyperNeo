// @ts-nocheck

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  fileToBase64,
  formatFileSize,
  validateImageFile,
  extractImagesFromClipboard,
} from '../file-utils';

function createMockFile(name: string, size: number, type: string): File {
  const file = new File([''], name, { type });

  Object.defineProperty(file, 'size', {
    value: size,
    writable: false,
    configurable: true,
  });

  return file;
}

describe('file-utils', () => {
  describe('formatFileSize', () => {
    it('should format 0 bytes', () => {
      expect(formatFileSize(0)).toBe('0 B');
    });

    it('should format bytes', () => {
      expect(formatFileSize(500)).toBe('500 B');
    });

    it('should format kilobytes', () => {
      expect(formatFileSize(1024)).toBe('1 KB');
      expect(formatFileSize(1536)).toBe('1.5 KB');
      expect(formatFileSize(2048)).toBe('2 KB');
    });

    it('should format megabytes', () => {
      expect(formatFileSize(1024 * 1024)).toBe('1 MB');
      expect(formatFileSize(1.5 * 1024 * 1024)).toBe('1.5 MB');
      expect(formatFileSize(3.75 * 1024 * 1024)).toBe('3.75 MB');
    });

    it('should format gigabytes', () => {
      expect(formatFileSize(1024 * 1024 * 1024)).toBe('1 GB');
      expect(formatFileSize(2.5 * 1024 * 1024 * 1024)).toBe('2.5 GB');
    });

    it('should round to 2 decimal places', () => {
      expect(formatFileSize(1234)).toBe('1.21 KB');
      expect(formatFileSize(1234567)).toBe('1.18 MB');
    });
  });

  describe('validateImageFile', () => {
    it('should return null for valid PNG file', () => {
      const file = createMockFile('test.png', 1024, 'image/png');
      expect(validateImageFile(file)).toBeNull();
    });

    it('should return null for valid JPEG file', () => {
      const file = createMockFile('test.jpg', 1024, 'image/jpeg');
      expect(validateImageFile(file)).toBeNull();
    });

    it('should return null for valid GIF file', () => {
      const file = createMockFile('test.gif', 1024, 'image/gif');
      expect(validateImageFile(file)).toBeNull();
    });

    it('should return null for valid WebP file', () => {
      const file = createMockFile('test.webp', 1024, 'image/webp');
      expect(validateImageFile(file)).toBeNull();
    });

    it('should return error for unsupported file type', () => {
      const file = createMockFile('test.pdf', 1024, 'application/pdf');
      const error = validateImageFile(file);
      expect(error).toBe('Only images are supported (PNG, JPEG, GIF, WebP)');
    });

    it('should return error for text file', () => {
      const file = createMockFile('test.txt', 1024, 'text/plain');
      const error = validateImageFile(file);
      expect(error).toBe('Only images are supported (PNG, JPEG, GIF, WebP)');
    });

    it('should return error for BMP (unsupported image type)', () => {
      const file = createMockFile('test.bmp', 1024, 'image/bmp');
      const error = validateImageFile(file);
      expect(error).toBe('Only images are supported (PNG, JPEG, GIF, WebP)');
    });

    it('should return error for empty file (0 bytes)', () => {
      const file = createMockFile('test.png', 0, 'image/png');
      const error = validateImageFile(file);
      expect(error).toContain('under');
    });

    it('should return error for file exceeding size limit', () => {
      const file = createMockFile('test.png', 4 * 1024 * 1024, 'image/png');
      const error = validateImageFile(file);
      expect(error).toContain('under');
      expect(error).toContain('MB');
    });

    it('should return null for file at exactly max size', () => {
      const file = createMockFile('test.png', 3.75 * 1024 * 1024, 'image/png');
      expect(validateImageFile(file)).toBeNull();
    });

    it('should return error for file just over max size', () => {
      const file = createMockFile('test.png', 3.76 * 1024 * 1024, 'image/png');
      const error = validateImageFile(file);
      expect(error).toContain('under');
    });

    it('should validate type before size', () => {
      const file = createMockFile('test.txt', 10 * 1024 * 1024, 'text/plain');
      const error = validateImageFile(file);
      expect(error).toBe('Only images are supported (PNG, JPEG, GIF, WebP)');
    });
  });

  describe('fileToBase64', () => {
    let originalFileReader: typeof FileReader;

    beforeEach(() => {
      originalFileReader = global.FileReader;
    });

    afterEach(() => {
      global.FileReader = originalFileReader;
    });

    it('should convert file to base64 string', async () => {
      const mockBase64Data = 'SGVsbG8gV29ybGQ=';
      const mockDataUrl = `data:image/png;base64,${mockBase64Data}`;

      class MockFileReader {
        result: string | null = null;
        onload: ((event: unknown) => void) | null = null;
        onerror: ((event: unknown) => void) | null = null;

        readAsDataURL(_file: Blob) {
          this.result = mockDataUrl;
          setTimeout(() => {
            if (this.onload) {
              this.onload({});
            }
          }, 0);
        }
      }

      global.FileReader = MockFileReader as unknown as typeof FileReader;

      const file = createMockFile('test.png', 1024, 'image/png');
      const result = await fileToBase64(file);

      expect(result).toBe(mockBase64Data);
    });

    it('should reject when FileReader fails', async () => {
      class MockFileReader {
        result: string | null = null;
        onload: ((event: unknown) => void) | null = null;
        onerror: ((event: unknown) => void) | null = null;

        readAsDataURL(_file: Blob) {
          setTimeout(() => {
            if (this.onerror) {
              this.onerror({});
            }
          }, 0);
        }
      }

      global.FileReader = MockFileReader as unknown as typeof FileReader;

      const file = createMockFile('test.png', 1024, 'image/png');

      await expect(fileToBase64(file)).rejects.toThrow('Failed to read file');
    });

    it('should reject when base64 size exceeds limit', async () => {
      const largeBase64Data = 'A'.repeat(6 * 1024 * 1024);
      const mockDataUrl = `data:image/png;base64,${largeBase64Data}`;

      class MockFileReader {
        result: string | null = null;
        onload: ((event: unknown) => void) | null = null;
        onerror: ((event: unknown) => void) | null = null;

        readAsDataURL(_file: Blob) {
          this.result = mockDataUrl;
          setTimeout(() => {
            if (this.onload) {
              this.onload({});
            }
          }, 0);
        }
      }

      global.FileReader = MockFileReader as unknown as typeof FileReader;

      const file = createMockFile('test.png', 4 * 1024 * 1024, 'image/png');

      await expect(fileToBase64(file)).rejects.toThrow('exceeds API limit');
    });

    it('should include file sizes in error message when base64 exceeds limit', async () => {
      const largeBase64Data = 'A'.repeat(6 * 1024 * 1024);
      const mockDataUrl = `data:image/png;base64,${largeBase64Data}`;

      class MockFileReader {
        result: string | null = null;
        onload: ((event: unknown) => void) | null = null;
        onerror: ((event: unknown) => void) | null = null;

        readAsDataURL(_file: Blob) {
          this.result = mockDataUrl;
          setTimeout(() => {
            if (this.onload) {
              this.onload({});
            }
          }, 0);
        }
      }

      global.FileReader = MockFileReader as unknown as typeof FileReader;

      const file = createMockFile('test.png', 4 * 1024 * 1024, 'image/png');

      try {
        await fileToBase64(file);
        expect.fail('Should have thrown');
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain('MB');
        expect(message).toContain('resize');
      }
    });
  });

  describe('extractImagesFromClipboard', () => {
    function createMockItemList(
      items: Array<{ kind: string; type: string; file?: File | null }>
    ): DataTransferItemList {
      const list = {
        length: items.length,
      } as DataTransferItemList;

      for (let i = 0; i < items.length; i++) {
        (list as unknown as Record<number, DataTransferItem>)[i] = {
          kind: items[i].kind,
          type: items[i].type,
          getAsFile: () => items[i].file ?? null,
        };
      }

      return list;
    }

    it('should return empty array when items list is empty', () => {
      const items = createMockItemList([]);
      const result = extractImagesFromClipboard(items);
      expect(result).toEqual([]);
    });

    it('should return empty array when only text items are present', () => {
      const items = createMockItemList([
        { kind: 'string', type: 'text/plain' },
        { kind: 'string', type: 'text/html' },
      ]);
      const result = extractImagesFromClipboard(items);
      expect(result).toEqual([]);
    });

    it('should return image files for supported MIME types', () => {
      const pngFile = new File(['test'], 'image.png', { type: 'image/png' });
      const jpegFile = new File(['test'], 'image.jpeg', { type: 'image/jpeg' });
      const gifFile = new File(['test'], 'image.gif', { type: 'image/gif' });
      const webpFile = new File(['test'], 'image.webp', { type: 'image/webp' });

      const items = createMockItemList([
        { kind: 'file', type: 'image/png', file: pngFile },
        { kind: 'file', type: 'image/jpeg', file: jpegFile },
        { kind: 'file', type: 'image/gif', file: gifFile },
        { kind: 'file', type: 'image/webp', file: webpFile },
      ]);

      const result = extractImagesFromClipboard(items);
      expect(result).toEqual([pngFile, jpegFile, gifFile, webpFile]);
    });

    it('should filter out unsupported file types', () => {
      const imageFile = new File(['test'], 'image.png', { type: 'image/png' });
      const pdfFile = new File(['test'], 'document.pdf', { type: 'application/pdf' });
      const textFile = new File(['test'], 'text.txt', { type: 'text/plain' });

      const items = createMockItemList([
        { kind: 'file', type: 'image/png', file: imageFile },
        { kind: 'file', type: 'application/pdf', file: pdfFile },
        { kind: 'file', type: 'text/plain', file: textFile },
      ]);

      const result = extractImagesFromClipboard(items);
      expect(result).toEqual([imageFile]);
    });

    it('should handle mixed items (string + file) - only returns files', () => {
      const imageFile = new File(['test'], 'image.png', { type: 'image/png' });

      const items = createMockItemList([
        { kind: 'string', type: 'text/plain' },
        { kind: 'file', type: 'image/png', file: imageFile },
        { kind: 'string', type: 'text/html' },
      ]);

      const result = extractImagesFromClipboard(items);
      expect(result).toEqual([imageFile]);
    });

    it('should handle getAsFile() returning null gracefully', () => {
      const imageFile = new File(['test'], 'image.png', { type: 'image/png' });

      const items = createMockItemList([
        { kind: 'file', type: 'image/png', file: imageFile },
        { kind: 'file', type: 'image/jpeg', file: null },
      ]);

      const result = extractImagesFromClipboard(items);
      expect(result).toEqual([imageFile]);
    });

    it('should return multiple image files when multiple are present', () => {
      const file1 = new File(['test1'], 'image1.png', { type: 'image/png' });
      const file2 = new File(['test2'], 'image2.jpeg', { type: 'image/jpeg' });
      const file3 = new File(['test3'], 'image3.gif', { type: 'image/gif' });

      const items = createMockItemList([
        { kind: 'file', type: 'image/png', file: file1 },
        { kind: 'file', type: 'image/jpeg', file: file2 },
        { kind: 'file', type: 'image/gif', file: file3 },
      ]);

      const result = extractImagesFromClipboard(items);
      expect(result).toEqual([file1, file2, file3]);
    });
  });
});
