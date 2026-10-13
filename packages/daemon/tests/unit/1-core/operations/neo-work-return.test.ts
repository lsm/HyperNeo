import { describe, expect, test } from 'bun:test';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoService } from '../../../../src/lib/neo/service.ts';
import { returnWorkThroughHolder } from '../../../../src/lib/neo/work-return.ts';

describe('returnWorkThroughHolder', () => {
  const work = {
    id: 'w1',
    projectId: 'c1',
    originSessionId: 'neo:root',
    originMessageId: 'ask-1',
    status: 'reported',
    sessionId: 'card-session',
    title: 'Fix it',
    report: 'Fixed it again.',
  } as NeoWork;

  function holder(continued: number | null) {
    const consultations = new Map<string, { id: string }>([
      ['neo-work:w1:review', { id: 'neo-work:w1:review' }],
    ]);
    const synced: string[] = [];
    const service = {
      driverTargets: { readRetries: () => 0 },
      workContinues: { get: () => (continued === null ? null : { count: continued }) },
      consultations: {
        get: (id: string) => consultations.get(id) ?? null,
        reserve: (item: { id: string }) => {
          consultations.set(item.id, item);
          return item;
        },
      },
      db: {
        getSDKMessageRepo: () => ({ findMessageIdByUuid: () => 'first-return' }),
        getJobQueueRepo: () => ({ listActiveByPayload: () => [] }),
      },
      open: async () => 'holder-session',
      syncConsultation: async (id: string) => {
        synced.push(id);
      },
    } as unknown as NeoService;
    return { service, synced };
  }

  test("routes a continued card's next report to its holder as a new review", async () => {
    const { service, synced } = holder(1);
    expect(await returnWorkThroughHolder(service, work, 'neo:root')).toBe('routed');
    expect(synced).toEqual(['neo-work:w1:review:continued:1']);
  });

  test('a report it already routed for this continue is not routed again', async () => {
    const { service, synced } = holder(null);
    expect(await returnWorkThroughHolder(service, work, 'neo:root')).toEqual('already-routed');
    expect(synced).toEqual([]);
  });
});
