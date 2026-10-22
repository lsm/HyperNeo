import { test } from 'bun:test';
import { verifySpentAdmission } from '../../helpers/spent-admission-proof.ts';

test.each(['ordinary', 'neo'] as const)(
  '%s drains inputs queued while idle after exactly one restart',
  (kind) => verifySpentAdmission(kind, 'idle'),
  90000
);

test(
  'large synthetic history does not delay queued input recovery',
  () => verifySpentAdmission('neo', 'history'),
  90000
);
