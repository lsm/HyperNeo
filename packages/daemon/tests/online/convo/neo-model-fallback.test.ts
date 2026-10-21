import { test } from 'bun:test';
import { proveNeoModelFallback } from '../../helpers/neo-model-fallback-proof.ts';

test(
  'Neo completes on fallback thinking and returns to primary thinking',
  () => proveNeoModelFallback('anthropic'),
  90000
);
