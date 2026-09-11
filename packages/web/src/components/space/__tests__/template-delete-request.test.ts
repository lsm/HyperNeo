import type { SpaceLongHorizonAgentTemplate } from '@hyperneo/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockDeleteTemplate, mockSuccess } = vi.hoisted(() => ({
  mockDeleteTemplate: vi.fn(),
  mockSuccess: vi.fn(),
}));

vi.mock('../../../lib/space-store', () => ({
  spaceStore: { deleteTemplate: mockDeleteTemplate },
}));

vi.mock('../../../lib/toast', () => ({
  toast: { success: mockSuccess, error: vi.fn() },
}));

import {
  closeTemplateDelete,
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
