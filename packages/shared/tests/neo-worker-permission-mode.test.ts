import { describe, expect, test } from 'bun:test';
import { neoWorkerPermissionMode } from '../src/types/settings';

describe('neoWorkerPermissionMode', () => {
  test('defaults to auto and keeps only a known mode', () => {
    expect(neoWorkerPermissionMode()).toBe('auto');
    expect(neoWorkerPermissionMode({})).toBe('auto');
    expect(neoWorkerPermissionMode({ workerPermissionMode: 'acceptEdits' })).toBe('acceptEdits');
    expect(neoWorkerPermissionMode({ workerPermissionMode: 'yolo' as never })).toBe('auto');
  });
});
