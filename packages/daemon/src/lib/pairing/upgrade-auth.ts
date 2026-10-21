import type {
  DeviceKind,
  DevicePairingRepository,
} from '../../storage/repositories/device-pairing-repository.ts';

export const DEVICE_COOKIE = 'hyperneo_device';

const revocationListeners = new Set<(deviceId: string) => void>();

export function announceDeviceRevoked(deviceId: string): void {
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
  readonly devices: () => DevicePairingRepository;
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

export function createUpgradeAuthenticator({ devices, now }: UpgradeAuthDeps) {
  return (req: Request, remoteAddress: string | null): UpgradeIdentity | null => {
    try {
      const credential = readDeviceCredential(req);
      const host = req.headers.get('host');
      const at = now();
      const device = credential ? devices().touchDevice(credential, host, at) : null;
      if (device) return { deviceId: device.id, kind: device.kind };
      const origin = req.headers.get('origin');
      devices().recordUnpaired(
        {
          client: origin ? 'browser' : 'native',
          origin,
          host,
          remoteAddress,
          credentialRejected: credential !== null,
        },
        at
      );
      return null;
    } catch {
      return null;
    }
  };
}
