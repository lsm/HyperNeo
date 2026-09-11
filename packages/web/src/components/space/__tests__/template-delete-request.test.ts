import type { SpaceLongHorizonAgentTemplate } from '@hyperneo/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockDeleteTemplate, mockSuccess, mockError } = vi.hoisted(() => ({
  mockDeleteTemplate: vi.fn(),
  mockSuccess: vi.fn(),
  mockError: vi.fn(),
}));

vi.mock('../../../lib/space-store', () => ({
  spaceStore: { deleteTemplate: mockDeleteTemplate, spaceId: { value: 'space-1' } },
}));

vi.mock('../../../lib/toast', () => ({
  toast: { success: mockSuccess, error: mockError },
}));

import { spaceStore } from '../../../lib/space-store';
import {
  abandonIdleTemplateDelete,
  closeTemplateDelete,
  decideTemplateDelete,
  openTemplateDelete,
  runTemplateDelete,
  templateDeleteRequest,
} from '../template-delete-request';

function makeTemplate(key: string): SpaceLongHorizonAgentTemplate {
  return { key, displayName: key, version: 2 } as unknown as SpaceLongHorizonAgentTemplate;
}

describe('template delete request', () => {
  beforeEach(() => {
    templateDeleteRequest.value = null;
    mockDeleteTemplate.mockReset().mockResolvedValue(undefined);
    mockSuccess.mockReset();
    mockError.mockReset();
    (spaceStore as unknown as { spaceId: { value: string | null } }).spaceId.value = 'space-1';
  });

  it('deletes at the pinned version and clears the request', async () => {
    openTemplateDelete('space-1', makeTemplate('researcher.v1'));

    await runTemplateDelete();

    expect(mockDeleteTemplate).toHaveBeenCalledWith('researcher.v1', 2);
    expect(templateDeleteRequest.value).toBeNull();
  });

  it('keeps the request with its error when the delete fails', async () => {
    mockDeleteTemplate.mockRejectedValue(new Error('still referenced'));
    openTemplateDelete('space-1', makeTemplate('researcher.v1'));

    await runTemplateDelete();

    expect(templateDeleteRequest.value?.error).toBe('still referenced');
    expect(templateDeleteRequest.value?.busy).toBe(false);
  });

  it('refuses to close while the delete is in flight', async () => {
    let release = (): void => {};
    mockDeleteTemplate.mockReturnValue(
      new Promise<void>((resolve) => {
        release = () => resolve();
      })
    );
    openTemplateDelete('space-1', makeTemplate('researcher.v1'));
    const running = runTemplateDelete();

    closeTemplateDelete();

    expect(templateDeleteRequest.value?.busy).toBe(true);
    release();
    await running;
    expect(templateDeleteRequest.value).toBeNull();
  });

  it('refuses to start a second delete while one is in flight', async () => {
    let release = (): void => {};
    mockDeleteTemplate.mockReturnValue(
      new Promise<void>((resolve) => {
        release = () => resolve();
      })
    );
    openTemplateDelete('space-1', makeTemplate('first.v1'));
    const running = runTemplateDelete();

    openTemplateDelete('space-1', makeTemplate('second.v1'));
    await runTemplateDelete();

    expect(mockDeleteTemplate).toHaveBeenCalledTimes(1);
    expect(templateDeleteRequest.value?.template.key).toBe('first.v1');
    release();
    await running;
  });

  describe('decideTemplateDelete', () => {
    const request = { spaceId: 'space-1', template: makeTemplate('a'), busy: false, error: null };

    it('runs when a request is idle and its Space is active', () => {
      expect(decideTemplateDelete(request, 'space-1')).toEqual({ kind: 'run', request });
    });

    it('skips when there is no request', () => {
      expect(decideTemplateDelete(null, 'space-1')).toEqual({
        kind: 'skip',
        reason: 'no-request',
      });
    });

    it('skips when one is already running', () => {
      expect(decideTemplateDelete({ ...request, busy: true }, 'space-1')).toEqual({
        kind: 'skip',
        reason: 'already-running',
      });
    });

    it('skips when the active Space is no longer the pinned one', () => {
      expect(decideTemplateDelete(request, 'space-2')).toEqual({
        kind: 'skip',
        reason: 'space-changed',
      });
    });
  });

  it('does not delete against a Space the user has navigated away from', async () => {
    openTemplateDelete('space-1', makeTemplate('researcher.v1'));
    (spaceStore as unknown as { spaceId: { value: string | null } }).spaceId.value = 'space-2';

    await runTemplateDelete();

    expect(mockDeleteTemplate).not.toHaveBeenCalled();
  });

  it('reports a failure through the toast so an unmounted dialog cannot hide it', async () => {
    mockDeleteTemplate.mockRejectedValue(new Error('still referenced'));
    openTemplateDelete('space-1', makeTemplate('researcher.v1'));

    await runTemplateDelete();

    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('still referenced'));
  });

  it('abandons an idle request for the Space being left', () => {
    openTemplateDelete('space-1', makeTemplate('researcher.v1'));

    abandonIdleTemplateDelete('space-1');

    expect(templateDeleteRequest.value).toBeNull();
  });

  it('keeps an in-flight request when its Space is left', async () => {
    let release = (): void => {};
    mockDeleteTemplate.mockReturnValue(
      new Promise<void>((resolve) => {
        release = () => resolve();
      })
    );
    openTemplateDelete('space-1', makeTemplate('researcher.v1'));
    const running = runTemplateDelete();

    abandonIdleTemplateDelete('space-1');

    expect(templateDeleteRequest.value?.busy).toBe(true);
    release();
    await running;
  });

  it('leaves an idle request from a different Space alone', () => {
    openTemplateDelete('space-2', makeTemplate('researcher.v1'));

    abandonIdleTemplateDelete('space-1');

    expect(templateDeleteRequest.value?.spaceId).toBe('space-2');
  });

  it('records the Space the request belongs to', () => {
    openTemplateDelete('space-2', makeTemplate('researcher.v1'));

    expect(templateDeleteRequest.value?.spaceId).toBe('space-2');
  });

  it('survives as module state so an unmounted dialog cannot lose it', async () => {
    let release = (): void => {};
    mockDeleteTemplate.mockReturnValue(
      new Promise<void>((resolve) => {
        release = () => resolve();
      })
    );
    openTemplateDelete('space-1', makeTemplate('researcher.v1'));
    const running = runTemplateDelete();

    expect(templateDeleteRequest.value).toMatchObject({ busy: true, error: null });

    release();
    await running;
  });
});
