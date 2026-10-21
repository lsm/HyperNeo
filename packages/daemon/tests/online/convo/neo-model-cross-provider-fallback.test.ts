import { test } from 'bun:test';
import { proveNeoModelFallback } from '../../helpers/neo-model-fallback-proof.ts';

test(
  'Neo completes an Anthropic-limited input through GLM and returns to primary thinking',
  () => proveNeoModelFallback('glm'),
  90000
);
