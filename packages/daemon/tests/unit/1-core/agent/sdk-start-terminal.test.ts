import { describe, expect, it } from 'bun:test';

import type { SDKMessage } from '@hyperneo/shared/sdk';
import {
  classifySdkStartOutcome,
  type SdkStartObservation,
} from '../../../../src/lib/agent/sdk-start-terminal';

function msg(fields: Record<string, unknown>): SDKMessage {
  return fields as unknown as SDKMessage;
}

function observe(overrides: Partial<SdkStartObservation> = {}): SdkStartObservation {
  return {
    processExit: null,
    streamClosed: false,
    firstMessage: null,
    inactivity: null,
    ...overrides,
  };
}

describe('classifySdkStartOutcome', () => {
  it('classifies a bare observation as alive without progress', () => {
    expect(classifySdkStartOutcome(observe())).toEqual({ outcome: 'alive', progress: false });
  });

  it('classifies a meaningful first message as alive with progress', () => {
    for (const firstMessage of [
      msg({ type: 'assistant' }),
      msg({ type: 'user' }),
      msg({ type: 'user', isReplay: true }),
      msg({ type: 'result', subtype: 'success' }),
      msg({ type: 'result', subtype: 'error_during_execution' }),
      msg({ type: 'stream_event' }),
      msg({ type: 'system', subtype: 'init' }),
    ]) {
      expect(classifySdkStartOutcome(observe({ firstMessage }))).toEqual({
        outcome: 'alive',
        progress: true,
      });
    }
  });

  it('treats ambient first messages as non-progress via the shared classifier', () => {
    for (const firstMessage of [
      msg({ type: 'system', subtype: 'status', status: 'connected' }),
      msg({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10 }),
      msg({ type: 'auth_status' }),
    ]) {
      expect(classifySdkStartOutcome(observe({ firstMessage }))).toEqual({
        outcome: 'alive',
        progress: false,
      });
    }
  });

  it('progress outranks terminal events: a live start is not retroactively dead', () => {
    expect(
      classifySdkStartOutcome(
        observe({
          firstMessage: msg({ type: 'assistant' }),
          processExit: { code: 1, signal: null },
          streamClosed: true,
        })
      )
    ).toEqual({ outcome: 'alive', progress: true });
    expect(
      classifySdkStartOutcome(
        observe({
          firstMessage: msg({ type: 'system', subtype: 'init' }),
          streamClosed: true,
          inactivity: { elapsedMs: 900_000, lastActivityAt: 123 },
        }),
        { inactivityBackstopMs: 600_000 }
      )
    ).toEqual({ outcome: 'alive', progress: true });
  });

  it('classifies a process exit before progress as dead with exit info', () => {
    expect(classifySdkStartOutcome(observe({ processExit: { code: 1, signal: null } }))).toEqual({
      outcome: 'dead',
      reason: 'process_exit',
      exitInfo: { code: 1, signal: null },
    });
    expect(
      classifySdkStartOutcome(
        observe({
          processExit: { code: null, signal: 'SIGKILL' },
          firstMessage: msg({ type: 'system', subtype: 'status', status: 'connected' }),
        })
      )
    ).toEqual({
      outcome: 'dead',
      reason: 'process_exit',
      exitInfo: { code: null, signal: 'SIGKILL' },
    });
    expect(classifySdkStartOutcome(observe({ processExit: { code: 0, signal: null } }))).toEqual({
      outcome: 'dead',
      reason: 'process_exit',
      exitInfo: { code: 0, signal: null },
    });
  });

  it('prefers process exit over stream close when both are observed', () => {
    expect(
      classifySdkStartOutcome(
        observe({ processExit: { code: 1, signal: null }, streamClosed: true })
      )
    ).toEqual({
      outcome: 'dead',
      reason: 'process_exit',
      exitInfo: { code: 1, signal: null },
    });
  });

  it('classifies a stream close before progress as dead', () => {
    expect(classifySdkStartOutcome(observe({ streamClosed: true }))).toEqual({
      outcome: 'dead',
      reason: 'stream_closed',
    });
    expect(
      classifySdkStartOutcome(
        observe({
          streamClosed: true,
          firstMessage: msg({ type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 10 }),
        })
      )
    ).toEqual({ outcome: 'dead', reason: 'stream_closed' });
  });

  it('a terminal event outranks an elapsed backstop', () => {
    const inactivity = { elapsedMs: 900_000, lastActivityAt: 456 };
    expect(
      classifySdkStartOutcome(observe({ processExit: { code: 1, signal: null }, inactivity }), {
        inactivityBackstopMs: 600_000,
      })
    ).toEqual({
      outcome: 'dead',
      reason: 'process_exit',
      exitInfo: { code: 1, signal: null },
    });
    expect(
      classifySdkStartOutcome(observe({ streamClosed: true, inactivity }), {
        inactivityBackstopMs: 600_000,
      })
    ).toEqual({ outcome: 'dead', reason: 'stream_closed' });
  });

  it('classifies backstop at and beyond the configured threshold', () => {
    const inactivity = { elapsedMs: 600_000, lastActivityAt: 1234 };
    expect(
      classifySdkStartOutcome(observe({ inactivity }), { inactivityBackstopMs: 600_000 })
    ).toEqual({ outcome: 'backstop', inactivity });
    expect(
      classifySdkStartOutcome(
        observe({ inactivity: { elapsedMs: 599_999, lastActivityAt: 1234 } }),
        {
          inactivityBackstopMs: 600_000,
        }
      )
    ).toEqual({ outcome: 'alive', progress: false });
  });

  it('never classifies backstop without configuration or inactivity data', () => {
    expect(
      classifySdkStartOutcome(observe({ inactivity: { elapsedMs: 3_600_000, lastActivityAt: 1 } }))
    ).toEqual({ outcome: 'alive', progress: false });
    expect(
      classifySdkStartOutcome(observe({ inactivity: null }), { inactivityBackstopMs: 600_000 })
    ).toEqual({ outcome: 'alive', progress: false });
  });

  it('an ambient first message does not block an elapsed backstop', () => {
    const inactivity = { elapsedMs: 700_000, lastActivityAt: null };
    expect(
      classifySdkStartOutcome(
        observe({
          firstMessage: msg({ type: 'system', subtype: 'status', status: 'connected' }),
          inactivity,
        }),
        { inactivityBackstopMs: 600_000 }
      )
    ).toEqual({ outcome: 'backstop', inactivity });
  });
});
