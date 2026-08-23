import { describe, expect, it } from 'bun:test';
import { installProcessFatalLogging } from '../../../src/lib/process-fatal-logger';
import { subscribeToStructuredLogs } from '../../../src/lib/logger';
import type { StructuredLogEvent } from '@hyperneo/shared';

describe('installProcessFatalLogging', () => {
  it('logs and exits on uncaughtException', async () => {
    const events: StructuredLogEvent[] = [];
    const unsubscribe = subscribeToStructuredLogs((event) => events.push(event));
    const exitCodes: number[] = [];
    let resolveFlush: () => void = () => {};
    const dispose = installProcessFatalLogging({
      flush: () =>
        new Promise<void>((resolve) => {
          resolveFlush = resolve;
        }),
      exit: (code) => exitCodes.push(code),
    });

    try {
      process.emit('uncaughtException', new Error('boom-uncaught'));
      expect(events.length).toBe(1);
      expect(exitCodes).toEqual([]);

      resolveFlush();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(exitCodes).toEqual([1]);
      expect(events.length).toBe(1);
      expect(events[0].level).toBe('fatal');
      expect(events[0].metadata.processEvent).toBe('uncaughtException');
      expect(events[0].message).toContain('boom-uncaught');
    } finally {
      dispose();
      unsubscribe();
    }
  });

  it('logs and exits on unhandledRejection', async () => {
    const events: StructuredLogEvent[] = [];
    const unsubscribe = subscribeToStructuredLogs((event) => events.push(event));
    const exitCodes: number[] = [];
    const dispose = installProcessFatalLogging({
      flush: () => Promise.resolve(),
      exit: (code) => exitCodes.push(code),
    });

    try {
      process.emit('unhandledRejection', 'rejection-reason', Promise.resolve());
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(exitCodes).toEqual([1]);
      expect(events.length).toBe(1);
      expect(events[0].metadata.processEvent).toBe('unhandledRejection');
      expect(events[0].message).toContain('rejection-reason');
    } finally {
      dispose();
      unsubscribe();
    }
  });

  it('ignores a second fatal event while handling the first', async () => {
    const events: StructuredLogEvent[] = [];
    const unsubscribe = subscribeToStructuredLogs((event) => events.push(event));
    const exitCodes: number[] = [];
    let resolveFlush: () => void = () => {};
    const dispose = installProcessFatalLogging({
      flush: () =>
        new Promise<void>((resolve) => {
          resolveFlush = resolve;
        }),
      exit: (code) => exitCodes.push(code),
    });

    try {
      process.emit('uncaughtException', new Error('first'));
      process.emit('unhandledRejection', 'second', Promise.resolve());
      resolveFlush();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(exitCodes).toEqual([1]);
      expect(events.length).toBe(1);
    } finally {
      dispose();
      unsubscribe();
    }
  });

  it('removes process listeners on dispose', () => {
    const before = {
      uncaught: process.listenerCount('uncaughtException'),
      rejection: process.listenerCount('unhandledRejection'),
    };
    const dispose = installProcessFatalLogging({
      flush: () => Promise.resolve(),
      exit: () => {},
    });

    expect(process.listenerCount('uncaughtException')).toBe(before.uncaught + 1);
    expect(process.listenerCount('unhandledRejection')).toBe(before.rejection + 1);

    dispose();

    expect(process.listenerCount('uncaughtException')).toBe(before.uncaught);
    expect(process.listenerCount('unhandledRejection')).toBe(before.rejection);
  });

  it('shares one listener set across installs with the latest registration active', async () => {
    const exitsFirst: number[] = [];
    const exitsSecond: number[] = [];
    const before = process.listenerCount('uncaughtException');
    const disposeFirst = installProcessFatalLogging({
      flush: () => Promise.resolve(),
      exit: (code) => exitsFirst.push(code),
    });
    const disposeSecond = installProcessFatalLogging({
      flush: () => Promise.resolve(),
      exit: (code) => exitsSecond.push(code),
    });

    try {
      expect(process.listenerCount('uncaughtException')).toBe(before + 1);

      process.emit('uncaughtException', new Error('latest-wins'));
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(exitsSecond).toEqual([1]);
      expect(exitsFirst).toEqual([]);
    } finally {
      disposeSecond();
      disposeFirst();
    }

    expect(process.listenerCount('uncaughtException')).toBe(before);
  });

  it('falls back to the earlier registration after the latest is disposed', async () => {
    const exitsFirst: number[] = [];
    const exitsSecond: number[] = [];
    const disposeFirst = installProcessFatalLogging({
      flush: () => Promise.resolve(),
      exit: (code) => exitsFirst.push(code),
    });
    const disposeSecond = installProcessFatalLogging({
      flush: () => Promise.resolve(),
      exit: (code) => exitsSecond.push(code),
    });
    disposeSecond();

    try {
      process.emit('unhandledRejection', 'fallback-reason', Promise.resolve());
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(exitsFirst).toEqual([1]);
      expect(exitsSecond).toEqual([]);
    } finally {
      disposeFirst();
    }
  });
});
