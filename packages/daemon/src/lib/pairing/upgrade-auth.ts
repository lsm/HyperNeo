import type { DbGateway } from '../../storage/db-gateway/db-gateway.ts';
import { Logger } from '../logger.ts';
import {
  recordUnpaired,
  touchDevice,
  type DeviceKind,
} from '../../storage/repositories/device-pairing-repository.ts';

export const DEVICE_COOKIE = 'hyperneo_device';

const revocationListeners = new Set<(deviceId: string) => void>();
const RECORD_FAILURE_LOG_INTERVAL_MS = 60_000;
const log = new Logger('upgrade-auth');
const revokedDuringLookups = new Set<string>();
let lookups = 0;

export function announceDeviceRevoked(deviceId: string): void {
  if (lookups > 0) revokedDuringLookups.add(deviceId);
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

async function lookUpDevice(db: DbGateway, credential: string, host: string | null, at: number) {
  lookups += 1;
  try {
    const device = await db.run(touchDevice, { credential, host, now: at });
    return device && !revokedDuringLookups.has(device.id) ? device : null;
  } finally {
    lookups -= 1;
    if (lookups === 0) revokedDuringLookups.clear();
  }
}

export function createUpgradeAuthenticator({ db, now }: UpgradeAuthDeps) {
  let loggedFailureAt = -Infinity;
  const noteFailure = (error: unknown) => {
    const at = now();
    if (at - loggedFailureAt < RECORD_FAILURE_LOG_INTERVAL_MS) return;
    loggedFailureAt = at;
    log.warn('could not record an unpaired connection:', error);
  };
  return async (req: Request, remoteAddress: string | null): Promise<UpgradeIdentity | null> => {
    try {
      const credential = readDeviceCredential(req);
      const host = req.headers.get('host');
      const at = now();
      const device = credential ? await lookUpDevice(db(), credential, host, at) : null;
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
        .catch(noteFailure);
      return null;
    } catch {
      return null;
    }
  };
}
