import { describe, expect, test } from 'bun:test';
import { NEO_PACK_LIFE_ADMIN_INSTRUCTIONS } from '@hyperneo/prompts';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoAsk, NeoAskItem } from '@hyperneo/shared/types/neo-snapshot';
import type { NeoEvidence } from '../../../../src/lib/neo/evidence.ts';
import {
  LIFE_ADMIN_CHECK_CONFIRMED,
  createLifeAdminPack,
  lifeAdminConfirmedCheck,
  lifeAdminEvidence,
  lifeAdminReportEvidence,
  parseLifeAdminConfirmations,
} from '../../../../src/lib/neo/packs/life-admin/pack.ts';
import {
  NEO_BUILTIN_PACK_BRIEFS,
  NEO_DEFAULT_PACKS,
  neoPackBriefs,
  neoPackChecks,
  neoPackAskCardEvidence,
  neoPackTickWrite,
  planNeoPackTicks,
} from '../../../../src/lib/neo/packs/index.ts';
import { buildNeoCheckRegistry } from '../../../../src/lib/neo/packs/check-registry.ts';
import type { NeoPack } from '../../../../src/lib/neo/packs/types.ts';

const item = (overrides: Partial<NeoAskItem> = {}): NeoAskItem => ({
  id: 'i1',
  text: 'Order confirmation from Amazon arrives',
  state: 'pending',
  evidence: null,
  check: LIFE_ADMIN_CHECK_CONFIRMED as NeoAskItem['check'],
  metBy: null,
  removed: false,
  addedAt: null,
  ...overrides,
});

describe('life-admin brief', () => {
  test('is a built-in that stays disabled unless the settings name it', () => {
    expect(NEO_BUILTIN_PACK_BRIEFS.map((brief) => brief.id)).toEqual(['coding', 'life-admin']);
    expect(neoPackBriefs(NEO_DEFAULT_PACKS).map((brief) => brief.id)).toEqual(['coding']);
    expect(neoPackBriefs(['coding', 'life-admin']).map((brief) => brief.id)).toEqual([
      'coding',
      'life-admin',
    ]);
  });

  test('the pack carries its instructions', () => {
    const pack = createLifeAdminPack();
    expect(pack.instructions(null)).toBe(NEO_PACK_LIFE_ADMIN_INSTRUCTIONS);
    expect(NEO_PACK_LIFE_ADMIN_INSTRUCTIONS).toContain("confirmation is in the human's inbox");
    expect(NEO_PACK_LIFE_ADMIN_INSTRUCTIONS).toContain('Confirmation: id=');
    expect(NEO_PACK_LIFE_ADMIN_INSTRUCTIONS).toContain('date=<ISO 8601 with UTC offset>');
  });
});

describe('parseLifeAdminConfirmations', () => {
  test('reads the confirmation lines a report quotes', () => {
    expect(
      parseLifeAdminConfirmations(
        'Reordered the filters.\nConfirmation: id=<msg-1>; from=orders@example.com; date=2026-10-12T09:30:00Z; subject=Your order is confirmed\nDone.'
      )
    ).toEqual([
      {
        key: 'confirmation:<msg-1>',
        from: 'orders@example.com',
        date: '2026-10-12T09:30:00Z',
        subject: 'Your order is confirmed',
        at: Date.parse('2026-10-12T09:30:00Z'),
      },
    ]);
  });

  test('a calendar confirmation keys on its event id and undated lines stay undated', () => {
    expect(parseLifeAdminConfirmations('Confirmation: event=cal-9; from=calendar')[0]).toEqual({
      key: 'confirmation:event:cal-9',
      from: 'calendar',
      date: null,
      subject: null,
      at: null,
    });
  });

  test('reads the line wrapped in the code span backticks the instructions show', () => {
    const parsed = parseLifeAdminConfirmations(
      '`Confirmation: id=<span>; from=orders@amazon.com`\n' +
        '- `Confirmation: id=<bullet-span>; from=orders@amazon.com`'
    );
    expect(parsed.map(({ key }) => key)).toEqual([
      'confirmation:<span>',
      'confirmation:<bullet-span>',
    ]);
  });

  test('reads the line inside a bullet or indentation', () => {
    const parsed = parseLifeAdminConfirmations(
      '- Confirmation: id=<bullet>; from=orders@amazon.com\n' +
        '  \tConfirmation: id=<indented>; from=orders@amazon.com'
    );
    expect(parsed.map(({ key }) => key)).toEqual([
      'confirmation:<bullet>',
      'confirmation:<indented>',
    ]);
  });

  test('date-only and zoneless dates count as undated, an offset decides', () => {
    const parsed = parseLifeAdminConfirmations(
      'Confirmation: id=<day>; date=2026-10-12\n' +
        'Confirmation: id=<zoneless>; date=2026-10-12T09:30:00\n' +
        'Confirmation: id=<offset>; date=2026-10-12T11:30:00+02:00'
    );
    expect(parsed.map(({ key, at }) => [key, at])).toEqual([
      ['confirmation:<day>', null],
      ['confirmation:<zoneless>', null],
      ['confirmation:<offset>', Date.parse('2026-10-12T11:30:00+02:00')],
    ]);
  });

  test.each<[string, string]>([
    ['no id or event', 'Confirmation: from=orders@example.com'],
    ['no fields at all', 'Confirmation: reordered, waiting'],
    ['not a confirmation line', 'Confirmed: the order went through'],
  ])('ignores %s', (_label, line) => {
    expect(parseLifeAdminConfirmations(line)).toEqual([]);
  });
});

