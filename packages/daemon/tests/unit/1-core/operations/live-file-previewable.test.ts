import { describe, expect, test } from 'vitest';
import { PREVIEWABLE_FILE_EXTENSIONS } from '@hyperneo/shared/types/artifact-file';
import { liveFileByteLimit } from '../../../../src/lib/artifacts/live-file-content.ts';

const others = [
  'sh',
  'py',
  'ts',
  'tsx',
  'js',
  'svg',
  'pdf',
  'docx',
  'zip',
  'swift',
  'yaml',
  'toml',
];

describe('liveFileByteLimit', () => {
  test('gives image limits only to the image formats', () => {
    for (const extension of ['png', 'jpg', 'jpeg', 'gif', 'webp'])
      expect(liveFileByteLimit(extension)).toBe(32 * 1024 * 1024);
    expect(liveFileByteLimit('md')).toBe(2 * 1024 * 1024);
  });
  test.each([...PREVIEWABLE_FILE_EXTENSIONS])('reads .%s, which clients link', (extension) => {
    expect(liveFileByteLimit(extension)).not.toBeNull();
  });
  test.each(others)('refuses .%s, which clients leave as text', (extension) => {
    expect(liveFileByteLimit(extension)).toBeNull();
  });
});
