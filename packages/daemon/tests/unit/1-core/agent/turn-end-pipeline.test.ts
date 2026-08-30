import { describe, expect, it } from 'bun:test';
import {
  decideTurnEnd,
  selectTurnEndAckRow,
  type TurnEndAckRow,
  type TurnEndPipelineInput,
} from '../../../../src/lib/agent/turn-end-pipeline';
import {
  resetTurnEndFlags,
  routeTurnEnd,
  type TurnEndEvent,
  type TurnEndFlags,
  type TurnEndResultEvent,
} from '../../../../src/lib/agent/turn-end-routing';
import {
  recordResultUsage,
  type UsageAccountingState,
} from '../../../../src/lib/agent/usage-accounting';

const usageState: UsageAccountingState = {
  messageCount: 2,
  totalTokens: 100,
  inputTokens: 60,
  outputTokens: 40,
  totalCost: 0.5,
  toolCallCount: 1,
  lastSdkCost: 0.2,
  costBaseline: 0.3,
};

const resultUsage = { usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.25 };

const resultEvent = (overrides: Partial<TurnEndResultEvent> = {}): TurnEndEvent => ({
  kind: 'result',
  result: {
    isTopLevel: true,
    isSuccess: true,
    isLimitError: false,
    isLimitRecoveryEngaged: false,
    confirmsArmedClear: false,
    ...overrides,
  },
});

const ACK_ROWS: TurnEndAckRow[] = [
  {
    uuid: 'free-1',
    durableOwned: false,
    yielded: false,
    pendingOrClaimed: false,
  },
  {
    uuid: 'owned-2',
    durableOwned: true,
    yielded: false,
    pendingOrClaimed: false,
  },
  {
    uuid: 'active-3',
    durableOwned: true,
    yielded: true,
    pendingOrClaimed: false,
  },
  {
    uuid: 'pending-4',
    durableOwned: false,
    yielded: false,
    pendingOrClaimed: true,
  },
];

const input = (overrides: Partial<TurnEndPipelineInput> = {}): TurnEndPipelineInput => ({
  flags: resetTurnEndFlags,
  event: resultEvent(),
  queryMode: 'immediate',
  usageState,
  resultUsage,
  acknowledgedPersistedUserThisTurn: false,
  activeMessageId: 'active-3',
  ackRows: ACK_ROWS,
  ...overrides,
});

describe('decideTurnEnd', () => {
  it('composes usage accounting, ack selection, and turn-end routing into one decision', () => {
    const decision = decideTurnEnd(input());
    expect(decision).toEqual({
      usage: recordResultUsage(usageState, resultUsage),
      ackSelection: [
        { messageId: 'free-1', deliveryUuids: ['free-1'] },
        { messageId: 'active-3', deliveryUuids: ['active-3'] },
      ],
      plan: routeTurnEnd(resetTurnEndFlags, resultEvent(), { queryMode: 'immediate' }),
    });
  });

  const NOT_ADMITTED: Array<{
    label: string;
    overrides: Partial<TurnEndPipelineInput>;
    usageFolded: boolean;
  }> = [
    {
      label: 'an armed idle suppression skips the fallback-ack loop but still accounts usage',
      overrides: { flags: { ...resetTurnEndFlags, suppressIdleOnNextResult: true } },
      usageFolded: true,
    },
    {
      label: 'an already-acknowledged turn skips the fallback-ack loop but still accounts usage',
      overrides: { acknowledgedPersistedUserThisTurn: true },
      usageFolded: true,
    },
    {
      label:
        'an engaged limit recovery on an error-subtype result skips the fallback-ack loop but still accounts usage',
      overrides: {
        event: resultEvent({
          isSuccess: false,
          isLimitError: true,
          isLimitRecoveryEngaged: true,
        }),
      },
      usageFolded: true,
    },
    {
      label: 'a pre-recovery limit result defers both the fallback-ack loop and usage accounting',
      overrides: {
        event: resultEvent({ isLimitError: true, isLimitRecoveryEngaged: null }),
      },
      usageFolded: false,
    },
    {
      label: 'a nested result skips both the fallback-ack loop and usage accounting',
      overrides: { event: resultEvent({ isTopLevel: false }) },
      usageFolded: false,
    },
  ];

  for (const row of NOT_ADMITTED) {
    it(row.label, () => {
      const decision = decideTurnEnd(input(row.overrides));
      expect(decision.ackSelection).toEqual([]);
      expect(decision.usage).toEqual(
        row.usageFolded ? recordResultUsage(usageState, resultUsage) : usageState
      );
    });
  }

  it('a session-state event passes usage through and routes the idle plan', () => {
    const event: TurnEndEvent = { kind: 'sessionState', state: 'idle' };
    const flags: TurnEndFlags = { ...resetTurnEndFlags, lastResultWasSuccess: true };
    const decision = decideTurnEnd(input({ flags, event, resultUsage: null }));
    expect(decision).toEqual({
      usage: usageState,
      ackSelection: [],
      plan: routeTurnEnd(flags, event, { queryMode: 'immediate' }),
    });
  });
});

describe('selectTurnEndAckRow', () => {
  it('a row that gains a durable owner mid-loop revalidates to no selection', () => {
    expect(selectTurnEndAckRow(ACK_ROWS[2], 'active-3')).toEqual({
      messageId: 'active-3',
      deliveryUuids: ['active-3'],
    });
    const resnapshotted: TurnEndAckRow = { ...ACK_ROWS[2], pendingOrClaimed: true };
    expect(selectTurnEndAckRow(resnapshotted, 'active-3')).toEqual(null);
    expect(selectTurnEndAckRow(ACK_ROWS[2], 'successor-message')).toEqual(null);
  });
});
