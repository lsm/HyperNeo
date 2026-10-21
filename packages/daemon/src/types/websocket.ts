import type { UpgradeIdentity } from '../lib/pairing/upgrade-auth.ts';

export interface WebSocketData {
  connectionSessionId: string;
  clientId?: string;
  device?: UpgradeIdentity | null;
}
