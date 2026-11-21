import { mkdtemp, rm } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import { expect, test } from 'vitest';
import { createCodexCutover } from '../../../../src/lib/drivers/codex-cutover.ts';
import { exerciseCodexSetupHost } from '../../../fixtures/codex-setup-host.ts';

test('the host waits for a managed turn and keeps new HyperNeo sends behind the cutover', async () => {
  const home = await mkdtemp('/tmp/hn-cutover-');
  try {
    expect(await exerciseCodexSetupHost(home)).toEqual({
      idleReads: 4,
      deferredRestarts: 1,
      heldSends: 1,
      migratedJobs: 2,
    });
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

test('a cutover drains admitted sends and releases waiting work when the status read fails', async () => {
  const finishSend = Promise.withResolvers<void>();
  const events: string[] = [];
  const gate = createCodexCutover(async () => {
    events.push('read');
    throw new Error('managed status unavailable');
  });
  const first = gate.admit(() => finishSend.promise);
  const cutover = gate.atIdle(async () => {
    events.push('effect');
  });
  const rejected = expect(cutover).rejects.toThrow('managed status unavailable');
  const next = gate.admit(async () => {
    events.push('send');
  });
  try {
    await setImmediate();
    expect(events).toEqual([]);
  } finally {
    finishSend.resolve();
    await Promise.all([first, next, rejected]);
  }
  expect(events).toEqual(['read', 'send']);
});
