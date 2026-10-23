import type { DbGateway } from '../../storage/db-gateway/db-gateway.ts';
import {
  recordUnpaired,
  touchDevice,
  type DeviceKind,
} from '../../storage/repositories/device-pairing-repository.ts';

export const DEVICE_COOKIE = 'hyperneo_device';

const revocationListeners = new Set<(deviceId: string) => void>();
const revokedAt = new Map<string, number>();
let revocations = 0;

export function announceDeviceRevoked(deviceId: string): void {
  revokedAt.set(deviceId, ++revocations);
  for (const listener of revocationListeners) listener(deviceId);
}

export function onDeviceRevoked(listener: (deviceId: string) => void): () => void {
  revocationListeners.add(listener);
  return () => revocationListeners.delete(listener);
}

export interface UpgradeIdentity {
  deviceId: string;
  kind: DeviceKind;
}

export interface UpgradeAuthDeps {
  readonly db: () => DbGateway;
  readonly now: () => number;
}

export function readDeviceCredential(req: Request): string | null {
  const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '')?.[1];
  if (bearer) return bearer;
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === DEVICE_COOKIE && value.length) return value.join('=');
  }
  return null;
}

export function createUpgradeAuthenticator({ db, now }: UpgradeAuthDeps) {
  return async (req: Request, remoteAddress: string | null): Promise<UpgradeIdentity | null> => {
    try {
      const credential = readDeviceCredential(req);
      const host = req.headers.get('host');
      const at = now();
      const asked = revocations;
      const device = credential ? await db().run(touchDevice, { credential, host, now: at }) : null;
      if (device && (revokedAt.get(device.id) ?? 0) > asked) return null;
      if (device) return { deviceId: device.id, kind: device.kind };
      const origin = req.headers.get('origin');
      void db()
        .run(recordUnpaired, {
          seen: {
            client: origin ? 'browser' : 'native',
            origin,
            host,
            remoteAddress,
            credentialRejected: credential !== null,
          },
          now: at,
        })
        .catch(() => {});
      return null;
    } catch {
      return null;
    }
  };
}
