import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readClaudeDesktopRecordFiles } from '../../../../src/storage/claude-desktop-read';

describe('readClaudeDesktopRecordFiles', () => {
  test('reads session files, skips bad ones, and follows edits and deletes', () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-read-'));
    try {
      const scope = join(root, 'account', 'scope');
      mkdirSync(scope, { recursive: true });
      const file = join(scope, 'local_a.json');
      writeFileSync(file, JSON.stringify({ sessionId: 'local_a', title: 'First' }));
      writeFileSync(join(scope, 'local_bad.json'), 'not json');
      writeFileSync(join(scope, 'other.json'), JSON.stringify({ sessionId: 'local_b' }));

      expect(readClaudeDesktopRecordFiles(root)).toMatchObject([
        { sessionId: 'local_a', title: 'First', desktopRegistered: true },
      ]);

      writeFileSync(file, JSON.stringify({ sessionId: 'local_a', title: 'Second longer' }));
      expect(readClaudeDesktopRecordFiles(root)[0].title).toBe('Second longer');

      rmSync(file);
      expect(readClaudeDesktopRecordFiles(root)).toEqual([]);
      expect(readClaudeDesktopRecordFiles(join(root, 'missing'))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
