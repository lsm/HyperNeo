import { describe, expect, it, vi } from 'vitest';
import type { MessageHub } from '@hyperneo/shared';
import type { DaemonSnapshot } from '@hyperneo/shared/types/daemon-snapshot';
import {
  admitDaemonInventoryRead,
  presentDaemonInventoryRead,
  readDaemonInventory,
} from '../daemon-inventory.ts';

const snapshot: DaemonSnapshot = Object.freeze({
  capturedAt: 123,
  capabilities: Object.freeze(['daemon.snapshot']),
  resources: Object.freeze([]),
});
function fixture(response: unknown = snapshot) {
  const request = vi.fn().mockResolvedValue(response);
  const hub = { request } as unknown as MessageHub;
  const getHub = vi.fn().mockResolvedValue(hub);
  return { request, hub, getHub };
}

describe('admitDaemonInventoryRead', () => {
  it.each([true, false])('reports the current generation %s', (current) => {
    expect(admitDaemonInventoryRead(current)).toEqual(
      current ? { value: true } : { reason: { state: 'stale' } }
    );
  });
});
describe('presentDaemonInventoryRead', () => {
  it('preserves the owner-validated snapshot without inventing resources', () => {
    expect(presentDaemonInventoryRead(snapshot)).toEqual({ value: { state: 'ready', snapshot } });
    expect(presentDaemonInventoryRead(snapshot)).toHaveProperty('value.snapshot', snapshot);
  });
  it('does not treat domain rejection as an empty successful inventory', () => {
    expect(
      presentDaemonInventoryRead({ accepted: false, reason: 'daemon_inventory_forbidden' })
    ).toEqual({ reason: { state: 'unavailable' } });
  });
});
describe('readDaemonInventory', () => {
  it('reads the existing operation with explicit bounded local policy', async () => {
    const { request, getHub } = fixture();
    expect(await readDaemonInventory(getHub, () => true)).toEqual({ state: 'ready', snapshot });
    expect(getHub).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledExactlyOnceWith('operation.invoke', {
      name: 'daemon.snapshot',
      input: { limit: 50, includeArchived: false },
    });
  });
  it('does not even acquire a hub for an already-obsolete read', async () => {
    const { request, getHub } = fixture();
    expect(await readDaemonInventory(getHub, () => false)).toEqual({ state: 'stale' });
    expect(getHub).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
  it('rechecks after hub acquisition before starting inventory I/O', async () => {
    const { request, hub } = fixture();
    let current = true;
    const getHub = vi.fn(async () => {
      current = false;
      return hub;
    });
    expect(await readDaemonInventory(getHub, () => current)).toEqual({ state: 'stale' });
    expect(getHub).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
  });
  it.each(['snapshot', 'rejection'])('gives staleness precedence over a late %s', async (kind) => {
    const { request, getHub } = fixture();
    let current = true;
    request.mockImplementation(async () => {
      current = false;
      return kind === 'snapshot'
        ? snapshot
        : { accepted: false, reason: 'daemon_inventory_forbidden' };
    });
    expect(await readDaemonInventory(getHub, () => current)).toEqual({ state: 'stale' });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('returns an unavailable outcome for a current domain rejection', async () => {
    const { getHub } = fixture({ accepted: false, reason: 'daemon_inventory_forbidden' });
    expect(await readDaemonInventory(getHub, () => true)).toEqual({ state: 'unavailable' });
  });
  it.each(['hub', 'request'])(
    'leaves %s infrastructure faults to the resource owner',
    async (site) => {
      const { request, getHub } = fixture();
      const fault = new Error('Disconnected');
      (site === 'hub' ? getHub : request).mockRejectedValue(fault);
      await expect(readDaemonInventory(getHub, () => true)).rejects.toBe(fault);
      expect(request).toHaveBeenCalledTimes(site === 'hub' ? 0 : 1);
    }
  );
});
