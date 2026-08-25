import { describe, expect, test } from 'bun:test';
import { createStartupPhaseTimer } from '../../../src/lib/startup-phase-timer';

describe('createStartupPhaseTimer', () => {
  test('attributes each elapsed interval to the phase that produced it', () => {
    const timestamps = [1_000, 1_120, 1_500];
    const logs: string[] = [];
    const timer = createStartupPhaseTimer(
      (message) => logs.push(message),
      () => timestamps.shift() ?? 0
    );

    timer.start('database initialize');
    expect(logs).toEqual([]);

    timer.start('providers');
    expect(logs).toEqual(['[startup 1] database initialize (+120ms, total 120ms)']);

    timer.finish();
    expect(logs).toEqual([
      '[startup 1] database initialize (+120ms, total 120ms)',
      '[startup 2] providers (+380ms, total 500ms)',
    ]);
  });

  test('finishes an active phase only once', () => {
    const logs: string[] = [];
    const timer = createStartupPhaseTimer(
      (message) => logs.push(message),
      () => 1_000
    );

    timer.start('database initialize');
    timer.finish();
    timer.finish();

    expect(logs).toEqual(['[startup 1] database initialize (+0ms, total 0ms)']);
  });
});
