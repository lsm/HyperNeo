import { test } from 'bun:test';
import { verifySpentAdmission } from '../helpers/spent-admission-proof.ts';

test.each(['ordinary', 'neo'] as const)(
  '%s delivers all queued markers after restart without a nudge',
  (kind) => verifySpentAdmission(kind, 'full'),
  90000
);
