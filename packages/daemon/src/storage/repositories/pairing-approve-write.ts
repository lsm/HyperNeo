import { defineDbOp } from '../db-gateway/db-op.ts';
import { DevicePairingRepository } from './device-pairing-repository.ts';

type PairingApproval = 'approved' | 'not_pending' | 'not_paired';

export const pairingApproveWrite = defineDbOp<
  { codeId: string; deviceId: string; now: number },
  PairingApproval
>({
  name: 'pairing.approveCode.write',
  mode: 'write',
  run: (db, { codeId, deviceId, now }) => {
    const repo = new DevicePairingRepository(db);
    if (!repo.isActiveDevice(deviceId)) return 'not_paired';
    return repo.approve(codeId, now) ? 'approved' : 'not_pending';
  },
});