describe('lifeAdminEvidence', () => {
  const confirmation = parseLifeAdminConfirmations(
    'Confirmation: id=<msg-1>; from=orders@example.com; date=2026-10-12T09:30:00Z; subject=Order'
  );

  test('keeps a confirmation the card started on or after, and undated ones', () => {
    const started = Date.parse('2026-10-12T00:00:00Z');
    expect(lifeAdminEvidence(confirmation, started)).toEqual([
      {
        key: 'confirmation:<msg-1>',
        state: 'done',
        summary: 'orders@example.com — Order — 2026-10-12T09:30:00Z',
        blockers: [],
      },
    ]);
    const stale = parseLifeAdminConfirmations('Confirmation: id=<old>; date=2026-10-10T00:00:00Z');
    expect(lifeAdminEvidence(stale, started)).toEqual([]);
    const dateOnly = parseLifeAdminConfirmations('Confirmation: id=<msg-2>; date=2026-10-12');
    expect(lifeAdminEvidence(dateOnly, started).map((evidence) => evidence.key)).toEqual([
      'confirmation:<msg-2>',
    ]);
    const undated = parseLifeAdminConfirmations(
      'Confirmation: id=<msg-3>; from=orders@example.com'
    );
    expect(lifeAdminEvidence(undated, started).map((evidence) => evidence.key)).toEqual([
      'confirmation:<msg-3>',
    ]);
  });
});

describe('life-admin readEvidence', () => {
  const work = (report: string | null, createdAt = 0) => ({ report, createdAt }) as NeoWork;

  test('reportEvidence projects the same confirmations without bookkeeping', () => {
    expect(
      lifeAdminReportEvidence(work('Confirmation: id=<msg-1>; from=orders@example.com', 10))
    ).toEqual([
      { key: 'confirmation:<msg-1>', state: 'done', summary: 'orders@example.com', blockers: [] },
    ]);
    expect(lifeAdminReportEvidence(work(null))).toEqual([]);
  });

  test('reads the confirmations a report quotes', async () => {
    const pack = createLifeAdminPack();
    const read = await pack.readEvidence?.(
      work('Confirmation: id=<msg-1>; from=orders@example.com; subject=Order', 10)
    );
    expect(read).toMatchObject({
      evidence: [
        { key: 'confirmation:<msg-1>', state: 'done', summary: 'orders@example.com — Order' },
      ],
      read: { ok: true },
    });
  });

  test('a report without confirmations reads nothing', async () => {
    const pack = createLifeAdminPack();
    expect(await pack.readEvidence?.(work('Reordered, waiting for the email.'))).toBeNull();
    expect(await pack.readEvidence?.(work(null))).toBeNull();
  });
});

