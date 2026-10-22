import { describe, expect, mock, test } from 'bun:test';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import {
  readDriverFollowUp,
  readDriverInputAttribution,
  readDriverSettlement,
} from '../../../../src/lib/neo/driver-work.ts';
import {
  type NeoDriverSettleDeps,
  settleNeoDriverWork,
} from '../../../../src/lib/neo/settle-driver-work.ts';
import type { WorkRef } from '../../../../src/lib/drivers/types.ts';

const receipt = { executionId: 'session-7', inputId: 'input-3' };
const opening = 'Raise the font.';
const work: NeoWork = Object.freeze({
  id: 'work-1',
  requestKey: 'root:k',
  originSessionId: 'root',
  originMessageId: 'm1',
  projectId: null,
  title: 'Font',
  instruction: opening,
  targetSessionId: null,
  sessionId: null,
  status: 'queued',
  report: null,
  createdAt: 1,
  updatedAt: 100,
});
const ref: WorkRef = { adapter: 'space', id: 'space-1:agent-1' };

const observed = (replies: string[], exchangeCut = false, echoed = receipt) => ({
  receipt: echoed,
  state: 'observed',
  exchange: [
    { at: 150, role: 'user', text: opening },
    ...replies.map((text, index) => ({ at: 200 + index, role: 'agent', text })),
  ],
  exchangeCut,
});
const status = (value: Record<string, unknown>) => ({
  kind: 'completed' as const,
  value: {
    ok: true,
    value: {
      status: 'done',
      lastActivityAt: 400,
      lastReply: 'An answer to a later human message.',
      lastReplyAt: 400,
      exchange: [
        { at: 150, role: 'user', text: opening },
        { at: 200, role: 'agent', text: 'Raised it.' },
      ],
      ...value,
    },
  },
});

describe('readDriverInputAttribution', () => {
  test('reads nothing for a card that holds no receipt', () => {
    expect(
      readDriverInputAttribution(status({ inputEvidence: observed(['Raised it.']) }), undefined)
    ).toBeNull();
  });

  test('takes only agent replies from evidence that echoes the exact receipt', () => {
    expect(
      readDriverInputAttribution(status({ inputEvidence: observed(['Raised it.']) }), receipt)
    ).toEqual({
      state: 'observed',
      replies: [{ at: 200, role: 'agent', text: 'Raised it.' }],
      cut: false,
    });
  });

  test('keeps an accepted but unread input pending', () => {
    expect(
      readDriverInputAttribution(status({ inputEvidence: { receipt, state: 'pending' } }), receipt)
    ).toEqual({ state: 'pending' });
  });

  test.each([
    ['missing', undefined],
    ['unavailable', { receipt, state: 'unavailable' }],
    ['for another input', observed(['Raised it.'], false, { ...receipt, inputId: 'input-4' })],
    [
      'for another execution',
      { receipt: { ...receipt, executionId: 'session-8' }, state: 'pending' },
    ],
    ['malformed', { receipt, state: 'observed' }],
  ])('treats %s evidence as unverified', (_, inputEvidence) => {
    expect(readDriverInputAttribution(status({ inputEvidence }), receipt)).toEqual({
      state: 'unverified',
    });
  });
});

