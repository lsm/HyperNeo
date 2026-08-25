import { describe, expect, it } from 'bun:test';
import type { ExternalEventEssenceEntry } from '../../../../src/lib/external-events/deferred-event-digest';
import {
  applyAdmissionFinalGate,
  applyBufferCapacityGate,
  applyDirectClassGate,
  applyDeliveryV2Gate,
  applyProvenanceGate,
  applySessionStateGate,
  decideExternalEventSteerAdmission,
  type ExternalEventSteerAdmissionInput,
} from '../../../../src/lib/space/runtime/external-event-steer-admission-pipeline';

const REVIEW_ESSENCE: ExternalEventEssenceEntry = {
  eventId: 'rev-1',
  topic: 'github/lsm/hyperneo/pull_request/2828.review_comment_polled',
  actor: 'codex[bot]',
};

const CHECK_ESSENCE: ExternalEventEssenceEntry = {
  eventId: 'chk-1',
  topic: 'github/lsm/hyperneo/pull_request/2828.check_failed',
  conclusion: 'failure',
};

const DIGEST_ESSENCE: ExternalEventEssenceEntry = {
  eventId: 'poll-1',
  topic: 'github/lsm/hyperneo/pull_request/2828.polled',
};

function input(
  overrides: Partial<ExternalEventSteerAdmissionInput> = {}
): ExternalEventSteerAdmissionInput {
  return {
    deliveryV2Enabled: true,
    isSynthetic: true,
    inputKind: 'system',
    processingStatus: 'processing',
    inRateLimitCooldown: false,
    parentTaskLimited: false,
    essences: [REVIEW_ESSENCE],
    bufferedDirectEventCount: 0,
    bufferMaxEntries: 200,
    hydrate: (essence) => essence,
    ...overrides,
  };
}

describe('direct-steer admission pipeline', () => {
  it('admits a hydrated direct-class event from a processing session', () => {
    const outcome = decideExternalEventSteerAdmission(input());
    expect(outcome.decision).toEqual({
      action: 'admit',
      eventClass: 'review',
      essences: [REVIEW_ESSENCE],
    });
  });

  it('carries the fold omission count into the admission', () => {
    const outcome = decideExternalEventSteerAdmission(input({ droppedEventCount: 4 }));
    expect(outcome.decision).toMatchObject({ action: 'admit', droppedEventCount: 4 });
  });

  it('skips when delivery v2 is disabled', () => {
    expect(decideExternalEventSteerAdmission(input({ deliveryV2Enabled: false })).decision).toEqual(
      {
        action: 'skip',
      }
    );
  });

  it('skips human-injected rows regardless of content shape', () => {
    expect(
      decideExternalEventSteerAdmission(input({ isSynthetic: false, inputKind: 'human' })).decision
    ).toEqual({ action: 'skip' });
    expect(decideExternalEventSteerAdmission(input({ inputKind: 'task' })).decision).toEqual({
      action: 'skip',
    });
  });

  it('skips non-processing or limited sessions', () => {
    for (const overrides of [
      { processingStatus: 'waiting_for_input' },
      { processingStatus: 'idle' },
      { inRateLimitCooldown: true },
      { parentTaskLimited: true },
    ] as Array<Partial<ExternalEventSteerAdmissionInput>>) {
      expect(decideExternalEventSteerAdmission(input(overrides)).decision).toEqual({
        action: 'skip',
      });
    }
  });

  it('reports notDirect for digest-tier-only essences', () => {
    expect(
      decideExternalEventSteerAdmission(input({ essences: [DIGEST_ESSENCE] })).decision
    ).toEqual({
      action: 'notDirect',
    });
  });

  it('suppresses admission over the buffer event-count capacity', () => {
    const outcome = decideExternalEventSteerAdmission(
      input({
        essences: Array.from({ length: 10 }, (_, i) => ({ ...CHECK_ESSENCE, eventId: `chk-${i}` })),
        bufferedDirectEventCount: 195,
      })
    );
    expect(outcome.decision).toEqual({ action: 'suppressBufferCap' });
  });

  it('digest-tier passengers do not consume capacity', () => {
    const passengers = Array.from({ length: 250 }, (_, i) => ({
      eventId: `pax-${i}`,
      topic: 'github/lsm/hyperneo/pull_request/2828.polled',
    }));
    const outcome = decideExternalEventSteerAdmission(
      input({ essences: [CHECK_ESSENCE, ...passengers], bufferedDirectEventCount: 199 })
    );
    expect(outcome.decision).toMatchObject({ action: 'admit', eventClass: 'check' });
  });

  it('admits at exactly the capacity boundary', () => {
    const outcome = decideExternalEventSteerAdmission(input({ bufferedDirectEventCount: 199 }));
    expect(outcome.decision).toMatchObject({ action: 'admit' });
  });

  it('picks the first represented class for a mixed fold', () => {
    const outcome = decideExternalEventSteerAdmission(
      input({ essences: [CHECK_ESSENCE, REVIEW_ESSENCE, DIGEST_ESSENCE] })
    );
    expect(outcome.decision).toMatchObject({ action: 'admit', eventClass: 'check' });
  });
});

describe('direct-steer admission gate order', () => {
  it('provenance gates fire before classification', () => {
    const ctx = applyDeliveryV2Gate({
      ...input(),
      decision: null,
    });
    expect(ctx.decision).toBeNull();
    const skipped = applyProvenanceGate({ ...ctx, isSynthetic: false });
    expect(skipped.decision).toEqual({ action: 'skip' });
  });

  it('the final gate is reachable only when every earlier gate passes', () => {
    const ctx = applyAdmissionFinalGate(
      applyBufferCapacityGate(
        applyDirectClassGate(
          applySessionStateGate(
            applyProvenanceGate(applyDeliveryV2Gate({ ...input(), decision: null }))
          )
        )
      )
    );
    expect(ctx.decision).toMatchObject({ action: 'admit', eventClass: 'review' });
  });
});