describe('planNeoPackTicks', () => {
  test('ticks an ask item whose text names the confirmation sender', () => {
    const ask = {
      id: 'a1',
      status: 'open',
      doneItems: [item(), item({ id: 'i2', text: 'Dentist reschedule confirmed by email' })],
    } as NeoAsk;
    expect(
      planNeoPackTicks(
        ask,
        neoPackAskCardEvidence([createLifeAdminPack()], ask, [
          {
            report:
              'Confirmation: id=<msg-1>; from=orders@amazon.com; subject=Your order is confirmed',
            createdAt: 0,
          } as NeoWork,
        ]),
        neoPackChecks([createLifeAdminPack()])
      )
    ).toEqual([{ id: 'i1', evidence: 'Confirmed: orders@amazon.com — Your order is confirmed' }]);
  });
});

describe('neoPackTickWrite', () => {
  const signed = {
    id: 'legal',
    describe: 'Legal',
    guidance: '',
    instructions: () => '',
    checks: { 'legal.signed': () => ({ reason: 'not_signed' }) },
    checkEvidence: { 'legal.signed': { independent: true } },
  } as unknown as NeoPack;
  const registry = buildNeoCheckRegistry([createLifeAdminPack(), signed]);
  const entry = (kind: string) => {
    if (!registry.ok) throw new Error(registry.reason);
    const resolved = registry.resolve(kind);
    if (!resolved.ok) throw new Error(resolved.reason);
    return resolved.value;
  };

  test('a worker-reported confirmation is reported for the human, never met by the daemon', () => {
    expect(neoPackTickWrite(item(), entry(LIFE_ADMIN_CHECK_CONFIRMED), 'Confirmed: x')).toEqual({
      id: 'i1',
      state: 'reported',
      evidence: 'Confirmed: x',
      metBy: null,
    });
    expect(
      neoPackTickWrite(
        item({ state: 'reported', evidence: 'Confirmed: x' }),
        entry(LIFE_ADMIN_CHECK_CONFIRMED),
        'Confirmed: x'
      )
    ).toBeNull();
  });

  test('an independent check, or a watch with no check, is met by the daemon', () => {
    expect(neoPackTickWrite(item(), entry('legal.signed'), 'Signed')).toMatchObject({
      state: 'met',
      metBy: 'daemon',
    });
    expect(neoPackTickWrite(item({ check: null }), null, 'Closed #2')).toMatchObject({
      state: 'met',
      metBy: 'daemon',
    });
  });
});

describe('neoPackAskCardEvidence', () => {
  test('a pack without report evidence contributes none', () => {
    const plain = { id: 'plain', describe: 'plain', instructions: () => null };
    expect(
      neoPackAskCardEvidence([plain], { pack: null } as NeoAsk, [
        { report: 'Confirmation: id=<x>', createdAt: 0 } as NeoWork,
      ])
    ).toEqual([]);
  });
});

describe('lifeAdminConfirmedCheck', () => {
  const confirmed = (summary: string): NeoEvidence => ({
    key: `confirmation:<${summary}>`,
    state: 'done',
    summary,
    blockers: [],
  });
  const amazon = confirmed('orders@amazon.com — Your order is confirmed');
  const dentist = confirmed('no-reply@example-dentist.com — Dentist appointment moved');
  const pr: NeoEvidence = {
    key: 'https://github.com/lsm/HyperNeo/pull/1',
    state: 'done',
    summary: 'merged',
    blockers: [],
  };

  test.each<[string, string, NeoEvidence[], { value: string } | { reason: string }]>([
    [
      'a confirmation whose sender the item names',
      'Order confirmation from Amazon arrives',
      [amazon],
      { value: 'Confirmed: orders@amazon.com — Your order is confirmed' },
    ],
    [
      'a confirmation whose subject the item names',
      'Dentist reschedule confirmed by email',
      [dentist],
      { value: 'Confirmed: no-reply@example-dentist.com — Dentist appointment moved' },
    ],
    [
      'a confirmation for another proof',
      'Dentist reschedule confirmed by email',
      [amazon],
      { reason: 'not_confirmed' },
    ],
    [
      'only other evidence',
      'Order confirmation from Amazon arrives',
      [pr],
      { reason: 'not_confirmed' },
    ],
    ['no evidence', 'Order confirmation from Amazon arrives', [], { reason: 'not_confirmed' }],
  ])('%s', (_label, text, evidence, gate) => {
    expect(lifeAdminConfirmedCheck(item({ text }), evidence)).toEqual(gate);
  });
});
