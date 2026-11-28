import { expect, test } from 'bun:test';
import {
  CLAUDE_DESKTOP_HELPER_BRIEF,
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

test('routes Remote Control and archiving to neo-helper, not desktop control', () => {
  const instructions = createComputerUsePack().instructions();
  expect(instructions).toContain('Never use desktop control to turn Remote Control on or off');
  expect(instructions).toContain('work.send the neo-helper session');
  expect(instructions).toContain('neo.session.archive');
  expect(CLAUDE_DESKTOP_HELPER_BRIEF).toContain(
    'Turn Remote Control on or off for a named session id'
  );
});
