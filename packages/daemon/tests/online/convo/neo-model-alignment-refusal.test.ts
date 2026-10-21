import { test } from 'bun:test';
import { proveNeoModelFallback } from '../../helpers/neo-model-fallback-proof.ts';

test(
  'Neo keeps fallback thinking when the saved primary disappears before restoration',
  () => proveNeoModelFallback('glm', true),
  90000
);
