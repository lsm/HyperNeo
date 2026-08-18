import { describe, test, expect, beforeEach } from 'bun:test';
import { fileToBase64, formatFileSize, validateImageFile } from '../src/lib/file-utils.ts';

describe('file-utils', () => {
  describe('formatFileSize', () => {
    test('should format bytes correctly', () => {
      expect(formatFileSize(0)).toBe('0 B');
      expect(formatFileSize(1)).toBe('1 B');
      expect(formatFileSize(999)).toBe('999 B');
    });

    test('should format kilobytes correctly', () => {
      expect(formatFileSize(1024)).toBe('1 KB');
      expect(formatFileSize(1536)).toBe('1.5 KB');
      expect(formatFileSize(2048)).toBe('2 KB');
    });

    test('should format megabytes correctly', () => {
      expect(formatFileSize(1024 * 1024)).toBe('1 MB');
      expect(formatFileSize(1024 * 1024 * 2.5)).toBe('2.5 MB');
      expect(formatFileSize(1024 * 1024 * 5)).toBe('5 MB');
    });

    test('should format gigabytes correctly', () => {
      expect(formatFileSize(1024 * 1024 * 1024)).toBe('1 GB');
      expect(formatFileSize(1024 * 1024 * 1024 * 2)).toBe('2 GB');
    });

    test('should handle edge cases', () => {
      expect(formatFileSize(1023)).toBe('1023 B');
      expect(formatFileSize(1025)).toBe('1 KB');
    });
  });

  describe('validateImageFile', () => {
    const createMockFile = (type: string, size: number, name: string = 'test.png'): File => {
      return {
        type,
        size,
        name,
      } as File;
    };

    test('should accept valid image files', () => {
      const file = createMockFile('image/png', 1024 * 1024);
      expect(validateImageFile(file)).toBeNull();
    });

    test('should reject invalid image types', () => {
      const file = createMockFile('application/pdf', 1024 * 1024);
      const error = validateImageFile(file);
      expect(error).not.toBeNull();
      expect(error).toContain('Only images are supported');
    });

    test('should reject oversized files', () => {
      const file = createMockFile('image/png', 10 * 1024 * 1024);
      const error = validateImageFile(file);
      expect(error).not.toBeNull();
      expect(error).toContain('must be under');
      expect(error).toContain('5MB');
    });

    test('should validate all supported types', () => {
      expect(validateImageFile(createMockFile('image/png', 1024))).toBeNull();
      expect(validateImageFile(createMockFile('image/jpeg', 1024))).toBeNull();
      expect(validateImageFile(createMockFile('image/gif', 1024))).toBeNull();
      expect(validateImageFile(createMockFile('image/webp', 1024))).toBeNull();
    });
  });

  describe('fileToBase64', () => {
    class MockFileReader {
      result: string | null = null;
      onload: ((this: FileReader, ev: ProgressEvent<FileReader>) => void) | null = null;
      onerror: ((this: FileReader, ev: ProgressEvent<FileReader>) => void) | null = null;

      readAsDataURL(file: File): void {
        setTimeout(() => {
          const mockBase64 =
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
          this.result = `data:${file.type};base64,${mockBase64}`;
          if (this.onload) {
            this.onload({} as ProgressEvent<FileReader>);
          }
        }, 0);
      }
    }

    beforeEach(() => {
      // @ts-expect-error - Mocking global FileReader
      globalThis.FileReader = MockFileReader;
    });

    test('should convert file to base64', async () => {
      const file = new File(['test'], 'test.png', { type: 'image/png' });
      const base64 = await fileToBase64(file);

      expect(base64).toBeTruthy();
      expect(base64).not.toContain('data:');
      expect(base64).not.toContain('base64,');
      expect(base64.length).toBeGreaterThan(0);
    });

    test('should handle FileReader errors', async () => {
      class ErrorFileReader extends MockFileReader {
        readAsDataURL(_file: File): void {
          setTimeout(() => {
            if (this.onerror) {
              this.onerror({} as ProgressEvent<FileReader>);
            }
          }, 0);
        }
      }

      // @ts-expect-error - Mocking global FileReader
      globalThis.FileReader = ErrorFileReader;

      const file = new File(['test'], 'test.png', { type: 'image/png' });

      await expect(fileToBase64(file)).rejects.toThrow('Failed to read file');
    });
  });
});
