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
  test.each([...PREVIEWABLE_FILE_EXTENSIONS])('reads .%s, which clients link', (extension) => {
    expect(liveFileByteLimit(extension)).not.toBeNull();
  });
  test.each(others)('refuses .%s, which clients leave as text', (extension) => {
    expect(liveFileByteLimit(extension)).toBeNull();
  });
});
