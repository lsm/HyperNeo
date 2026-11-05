import { describe, expect, it, vi } from 'vitest';
import type { MessageHub } from '@hyperneo/shared';
import {
  registerWebExtension,
  shellExtensions,
  type SpaceWebExtension,
  loadWebExtensions,
  webExtension,
  webExtensionDeclined,
} from '../web-extensions';

const shell = { activeChannel: () => 'space:one' } as SpaceWebExtension['shell'];
const space = { shell, store: {} } as SpaceWebExtension;

function hubAnswering(request: () => Promise<unknown>): MessageHub {
  return { request: vi.fn(request) } as unknown as MessageHub;
}

const connected = (hub: MessageHub) => async () => hub;

describe('loadWebExtensions', () => {
  it('loads Space when the daemon lists it', async () => {
    const load = vi.fn(async () => space);
    const hub = hubAnswering(async () => ({ extensions: [{ id: 'space', webRoutes: [] }] }));
    await loadWebExtensions(connected(hub), { space: load });
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
      connected(hubAnswering(async () => ({ extensions: [{ id: 'neo-packs', webRoutes: [] }] }))),
      { space: load }
    );
    expect(load).not.toHaveBeenCalled();
    expect(webExtension('space')).toBeUndefined();
    expect(webExtensionDeclined('space')).toBe(true);
  });

  it('keeps Space for a daemon that cannot list its extensions', async () => {
    await loadWebExtensions(
      connected(
        hubAnswering(async () => {
          throw Object.assign(new Error('Unknown operation'), { code: 'METHOD_NOT_FOUND' });
        })
      ),
      { space: async () => space }
    );
    expect(webExtension('space')).toBe(space);
    expect(webExtensionDeclined('space')).toBe(false);
  });

  it('keeps Space when the daemon answers without an extension list', async () => {
    const load = vi.fn(async () => space);
    await loadWebExtensions(connected(hubAnswering(async () => ({}))), { space: load }, 0);
    expect(load).toHaveBeenCalledTimes(1);
    expect(webExtension('space')).toBe(space);
  });

  it('retries until the daemon connects and the Space chunk loads', async () => {
    const hub = hubAnswering(async () => ({ extensions: [{ id: 'space', webRoutes: [] }] }));
    const getHub = vi
      .fn<() => Promise<MessageHub>>()
      .mockRejectedValueOnce(new Error('not connected'))
      .mockResolvedValue(hub);
    const load = vi
      .fn<() => Promise<SpaceWebExtension>>()
      .mockRejectedValueOnce(new Error('chunk failed'))
      .mockResolvedValue(space);
    await loadWebExtensions(getHub, { space: load }, 0);
    expect(getHub).toHaveBeenCalledTimes(3);
    expect(load).toHaveBeenCalledTimes(2);
    expect(webExtension('space')).toBe(space);
  });

  it('shellExtensions lists only the extensions that loaded', async () => {
    const hub = hubAnswering(async () => ({ extensions: [] }));
    await loadWebExtensions(connected(hub), { space: async () => space });
    expect(shellExtensions()).toEqual([]);

    registerWebExtension('space', space);
    expect(shellExtensions()).toEqual([shell]);
  });
});
