import { describe, expect, it } from 'bun:test';

import type { SDKMessage } from '@hyperneo/shared/sdk';
import {
  classifySdkStartOutcome,
  type SdkStartClassification,
  type SdkStartClassifyConfig,
  type SdkStartObservation,
} from '../../../../src/lib/agent/sdk-start-terminal';

function msg(fields: Record<string, unknown>): SDKMessage {
  return fields as unknown as SDKMessage;
}

function statusBlip(): SDKMessage {
  return msg({ type: 'system', subtype: 'status', status: 'connected' });
}

function observe(overrides: Partial<SdkStartObservation> = {}): SdkStartObservation {
  return {
    processExit: null,
    streamClosed: false,
    messages: [],
    inactivity: null,
    ...overrides,
  };
}

interface DecisionRow {
  name: string;
  observation: Partial<SdkStartObservation>;
  config?: SdkStartClassifyConfig;
  expected: SdkStartClassification;
}

const decisionTable: DecisionRow[] = [
  {
    name: 'bare observation stays alive without progress',
    observation: {},
    expected: { outcome: 'alive', progress: false },
  },
  {
    name: 'ambient-only messages are non-progress',
    observation: {
      messages: [
        statusBlip(),
        msg({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10 }),
        msg({ type: 'auth_status' }),
      ],
    },
    expected: { outcome: 'alive', progress: false },
  },
  {
    name: 'process exit without progress is dead with exit info',
    observation: { processExit: { code: 1, signal: null } },
    expected: { outcome: 'dead', reason: 'process_exit', exitInfo: { code: 1, signal: null } },
  },
  {
    name: 'signal kill exit without progress is dead',
    observation: {
      processExit: { code: null, signal: 'SIGKILL' },
      messages: [statusBlip()],
    },
    expected: {
      outcome: 'dead',
      reason: 'process_exit',
      exitInfo: { code: null, signal: 'SIGKILL' },
    },
  },
  {
    name: 'clean zero exit without progress is still dead',
    observation: { processExit: { code: 0, signal: null } },
    expected: { outcome: 'dead', reason: 'process_exit', exitInfo: { code: 0, signal: null } },
  },
  {
    name: 'process exit outranks stream close',
    observation: { processExit: { code: 1, signal: null }, streamClosed: true },
    expected: { outcome: 'dead', reason: 'process_exit', exitInfo: { code: 1, signal: null } },
  },
  {
    name: 'stream close without progress is dead',
    observation: { streamClosed: true },
    expected: { outcome: 'dead', reason: 'stream_closed' },
  },
  {
    name: 'stream close after ambient-only messages is dead',
    observation: {
      streamClosed: true,
      messages: [msg({ type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 10 })],
    },
    expected: { outcome: 'dead', reason: 'stream_closed' },
  },
  {
    name: 'process exit outranks an elapsed backstop',
    observation: {
      processExit: { code: 1, signal: null },
      inactivity: { elapsedMs: 900_000, lastActivityAt: 456 },
    },
    config: { inactivityBackstopMs: 600_000 },
    expected: { outcome: 'dead', reason: 'process_exit', exitInfo: { code: 1, signal: null } },
  },
  {
    name: 'stream close outranks an elapsed backstop',
    observation: { streamClosed: true, inactivity: { elapsedMs: 900_000, lastActivityAt: 456 } },
    config: { inactivityBackstopMs: 600_000 },
    expected: { outcome: 'dead', reason: 'stream_closed' },
  },
  {
    name: 'backstop fires at the configured threshold',
    observation: { inactivity: { elapsedMs: 600_000, lastActivityAt: 1234 } },
    config: { inactivityBackstopMs: 600_000 },
    expected: { outcome: 'backstop', inactivity: { elapsedMs: 600_000, lastActivityAt: 1234 } },
  },
  {
    name: 'elapsed below the threshold stays alive',
    observation: { inactivity: { elapsedMs: 599_999, lastActivityAt: 1234 } },
    config: { inactivityBackstopMs: 600_000 },
    expected: { outcome: 'alive', progress: false },
  },
  {
    name: 'no backstop without configuration',
    observation: { inactivity: { elapsedMs: 3_600_000, lastActivityAt: 1 } },
    expected: { outcome: 'alive', progress: false },
  },
  {
    name: 'no backstop without inactivity data',
    observation: { inactivity: null },
    config: { inactivityBackstopMs: 600_000 },
    expected: { outcome: 'alive', progress: false },
  },
  {
    name: 'ambient-only messages do not block an elapsed backstop',
    observation: {
      messages: [statusBlip()],
      inactivity: { elapsedMs: 700_000, lastActivityAt: null },
    },
    config: { inactivityBackstopMs: 600_000 },
    expected: { outcome: 'backstop', inactivity: { elapsedMs: 700_000, lastActivityAt: null } },
  },
  {
    name: 'ambient-first meaningful-second outranks every terminal event',
    observation: {
      messages: [statusBlip(), msg({ type: 'assistant' })],
      processExit: { code: 1, signal: null },
      streamClosed: true,
      inactivity: { elapsedMs: 900_000, lastActivityAt: 123 },
    },
    config: { inactivityBackstopMs: 600_000 },
    expected: { outcome: 'alive', progress: true },
  },
  {
    name: 'ambient blip then init outranks stream close',
    observation: {
      messages: [statusBlip(), msg({ type: 'system', subtype: 'init' })],
      streamClosed: true,
    },
    expected: { outcome: 'alive', progress: true },
  },
  {
    name: 'ambient blip then result outranks signal kill exit',
    observation: {
      messages: [statusBlip(), msg({ type: 'result', subtype: 'success' })],
      processExit: { code: null, signal: 'SIGKILL' },
    },
    expected: { outcome: 'alive', progress: true },
  },
];

describe('classifySdkStartOutcome decision table', () => {
  for (const row of decisionTable) {
    it(row.name, () => {
      expect(classifySdkStartOutcome(observe(row.observation), row.config)).toEqual(row.expected);
    });
  }

  it('classifies a meaningful message anywhere in the window as progress', () => {
    for (const meaningful of [
      msg({ type: 'assistant' }),
      msg({ type: 'user' }),
      msg({ type: 'user', isReplay: true }),
      msg({ type: 'result', subtype: 'success' }),
      msg({ type: 'result', subtype: 'error_during_execution' }),
      msg({ type: 'stream_event' }),
      msg({ type: 'system', subtype: 'init' }),
    ]) {
      expect(classifySdkStartOutcome(observe({ messages: [meaningful] }))).toEqual({
        outcome: 'alive',
        progress: true,
      });
      expect(classifySdkStartOutcome(observe({ messages: [statusBlip(), meaningful] }))).toEqual({
        outcome: 'alive',
        progress: true,
      });
    }
  });
});
