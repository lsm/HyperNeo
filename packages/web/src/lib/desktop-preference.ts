import type { MessageHub } from '@hyperneo/shared';
import { invokeOperation } from './operations.ts';

const address = { pack: 'core', scope: { kind: 'global', key: '' }, key: 'desktopControl' };

export async function readDesktopPreference(hub: MessageHub) {
  const result = await invokeOperation<{ preference?: { value: unknown } | null }>(
    hub,
    'pack.preferences.get',
    address
  );
  if (result.preference === undefined) throw new Error('desktop preference unavailable');
  return result.preference?.value === true;
}

export async function writeDesktopPreference(hub: MessageHub, value: boolean) {
  const result = await invokeOperation<{ ok: boolean; reason?: string }>(
    hub,
    'pack.preferences.set',
    { ...address, value }
  );
  if (!result.ok) throw new Error(result.reason);
}
