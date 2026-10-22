import { test } from 'bun:test';
import { verifySpentAdmission } from '../../helpers/spent-admission-proof.ts';

test.each(['ordinary', 'neo'] as const)(
  '%s delivers queued inputs after restart without another send or restart',
  (kind) => verifySpentAdmission(kind, 'full'),
  90000
);
