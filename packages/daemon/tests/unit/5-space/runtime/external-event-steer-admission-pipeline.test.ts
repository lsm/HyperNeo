import { describe, expect, it } from 'bun:test';
import type { ExternalEventEssenceEntry } from '../../../../src/lib/external-events/deferred-event-digest';
import {
  decideExternalEventSteerAdmission,
  enrichDirectEssences,
  finalizeSteerAdmission,
  gateBufferCapacity,
  gateDeliveryV2Enabled,
  gateSessionAdmissible,
  gateSystemProvenance,
  partitionDirectSteer,
  type ExternalEventSteerAdmissionCtx,
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

function ctx(
  overrides: Partial<ExternalEventSteerAdmissionInput> = {}
): ExternalEventSteerAdmissionCtx {
  return { ...input(overrides), decision: null } as ExternalEventSteerAdmissionCtx;
}

describe('direct-steer admission pipeline', () => {
  it('admits a hydrated direct-class event from a processing session', () => {
    const outcome = decideExternalEventSteerAdmission(input());
    expect(outcome.decision).toMatchObject({
      action: 'admit',
      eventClass: 'review',
      essences: [REVIEW_ESSENCE],
      steerEssences: [REVIEW_ESSENCE],
      passengerEssences: [],
      classes: ['review'],
    });
  });

  it('carries the fold omission count into the admission', () => {
    const outcome = decideExternalEventSteerAdmission(input({ droppedEventCount: 4 }));
    expect(outcome.decision).toMatchObject({
      action: 'admit',
      droppedEventCount: 4,
    });
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
    expect(outcome.decision).toMatchObject({
      action: 'admit',
      eventClass: 'check',
      steerEssences: [CHECK_ESSENCE],
      passengerEssences: passengers,
      classes: ['check'],
    });
  });

  it('admits at exactly the capacity boundary', () => {
    const outcome = decideExternalEventSteerAdmission(input({ bufferedDirectEventCount: 199 }));
    expect(outcome.decision).toMatchObject({ action: 'admit' });
  });

  it('picks the first represented class for a mixed fold', () => {
    const outcome = decideExternalEventSteerAdmission(
      input({ essences: [CHECK_ESSENCE, REVIEW_ESSENCE, DIGEST_ESSENCE] })
    );
    expect(outcome.decision).toMatchObject({
      action: 'admit',
      eventClass: 'check',
      steerEssences: [CHECK_ESSENCE, REVIEW_ESSENCE],
      passengerEssences: [DIGEST_ESSENCE],
      classes: ['check', 'review'],
    });
  });

  it('partitions a mixed fold into steer and passenger essences', () => {
    const essences = [CHECK_ESSENCE, REVIEW_ESSENCE, DIGEST_ESSENCE];
    const afterEnrich = enrichDirectEssences(ctx({ essences }));
    const afterPartition = partitionDirectSteer(afterEnrich);
    expect(afterPartition.steerEssences).toEqual([CHECK_ESSENCE, REVIEW_ESSENCE]);
    expect(afterPartition.passengerEssences).toEqual([DIGEST_ESSENCE]);
    expect(afterPartition.classes).toEqual(['check', 'review']);
    expect(afterPartition.eventClass).toBe('check');
  });
});

describe('direct-steer admission stage order', () => {
  it('the final gate is reachable only when every earlier gate passes', () => {
    const afterAll = finalizeSteerAdmission(
      gateBufferCapacity(
        partitionDirectSteer(
          enrichDirectEssences(
            gateSessionAdmissible(gateSystemProvenance(gateDeliveryV2Enabled(ctx())))
          )
        )
      )
    );
    expect(afterAll.decision).toMatchObject({ action: 'admit', eventClass: 'review' });
  });
});
