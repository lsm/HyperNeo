import { describe, it, expect } from 'bun:test';
import { DeliveryTurnStallWatchdog } from '../../../../src/lib/agent/delivery-turn-stall-watchdog';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('DeliveryTurnStallWatchdog (no-progress stall detector)', () => {
  it('fires onFire + resolves after the no-activity window with no outstanding tool', async () => {
    let fired = false;
    const wd = new DeliveryTurnStallWatchdog(
      40,
      () => false,
      async () => {
        fired = true;
      }
    );
    const promise = wd.arm();
    expect(fired).toBe(false);
    await promise;
    expect(fired).toBe(true);
  });

  it('does NOT fire while SDK messages keep bumping the window (a live turn)', async () => {
    let fired = false;
    const wd = new DeliveryTurnStallWatchdog(
      40,
      () => false,
      async () => {
        fired = true;
      }
    );
    const promise = wd.arm();
    // Simulate a continuous stream of SDK messages every 15ms — well inside the
    // 40ms window. A multi-hour turn that keeps producing output never stalls.
    for (let i = 0; i < 10; i++) {
      await sleep(15);
      wd.bump();
    }
    wd.cancel();
    expect(fired).toBe(false);
    // Cancel resolves nothing; the promise stays pending (the turn ended
    // normally). Assert it did not resolve to a stall.
    let resolved = false;
    promise.then(() => {
      resolved = true;
    });
    await sleep(10);
    expect(resolved).toBe(false);
  });

  it('defers while a tool is outstanding, then fires once the tool completes', async () => {
    let outstanding = true;
    let fired = false;
    const wd = new DeliveryTurnStallWatchdog(
      40,
      () => outstanding,
      async () => {
        fired = true;
      }
    );
    const promise = wd.arm();
    // At 40ms the watchdog ticks but a tool is running → defer (re-arm), no fire.
    await sleep(60);
    expect(fired).toBe(false);
    // Tool completes; the next tick (after another window) finds no outstanding
    // tool → fires.
    outstanding = false;
    await promise;
    expect(fired).toBe(true);
  });

  it('cancel() prevents the fire', async () => {
    let fired = false;
    const wd = new DeliveryTurnStallWatchdog(
      30,
      () => false,
      async () => {
        fired = true;
      }
    );
    wd.arm();
    wd.cancel();
    await sleep(60);
    expect(fired).toBe(false);
  });

  it('a second arm() replaces the prior watchdog', async () => {
    let fired = false;
    const wd = new DeliveryTurnStallWatchdog(
      20,
      () => false,
      async () => {
        fired = true;
      }
    );
    wd.arm();
    // Re-arm with a fresh window before the first would fire.
    const second = wd.arm();
    await second;
    expect(fired).toBe(true);
  });
});