describe('readDriverSettlement', () => {
  test("reports the card's own replies even after a later human message", () => {
    expect(
      readDriverSettlement(
        work,
        status({ inputEvidence: observed(['Raised it.']) }),
        500,
        140,
        true,
        opening,
        receipt
      )
    ).toEqual({
      status: 'reported',
      report: 'Agent: Raised it.',
    });
  });

  test('settles from evidence before the card ever anchored', () => {
    expect(
      readDriverSettlement(
        work,
        status({ inputEvidence: observed(['Raised it.']) }),
        500,
        null,
        true,
        opening,
        receipt
      )
    ).toMatchObject({
      status: 'reported',
    });
  });

  test('says when later replies were cut', () => {
    expect(
      readDriverSettlement(
        work,
        status({ inputEvidence: observed(['Raised it.'], true) }),
        500,
        140,
        true,
        opening,
        receipt
      )?.report
    ).toBe('Agent: Raised it.\n\n(Later replies were not read; this is not the whole exchange.)');
  });

  test.each([
    ['missing', undefined],
    ['other input', observed(['Raised it.'], false, { ...receipt, inputId: 'other' })],
    ['other execution', observed(['Raised it.'], false, { ...receipt, executionId: 'other' })],
    ['malformed', { receipt, state: 'observed' }],
  ])('rejects %s result evidence despite an exact opening match', (_, inputEvidence) => {
    const outcome = status({ inputEvidence });
    expect(readDriverSettlement(work, outcome, 500, 140, true, opening, receipt)).toBeNull();
    expect(readDriverFollowUp(outcome, 0, { inputBefore: 149, opening, receipt })).toBeNull();
  });

  test('keeps complete receipt-bound report bytes for settlement and follow-up', () => {
    const report = '  Complete explicit result 🔬\n'.repeat(1000) + '\n';
    const outcome = status({
      inputEvidence: {
        ...observed([]),
        replyAvailability: 'complete',
        replyReport: report,
        replyAt: 200,
      },
    });
    expect(readDriverSettlement(work, outcome, 500, null, true, opening, receipt)).toEqual({
      status: 'reported',
      report,
    });
    expect(readDriverFollowUp(outcome, 0, { inputBefore: 149, opening, receipt })).toBe(report);
  });

  test('waits on running work and on an input still pending', () => {
    expect(
      readDriverSettlement(
        work,
        status({ status: 'running', inputEvidence: observed(['Half way.']) }),
        500,
        140,
        true,
        opening,
        receipt
      )
    ).toBeNull();
    expect(
      readDriverSettlement(
        work,
        status({ inputEvidence: { receipt, state: 'pending' } }),
        500,
        140,
        true,
        opening,
        receipt
      )
    ).toBeNull();
  });

  test('fails work that stopped before it read the message', () => {
    expect(
      readDriverSettlement(
        work,
        status({ status: 'stopped', inputEvidence: { receipt, state: 'pending' } }),
        500,
        140,
        true,
        opening,
        receipt
      )
    ).toEqual({
      status: 'failed',
      report: 'It stopped before it read the message.',
    });
  });

  test('does not infer a result when evidence for the receipt is unavailable', () => {
    const settled = readDriverSettlement(
      work,
      status({ inputEvidence: { receipt, state: 'unavailable' } }),
      500,
      140,
      true,
      opening,
      receipt
    );
    expect(settled).toBeNull();
  });

  test('cannot turn an opening match without a receipt into a result', () => {
    expect(readDriverSettlement(work, status({}), 500, 140, true, opening)).toBeNull();
  });
});

describe('readDriverFollowUp', () => {
  const sent = { inputBefore: 149, opening, receipt };

  test("follows only the card's own replies after the anchor", () => {
    expect(
      readDriverFollowUp(
        status({ inputEvidence: observed(['Raised it.', 'Also the headings.']) }),
        200,
        sent
      )
    ).toBe('Agent: Also the headings.');
  });

  test('says nothing while the input is pending', () => {
    expect(
      readDriverFollowUp(status({ inputEvidence: { receipt, state: 'pending' } }), 0, sent)
    ).toBeNull();
  });

  test('does not publish a follow-up without matching evidence', () => {
    expect(readDriverFollowUp(status({}), 0, sent)).toBeNull();
  });
});

describe('settleNeoDriverWork', () => {
  test("asks the driver for evidence of the card's own input", async () => {
    const readStatus = mock(async () => status({ inputEvidence: observed(['Raised it.']) }));
    const deps: NeoDriverSettleDeps = {
      readStartedAt: () => 140,
      readSent: () => ({ inputBefore: 149, opening, receipt }),
      readLiveStatus: () => null,
      isContinuing: () => true,
      readStatus,
      recordStartedAt: () => {},
      recordLive: () => false,
      recordCheck: () => false,
      notifyChanged: () => {},
      noteUnsettled: async () => {},
      forgetActivity: () => {},
      transition: (current) => current,
      anchorFollow: () => {},
      returnReport: async () => {},
    };
    expect(await settleNeoDriverWork(deps, work, ref)).toEqual({
      status: 'reported',
      report: 'Agent: Raised it.',
    });
    expect(readStatus).toHaveBeenCalledWith(work, ref, 149, receipt);
  });
});
