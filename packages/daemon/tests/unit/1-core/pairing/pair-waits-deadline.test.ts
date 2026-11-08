import { afterEach, expect, test, vi } from 'vitest';
import { createPairWaits } from '../../../../src/lib/pairing/pair-waits.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('a timer wake before the expiry keeps the phone waiting', async () => {
  vi.useFakeTimers();
  let now = 1_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const waits = createPairWaits();
  let settled = false;
  const held = waits.hold('phone', 100).then((result) => {
    settled = true;
    return result;
  });
  now = 1_099;
  await vi.advanceTimersByTimeAsync(100);
  expect(settled).toBe(false);
  now = 1_100;
  await vi.advanceTimersByTimeAsync(1);
  expect(await held).toBe(true);
});
