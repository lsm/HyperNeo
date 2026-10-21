import { test } from 'bun:test';
import { verifySpentAdmission } from '../../helpers/spent-admission-proof.ts';

test.each(['ordinary', 'neo'] as const)(
  '%s bounds delivery admission after a deploy restart',
  (kind) => verifySpentAdmission(kind, 'deadline'),
  90000
);
