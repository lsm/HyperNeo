import { describe, expect, test } from 'bun:test';
import { neoWorkerPermissionMode } from '../src/types/settings';

describe('neoWorkerPermissionMode', () => {
  test('defaults to bypassPermissions and keeps only a known mode', () => {
    expect(neoWorkerPermissionMode()).toBe('bypassPermissions');
    expect(neoWorkerPermissionMode({})).toBe('bypassPermissions');
    expect(neoWorkerPermissionMode({ workerPermissionMode: 'acceptEdits' })).toBe('acceptEdits');
    expect(neoWorkerPermissionMode({ workerPermissionMode: 'yolo' as never })).toBe(
      'bypassPermissions'
    );
  });
});
