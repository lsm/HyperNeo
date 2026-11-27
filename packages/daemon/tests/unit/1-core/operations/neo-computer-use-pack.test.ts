import { expect, test } from 'bun:test';
import {
  NEO_PACK_COMPUTER_USE_INSTRUCTIONS,
  NEO_PACK_COMPUTER_USE_WORKER_GUIDANCE,
} from '@hyperneo/prompts';
import { createComputerUsePack } from '../../../../src/lib/neo/packs/computer-use/pack.ts';

test('serves the guidance with no desktop control preference', () => {
  const pack = createComputerUsePack();
  expect(pack.alwaysEnabled).toBe(true);
  expect(pack.instructions()).toBe(NEO_PACK_COMPUTER_USE_INSTRUCTIONS);
  expect(pack.instructions()).not.toContain('preference');
});

test('gives workers the desktop permission wait rule', () => {
  expect(createComputerUsePack().workerContext?.()).toBe(NEO_PACK_COMPUTER_USE_WORKER_GUIDANCE);
  expect(NEO_PACK_COMPUTER_USE_WORKER_GUIDANCE).toContain('desktop_permissions_required');
});
