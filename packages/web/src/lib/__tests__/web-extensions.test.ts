import { describe, expect, it, vi } from 'vitest';
import type { MessageHub } from '@hyperneo/shared';
import {
  type SpaceWebExtension,
  loadWebExtensions,
  webExtension,
  webExtensionDeclined,
} from '../web-extensions';

const space = { store: {} } as SpaceWebExtension;

function hubAnswering(request: () => Promise<unknown>): MessageHub {
  return { request: vi.fn(request) } as unknown as MessageHub;
}

describe('loadWebExtensions', () => {
  it('loads Space when the daemon lists it', async () => {
    const load = vi.fn(async () => space);
    const hub = hubAnswering(async () => ({ extensions: [{ id: 'space', webRoutes: [] }] }));
    await loadWebExtensions(hub, { space: load });
    expect(hub.request).toHaveBeenCalledWith('operation.invoke', {
      name: 'daemon.extensions',
      input: undefined,
    });
    expect(webExtension('space')).toBe(space);
    expect(webExtensionDeclined('space')).toBe(false);
  });

  it('declines Space without loading it when the daemon does not list it', async () => {
    const load = vi.fn(async () => space);
    await loadWebExtensions(
      hubAnswering(async () => ({ extensions: [{ id: 'neo-packs', webRoutes: [] }] })),
      { space: load }
    );
    expect(load).not.toHaveBeenCalled();
    expect(webExtension('space')).toBeUndefined();
    expect(webExtensionDeclined('space')).toBe(true);
  });

  it('keeps Space for a daemon that cannot list its extensions', async () => {
    await loadWebExtensions(
      hubAnswering(async () => {
        throw Object.assign(new Error('Unknown operation'), { code: 'METHOD_NOT_FOUND' });
      }),
      { space: async () => space }
    );
    expect(webExtension('space')).toBe(space);
    expect(webExtensionDeclined('space')).toBe(false);
  });
});
