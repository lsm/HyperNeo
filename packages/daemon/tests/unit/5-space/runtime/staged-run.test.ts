import { describe, expect, test } from 'bun:test';
import {
  DEFERRED_DURABLE_COMPENSATION_ARMS,
  StagedRunContractError,
  type StagedRunLogEvent,
  type StagedRunOutcome,
  stagedRun,
} from '../../../../src/lib/space/runtime/staged-run';

type Box = { value: number };
type Word = { status: string };

function eventsOf(log: StagedRunLogEvent[], event: StagedRunLogEvent['event']) {
  return log.filter((entry) => entry.event === event);
}

describe('stagedRun composition contract', () => {
  test('refuses a read of a key an earlier effect wrote without an intervening re-gather', () => {
    expect(() =>
      stagedRun<Box>('stale-read', (s) => [
        s.snapshot({ name: 'load', provides: ['value'], run: () => ({ value: 1 }) }),
        s.effect({ name: 'mutate', writes: ['value'], run: () => {} }),
        s.halt({ name: 'end', reads: ['value'], run: ({ value }) => value }),
      ])
    ).toThrow(StagedRunContractError);
    expect(() =>
      stagedRun<Box>('stale-read', (s) => [
        s.snapshot({ name: 'load', provides: ['value'], run: () => ({ value: 1 }) }),
        s.effect({ name: 'mutate', writes: ['value'], run: () => {} }),
        s.halt({ name: 'end', reads: ['value'], run: ({ value }) => value }),
      ])
    ).toThrow(/reads "value" after an effect wrote it/);
  });

  test('accepts the read once a resnapshot re-gathers the written key', () => {
    const flow = stagedRun<Box>('regather', (s) => [
      s.snapshot({ name: 'load', provides: ['value'], run: () => ({ value: 1 }) }),
      s.effect({ name: 'mutate', writes: ['value'], run: () => {} }),
      s.resnapshot({ name: 'reload', provides: ['value'], run: () => ({ value: 2 }) }),
      s.halt({ name: 'end', reads: ['value'], run: ({ value }) => value }),
    ]);
    expect(flow({})).resolves.toEqual({ status: 'completed', result: 2 });
  });

  test('a plain snapshot after the effect also clears the stale key', () => {
    const flow = stagedRun<Box>('regather-snapshot', (s) => [
      s.snapshot({ name: 'load', provides: ['value'], run: () => ({ value: 1 }) }),
      s.effect({ name: 'mutate', writes: ['value'], run: () => {} }),
      s.snapshot({ name: 'reload', provides: ['value'], run: () => ({ value: 3 }) }),
      s.halt({ name: 'end', reads: ['value'], run: ({ value }) => value }),
    ]);
    expect(flow({})).resolves.toEqual({ status: 'completed', result: 3 });
  });

  test('refuses a read of a key nothing provides', () => {
    type Pair = { a: number; b: number };
    expect(() =>
      stagedRun<Pair>('unprovided', (s) => [
        s.snapshot({ name: 'load', provides: ['a'], run: () => ({ a: 1 }) }),
        s.halt({ name: 'end', reads: ['b'], run: () => 'x' }),
      ])
    ).toThrow(/no input or earlier stage provides/);
  });

  test('refuses an effect that writes a key no stage provides', () => {
    expect(() =>
      stagedRun<Box>('write-blind', (s) => [
        s.snapshot({ name: 'load', provides: ['value'], run: () => ({ value: 1 }) }),
        s.effect({
          name: 'mutate',
          writes: ['other' as unknown as keyof Box],
          run: () => {},
        }),
      ])
    ).toThrow(StagedRunContractError);
  });

  test('refuses a when guard no earlier decide stage branches on', () => {
    expect(() =>
      stagedRun<Box>('bad-when', (s) => [
        s.snapshot({ name: 'load', provides: ['value'], run: () => ({ value: 1 }) }),
        s.effect({ name: 'fx', writes: ['value'], when: 'neverDeclared', run: () => {} }),
      ])
    ).toThrow(/guards on "neverDeclared"/);
  });

  test('refuses a when guard on a branch only a later decide declares', () => {
    expect(() =>
      stagedRun<Box>('late-branch', (s) => [
        s.snapshot({ name: 'load', provides: ['value'], run: () => ({ value: 1 }) }),
        s.effect({
          name: 'fx',
          writes: ['value'],
          when: 'laterBranch',
          run: () => {},
        }),
        s.decide({
          name: 'late-decide',
          reads: ['value'],
          branches: ['laterBranch'],
          run: ({ value }) => ({ decision: value, laterBranch: 1 }),
        }),
        s.halt({ name: 'end', run: () => 'done' }),
      ])
    ).toThrow(/no earlier decide stage branches on/);
  });

  test('refuses reading decision before any decide stage', () => {
    expect(() =>
      stagedRun<Box>('early-decision', (s) => [
        s.snapshot({ name: 'load', provides: ['value'], run: () => ({ value: 1 }) }),
        s.halt({ name: 'end', reads: ['decision'], run: () => 'x' }),
      ])
    ).toThrow(/reads "decision" before any decide stage/);
  });

  test('refuses reserved or ill-formed state keys', () => {
    expect(() =>
      stagedRun<Record<string, unknown>>('reserved-key', (s) => [
        s.snapshot({
          name: 'load',
          provides: ['decision' as string],
          run: () => ({ decision: 1 }) as Record<string, unknown>,
        }),
      ])
    ).toThrow(StagedRunContractError);
    expect(() =>
      stagedRun<Record<string, unknown>>('dollar-key', (s) => [
        s.snapshot({
          name: 'load',
          provides: ['$outcome' as string],
          run: () => ({ $outcome: 1 }) as Record<string, unknown>,
        }),
      ])
    ).toThrow(StagedRunContractError);
    expect(() => {
      const gathered: Record<string, unknown> = {};
      // biome-ignore lint/suspicious/noThenProperty: reserved-key pin builds a thenable record on purpose
      gathered.then = () => {};
      return stagedRun<Record<string, unknown>>('then-key', (s) => [
        s.snapshot({
          name: 'load',
          provides: ['then' as string],
          run: () => gathered,
        }),
      ]);
    }).toThrow(StagedRunContractError);
  });

  test('refuses a branch key redeclared by a later decide', () => {
    expect(() =>
      stagedRun<Box>('branch-redeclare', (s) => [
        s.snapshot({ name: 'load', provides: ['value'], run: () => ({ value: 1 }) }),
        s.decide({
          name: 'first',
          reads: ['value'],
          branches: ['act', 'skip'],
          run: ({ value }) => ({ decision: value, act: 1 }),
        }),
        s.decide({
          name: 'second',
          reads: ['decision'],
          branches: ['act', 'other'],
          run: (view) => ({ decision: view.decision, other: 2 }),
        }),
        s.halt({ name: 'end', run: () => 'done' }),
      ])
    ).toThrow(/redeclares branch "act"/);
  });

  test('refuses duplicate keys in a snapshot provides list', () => {
    type Loose = Record<string, unknown>;
    expect(() =>
      stagedRun<Loose>('dupe-provides', (s) => [
        s.snapshot({
          name: 'load',
          provides: ['a' as string, 'a' as string],
          run: () => ({ a: 1 }),
        }),
        s.halt({ name: 'end', run: () => 'done' }),
      ])
    ).toThrow(/provides a duplicate key/);
  });

  test('refuses a branch key that collides with a state key', () => {
    type Branchy = { value: number; act: boolean };
    expect(() =>
      stagedRun<Branchy>('branch-collision', (s) => [
        s.snapshot({
          name: 'load',
          provides: ['value', 'act'],
          run: () => ({ value: 1, act: true }),
        }),
        s.decide({
          name: 'route',
          reads: ['value'],
          branches: ['act'],
          run: ({ value }) => ({ decision: value, act: true }),
        }),
      ])
    ).toThrow(/collides with a state key/);
  });

  test('refuses a branch key that collides with a later state provider', () => {
    type Pair = { value: number; extra: number };
    expect(() =>
      stagedRun<Pair>('late-collision', (s) => [
        s.snapshot({ name: 'load', provides: ['value'], run: () => ({ value: 1 }) }),
        s.decide({
          name: 'route',
          reads: ['value'],
          branches: ['extra'],
          run: ({ value }) => ({ decision: value, extra: 1 }),
        }),
        s.resnapshot({ name: 'late-load', provides: ['extra'], run: () => ({ extra: 2 }) }),
        s.halt({ name: 'end', run: () => 'done' }),
      ])
    ).toThrow(/collides with a state key/);
  });

  test('refuses stages after an unconditional halt', () => {
    expect(() =>
      stagedRun<Box>('dead-stage', (s) => [
        s.snapshot({ name: 'load', provides: ['value'], run: () => ({ value: 1 }) }),
        s.halt({ name: 'stop', run: () => 'done' }),
        s.halt({ name: 'never', run: () => 'unreachable' }),
      ])
    ).toThrow(/follows the unconditional halt/);
  });

  test('refuses an empty stage list and duplicate stage names', () => {
    expect(() => stagedRun<Box>('empty', () => [])).toThrow(StagedRunContractError);
    expect(() =>
      stagedRun<Box>('dupe', (s) => [
        s.snapshot({ name: 'load', provides: ['value'], run: () => ({ value: 1 }) }),
        s.snapshot({ name: 'load', provides: ['value'], run: () => ({ value: 2 }) }),
      ])
    ).toThrow(/duplicated/);
  });

  test('refuses a snapshot that provides no keys', () => {
    expect(() =>
      stagedRun<Box>('no-provides', (s) => [
        s.snapshot({ name: 'load', provides: [], run: () => ({}) }),
        s.halt({ name: 'end', run: () => 'done' }),
      ])
    ).toThrow(/provides no keys/);
  });

  test('two sequential writes to the same key stay expressible', () => {
    const flow = stagedRun<Box>('double-write', (s) => [
      s.snapshot({ name: 'load', provides: ['value'], run: () => ({ value: 1 }) }),
      s.effect({ name: 'w1', writes: ['value'], run: () => {} }),
      s.effect({ name: 'w2', writes: ['value'], run: () => {} }),
      s.halt({ name: 'end', run: () => 'done' }),
    ]);
    expect(flow({})).resolves.toEqual({ status: 'completed', result: 'done' });
  });

  test('a when-guarded re-gather does not clear a dirty key', () => {
    expect(() =>
      stagedRun<Box>('guarded-regather', (s) => [
        s.snapshot({ name: 'load', provides: ['value'], run: () => ({ value: 1 }) }),
        s.decide({
          name: 'route',
          reads: ['value'],
          branches: ['regather'],
          run: ({ value }) => ({ decision: value, regather: { live: true } }),
        }),
        s.effect({ name: 'mutate', writes: ['value'], run: () => {} }),
        s.resnapshot({
          name: 'reload',
          when: 'regather',
          provides: ['value'],
          run: () => ({ value: 2 }),
        }),
        s.halt({ name: 'end', reads: ['value'], run: ({ value }) => value }),
      ])
    ).toThrow(/reads "value" after an effect wrote it/);
  });

  test('an unconditional re-gather after a guarded one clears the dirty key', () => {
    const flow = stagedRun<Box>('guarded-then-unconditional', (s) => [
      s.snapshot({ name: 'load', provides: ['value'], run: () => ({ value: 1 }) }),
      s.decide({
        name: 'route',
        reads: ['value'],
        branches: ['regather'],
        run: ({ value }) => ({ decision: value, regather: { live: true } }),
      }),
      s.effect({ name: 'mutate', writes: ['value'], run: () => {} }),
      s.resnapshot({
        name: 'reload',
        when: 'regather',
        provides: ['value'],
        run: () => ({ value: 2 }),
      }),
      s.resnapshot({ name: 'reload-final', provides: ['value'], run: () => ({ value: 3 }) }),
      s.halt({ name: 'end', reads: ['value'], run: ({ value }) => value }),
    ]);
    expect(flow({})).resolves.toEqual({ status: 'completed', result: 3 });
  });

  test('a guarded re-gather re-enables reads for stages sharing its guard', async () => {
    const flow = stagedRun<Box>('same-guard-regather', (s) => [
      s.snapshot({ name: 'load', provides: ['value'], run: () => ({ value: 1 }) }),
      s.decide({
        name: 'route',
        reads: ['value'],
        branches: ['regather'],
        run: ({ value }) => ({ decision: value, regather: { live: true } }),
      }),
      s.effect({ name: 'mutate', writes: ['value'], run: () => {} }),
      s.resnapshot({
        name: 'reload',
        when: 'regather',
        provides: ['value'],
        run: () => ({ value: 2 }),
      }),
      s.halt({
        name: 'end',
        when: 'regather',
        reads: ['value'],
        run: ({ value }) => value,
      }),
    ]);
    await expect(flow({})).resolves.toEqual({ status: 'completed', result: 2 });
  });

  test('a when-guarded gather may introduce a key for reads under the same guard', async () => {
    type Pair = { value: number; extra: number };
    const flow = stagedRun<Pair>('guarded-provide', (s) => [
      s.snapshot({ name: 'load', provides: ['value'], run: () => ({ value: 1 }) }),
      s.decide({
        name: 'route',
        reads: ['value'],
        branches: ['loadExtra'],
        run: ({ value }) => ({ decision: value, loadExtra: { want: true } }),
      }),
      s.resnapshot({
        name: 'extra',
        when: 'loadExtra',
        provides: ['extra'],
        run: () => ({ extra: 9 }),
      }),
      s.halt({ name: 'end', when: 'loadExtra', reads: ['extra'], run: ({ extra }) => extra }),
    ]);
    await expect(flow({})).resolves.toEqual({ status: 'completed', result: 9 });
  });

  test('refuses an unguarded read of a key only a guarded gather provides', () => {
    type Pair = { value: number; extra: number };
    expect(() =>
      stagedRun<Pair>('guarded-read', (s) => [
        s.snapshot({ name: 'load', provides: ['value'], run: () => ({ value: 1 }) }),
        s.decide({
          name: 'route',
          reads: ['value'],
          branches: ['loadExtra'],
          run: ({ value }) => ({ decision: value, loadExtra: { want: true } }),
        }),
        s.resnapshot({
          name: 'extra',
          when: 'loadExtra',
          provides: ['extra'],
          run: () => ({ extra: 5 }),
        }),
        s.halt({ name: 'end', reads: ['extra'], run: ({ extra }) => extra }),
      ])
    ).toThrow(/only provided under guard/);
  });

  test('refuses a read of a guarded-provided key under a different guard', () => {
    type Pair = { value: number; extra: number };
    expect(() =>
      stagedRun<Pair>('wrong-guard-read', (s) => [
        s.snapshot({ name: 'load', provides: ['value'], run: () => ({ value: 1 }) }),
        s.decide({
          name: 'route',
          reads: ['value'],
          branches: ['loadExtra', 'otherPath'],
          run: ({ value }) => ({ decision: value, loadExtra: { want: true } }),
        }),
        s.resnapshot({
          name: 'extra',
          when: 'loadExtra',
          provides: ['extra'],
          run: () => ({ extra: 5 }),
        }),
        s.halt({
          name: 'end',
          when: 'otherPath',
          reads: ['extra'],
          run: ({ extra }) => extra,
        }),
      ])
    ).toThrow(/only provided under guard/);
  });

  test('an unconditional re-gather makes a guarded-provided key unconditionally readable', async () => {
    type Pair = { value: number; extra: number };
    const flow = stagedRun<Pair>('guarded-then-open', (s) => [
      s.snapshot({ name: 'load', provides: ['value'], run: () => ({ value: 1 }) }),
      s.decide({
        name: 'route',
        reads: ['value'],
        branches: ['loadExtra'],
        run: ({ value }) => ({ decision: value, loadExtra: { want: true } }),
      }),
      s.resnapshot({
        name: 'extra',
        when: 'loadExtra',
        provides: ['extra'],
        run: () => ({ extra: 5 }),
      }),
      s.resnapshot({ name: 'extra-final', provides: ['extra'], run: () => ({ extra: 6 }) }),
      s.halt({ name: 'end', reads: ['extra'], run: ({ extra }) => extra }),
    ]);
    await expect(flow({})).resolves.toEqual({ status: 'completed', result: 6 });
  });

  test('an effect may write a guarded-provided key under the same guard', async () => {
    type Pair = { value: number; extra: number };
    const flow = stagedRun<Pair>('guarded-write', (s) => [
      s.snapshot({ name: 'load', provides: ['value'], run: () => ({ value: 1 }) }),
      s.decide({
        name: 'route',
        reads: ['value'],
        branches: ['loadExtra'],
        run: ({ value }) => ({ decision: value, loadExtra: { want: true } }),
      }),
      s.resnapshot({
        name: 'extra',
        when: 'loadExtra',
        provides: ['extra'],
        run: () => ({ extra: 5 }),
      }),
      s.effect({
        name: 'mutate-extra',
        when: 'loadExtra',
        writes: ['extra'],
        run: () => {},
      }),
      s.resnapshot({
        name: 'reload-extra',
        when: 'loadExtra',
        provides: ['extra'],
        run: () => ({ extra: 7 }),
      }),
      s.halt({
        name: 'end',
        when: 'loadExtra',
        reads: ['extra'],
        run: ({ extra }) => extra,
      }),
    ]);
    await expect(flow({})).resolves.toEqual({ status: 'completed', result: 7 });
  });
});

describe('stagedRun declared-key access', () => {
  test('a stage body sees exactly its declared keys', async () => {
    let seen: Record<string, unknown> = {};
    const flow = stagedRun<Box>('view', (s) => [
      s.snapshot({ name: 'load', provides: ['value'], run: () => ({ value: 7 }) }),
      s.effect({
        name: 'fx',
        reads: ['value'],
        writes: ['value'],
        run: (view) => {
          seen = { ...view };
        },
      }),
      s.halt({ name: 'end', run: () => 'done' }),
    ]);
    await flow({});
    expect(Object.keys(seen).sort()).toEqual(['value']);
    expect(seen.value).toBe(7);
  });

  test('flow input keys reach stages only through declared reads', async () => {
    type WithInput = { sessionId: string; echo: string };
    let received = '';
    const flow = stagedRun<WithInput>(
      'input-keys',
      (s) => [
        s.snapshot({
          name: 'load',
          provides: ['echo'],
          reads: ['sessionId'],
          run: ({ sessionId }) => ({ echo: `echo:${sessionId}` }),
        }),
        s.halt({
          name: 'end',
          reads: ['echo'],
          run: (view) => {
            received = view.echo;
            return view.echo;
          },
        }),
      ],
      { input: ['sessionId'] }
    );
    await expect(flow({ sessionId: 's-1' })).resolves.toEqual({
      status: 'completed',
      result: 'echo:s-1',
    });
    expect(received).toBe('echo:s-1');
  });

  test('a missing flow input key throws before the run starts', async () => {
    type NeedsInput = { sessionId: string; echo: string };
    const flow = stagedRun<NeedsInput>(
      'needs-input',
      (s) => [
        s.snapshot({
          name: 'load',
          provides: ['echo'],
          reads: ['sessionId'],
          run: ({ sessionId }) => ({ echo: sessionId }),
        }),
        s.halt({ name: 'end', reads: ['echo'], run: () => 'done' }),
      ],
      { input: ['sessionId'] }
    );
    expect(() => flow({ sessionId: undefined as unknown as string })).toThrow(
      StagedRunContractError
    );
  });

  test('a prototype-chain value does not satisfy a flow input key', async () => {
    type Odd = { constructor: string; echo: string };
    const flow = stagedRun<Odd>(
      'proto-chain-input',
      (s) => [
        s.snapshot({
          name: 'load',
          provides: ['echo'],
          reads: ['constructor'],
          run: (view) => ({ echo: view.constructor as string }),
        }),
        s.halt({ name: 'end', reads: ['echo'], run: () => 'done' }),
      ],
      { input: ['constructor'] }
    );
    expect(() => flow({})).toThrow(/flow input key "constructor" is missing/);
    await expect(flow({ constructor: 'own-value' } as unknown as Partial<Odd>)).resolves.toEqual({
      status: 'completed',
      result: 'done',
    });
  });
});

describe('stagedRun snapshot contract', () => {
  test('gathering must return exactly the declared provides keys', async () => {
    const missing = stagedRun<Box>('gather-missing', (s) => [
      s.snapshot({ name: 'load', provides: ['value'], run: () => ({}) as Partial<Box> }),
      s.halt({ name: 'end', run: () => 'done' }),
    ]);
    const outcome = await missing({});
    expect(outcome.status).toBe('error');
    expect(outcome.stage).toBe('load');
    expect(outcome.error).toBeInstanceOf(StagedRunContractError);

    const extra = stagedRun<Box>('gather-extra', (s) => [
      s.snapshot({
        name: 'load',
        provides: ['value'],
        run: () => ({ value: 1, rogue: 2 }) as Partial<Box>,
      }),
      s.halt({ name: 'end', run: () => 'done' }),
    ]);
    expect((await extra({})).status).toBe('error');
  });

  test('gathering a declared key as undefined is a contract error, not a silent skip', async () => {
    const flow = stagedRun<Box>('gather-undefined', (s) => [
      s.snapshot({
        name: 'load',
        provides: ['value'],
        run: () => ({ value: undefined }) as Partial<Box>,
      }),
      s.halt({ name: 'end', run: () => 'done' }),
    ]);
    const outcome = await flow({});
    expect(outcome.status).toBe('error');
    expect(String(outcome.error)).toContain('model absence as null');
  });

  test('an async snapshot resolves before later stages run', async () => {
    const flow = stagedRun<Box>('async-gather', (s) => [
      s.snapshot({
        name: 'load',
        provides: ['value'],
        run: () => Promise.resolve({ value: 11 }),
      }),
      s.halt({ name: 'end', reads: ['value'], run: ({ value }) => value }),
    ]);
    await expect(flow({})).resolves.toEqual({ status: 'completed', result: 11 });
  });
});

describe('stagedRun decide contract', () => {
  test('a decide stage stamps its decision and branch payloads', async () => {
    const flow = stagedRun<Box>('decide-stamp', (s) => [
      s.snapshot({ name: 'load', provides: ['value'], run: () => ({ value: 1 }) }),
      s.decide({
        name: 'route',
        reads: ['value'],
        branches: ['takeIt'],
        run: ({ value }) => ({ decision: { kind: 'act', value }, takeIt: { planned: true } }),
      }),
      s.effect({
        name: 'fx',
        when: 'takeIt',
        writes: ['value'],
        run: (view) => {
          expect((view.takeIt as { planned: boolean }).planned).toBe(true);
        },
      }),
      s.halt({
        name: 'end',
        when: 'takeIt',
        run: (view) => ({ acted: (view.takeIt as { planned: boolean }).planned }),
      }),
    ]);
    await expect(flow({})).resolves.toEqual({
      status: 'completed',
      result: { acted: true },
    });
  });

  test('a decide stage may read the stamped decision of an earlier decide', async () => {
    const flow = stagedRun<Box>('decision-chain', (s) => [
      s.snapshot({ name: 'load', provides: ['value'], run: () => ({ value: 5 }) }),
      s.decide({ name: 'first', reads: ['value'], run: ({ value }) => ({ decision: value }) }),
      s.decide({
        name: 'second',
        reads: ['decision'],
        run: (view) => ({ decision: (view.decision as number) + 1 }),
      }),
      s.halt({
        name: 'end',
        reads: ['decision'],
        run: (view) => view.decision,
      }),
    ]);
    await expect(flow({})).resolves.toEqual({ status: 'completed', result: 6 });
  });

  test('an async decide body is a contract violation', async () => {
    const flow = stagedRun<Box>('async-decide', (s) => [
      s.snapshot({ name: 'load', provides: ['value'], run: () => ({ value: 1 }) }),
      s.decide({
        name: 'bad',
        reads: ['value'],
        run: (() => Promise.resolve({ decision: 1 })) as unknown as () => { decision: unknown },
      }),
      s.halt({ name: 'end', run: () => 'done' }),
    ]);
    const outcome = await flow({});
    expect(outcome.status).toBe('error');
    expect(outcome.stage).toBe('bad');
    expect(String(outcome.error)).toContain('synchronous');
  });

  test('a rejected async decide still yields the contract outcome without an unhandled rejection', async () => {
    const flow = stagedRun<Box>('async-decide-rejects', (s) => [
      s.snapshot({ name: 'load', provides: ['value'], run: () => ({ value: 1 }) }),
      s.decide({
        name: 'bad',
        reads: ['value'],
        run: (() => Promise.reject(new Error('late boom'))) as unknown as () => {
          decision: unknown;
        },
      }),
      s.halt({ name: 'end', run: () => 'done' }),
    ]);
    const outcome = await flow({});
    expect(outcome.status).toBe('error');
    expect(outcome.stage).toBe('bad');
    expect(String(outcome.error)).toContain('synchronous');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });

  test('stamping an undeclared branch key is a contract violation', async () => {
    const flow = stagedRun<Box>('rogue-branch', (s) => [
      s.snapshot({ name: 'load', provides: ['value'], run: () => ({ value: 1 }) }),
      s.decide({
        name: 'bad',
        run: (() => ({ decision: 'x', rogue: 1 })) as unknown as () => { decision: unknown },
      }),
      s.halt({ name: 'end', run: () => 'done' }),
    ]);
    const outcome = await flow({});
    expect(outcome.status).toBe('error');
    expect(String(outcome.error)).toContain('without declaring it in branches');
  });

  test('stamping two branch payloads is a contract violation', async () => {
    const flow = stagedRun<Box>('multi-branch', (s) => [
      s.snapshot({ name: 'load', provides: ['value'], run: () => ({ value: 1 }) }),
      s.decide({
        name: 'greedy',
        reads: ['value'],
        branches: ['first', 'second'],
        run: ({ value }) => ({ decision: value, first: 1, second: 2 }),
      }),
      s.effect({ name: 'one', writes: ['value'], when: 'first', run: () => {} }),
      s.effect({ name: 'two', writes: ['value'], when: 'second', run: () => {} }),
      s.halt({ name: 'end', run: () => 'done' }),
    ]);
    const outcome = await flow({});
    expect(outcome.status).toBe('error');
    expect(outcome.stage).toBe('greedy');
    expect(String(outcome.error)).toContain('at most one branch');
  });
});

describe('stagedRun control flow', () => {
  test('a when-guarded stage is skipped unless its branch fired', async () => {
    const ran: string[] = [];
    const flow = stagedRun<Word>('when-skip', (s) => [
      s.snapshot({
        name: 'load',
        provides: ['status'],
        run: () => ({ status: 'closed' }),
      }),
      s.decide({
        name: 'route',
        reads: ['status'],
        branches: ['actNow', 'skipIt'],
        run: ({ status }) =>
          status === 'open'
            ? { decision: 'act', actNow: { run: true } }
            : { decision: 'skip', skipIt: { reason: 'closed' } },
      }),
      s.effect({
        name: 'act',
        when: 'actNow',
        writes: ['status'],
        run: () => {
          ran.push('act');
        },
      }),
      s.halt({
        name: 'exit-skip',
        when: 'skipIt',
        run: (view) => (view.skipIt as { reason: string }).reason,
      }),
      s.halt({ name: 'exit-done', run: () => 'acted' }),
    ]);
    await expect(flow({})).resolves.toEqual({ status: 'completed', result: 'closed' });
    expect(ran).toEqual([]);

    const open = stagedRun<Word>('when-run', (s) => [
      s.snapshot({ name: 'load', provides: ['status'], run: () => ({ status: 'open' }) }),
      s.decide({
        name: 'route',
        reads: ['status'],
        branches: ['actNow', 'skipIt'],
        run: ({ status }) =>
          status === 'open'
            ? { decision: 'act', actNow: { run: true } }
            : { decision: 'skip', skipIt: { reason: 'closed' } },
      }),
      s.effect({
        name: 'act',
        when: 'actNow',
        writes: ['status'],
        run: () => {
          ran.push('act');
        },
      }),
      s.halt({
        name: 'exit-skip',
        when: 'skipIt',
        run: (view) => (view.skipIt as { reason: string }).reason,
      }),
      s.halt({ name: 'exit-done', run: () => 'acted' }),
    ]);
    await expect(open({})).resolves.toEqual({ status: 'completed', result: 'acted' });
    expect(ran).toEqual(['act']);
  });

  test('no stage after a fired halt runs', async () => {
    const ran: string[] = [];
    const flow = stagedRun<Word>('halt-stops', (s) => [
      s.snapshot({ name: 'load', provides: ['status'], run: () => ({ status: 'open' }) }),
      s.decide({
        name: 'route',
        reads: ['status'],
        branches: ['bail'],
        run: ({ status }) => ({ decision: status, bail: { early: true } }),
      }),
      s.halt({
        name: 'early-exit',
        when: 'bail',
        run: (view) => (view.bail as { early: boolean }).early,
      }),
      s.effect({
        name: 'after',
        writes: ['status'],
        run: () => {
          ran.push('after');
        },
      }),
      s.resnapshot({ name: 'reload', provides: ['status'], run: () => ({ status: 'x' }) }),
      s.halt({ name: 'end', run: () => 'late' }),
    ]);
    await expect(flow({})).resolves.toEqual({ status: 'completed', result: true });
    expect(ran).toEqual([]);
  });

  test('a flow that falls off the end completes with an undefined result', async () => {
    const flow = stagedRun<Word>('fall-through', (s) => [
      s.snapshot({ name: 'load', provides: ['status'], run: () => ({ status: 'open' }) }),
      s.decide({
        name: 'route',
        reads: ['status'],
        branches: ['bail', 'act'],
        run: ({ status }) => ({ decision: status, bail: { early: true } }),
      }),
      s.effect({
        name: 'fx',
        when: 'act',
        writes: ['status'],
        run: () => {},
      }),
    ]);
    await expect(flow({})).resolves.toEqual({ status: 'completed', result: undefined });
  });

  test('a halt result carrying a callable then field is delivered as a value', async () => {
    let invoked = false;
    const domain: Record<string, unknown> = { verdict: 'stopped' };
    // biome-ignore lint/suspicious/noThenProperty: then-valued halt result is the pinned hazard
    domain.then = () => {
      invoked = true;
      return undefined;
    };
    const flow = stagedRun<Box>('then-valued-result', (s) => [
      s.snapshot({ name: 'load', provides: ['value'], run: () => ({ value: 1 }) }),
      s.halt({
        name: 'end',
        run: () => domain,
      }),
    ]);
    const outcome = await flow({});
    expect(outcome.status).toBe('completed');
    expect((outcome.result as { verdict: string }).verdict).toBe('stopped');
    expect(invoked).toBe(false);
  });
});

describe('stagedRun CAS outcome routing', () => {
  test('a superseded CAS return ends the flow once, stamped by the interpreter', async () => {
    const ran: string[] = [];
    let attempts = 0;
    const log: StagedRunLogEvent[] = [];
    const flow = stagedRun<Box>(
      'cas-superseded',
      (s) => [
        s.snapshot({ name: 'load', provides: ['value'], run: () => ({ value: 1 }) }),
        s.effect({
          name: 'cas-write',
          reads: ['value'],
          writes: ['value'],
          run: () => {
            attempts += 1;
            return 'superseded';
          },
        }),
        s.resnapshot({ name: 'reload', provides: ['value'], run: () => ({ value: 2 }) }),
        s.halt({
          name: 'never',
          run: () => {
            ran.push('never');
            return 'late';
          },
        }),
      ],
      { log: (event) => log.push(event) }
    );
    const outcome = await flow({});
    expect(outcome.status).toBe('superseded');
    expect(outcome.stage).toBe('cas-write');
    expect(attempts).toBe(1);
    expect(ran).toEqual([]);
    expect(eventsOf(log, 'superseded')).toEqual([
      { event: 'superseded', flow: 'cas-superseded', stage: 'cas-write' },
    ]);
  });

  test('a won CAS return continues the flow', async () => {
    const flow = stagedRun<Box>('cas-won', (s) => [
      s.snapshot({ name: 'load', provides: ['value'], run: () => ({ value: 1 }) }),
      s.effect({ name: 'cas-write', writes: ['value'], run: () => 'won' }),
      s.resnapshot({ name: 'reload', provides: ['value'], run: () => ({ value: 2 }) }),
      s.halt({ name: 'end', reads: ['value'], run: ({ value }) => value }),
    ]);
    await expect(flow({})).resolves.toEqual({ status: 'completed', result: 2 });
  });

  test('a superseded CAS unwind compensates already-committed effects', async () => {
    const order: string[] = [];
    const flow = stagedRun<Box>('cas-unwind', (s) => [
      s.snapshot({ name: 'load', provides: ['value'], run: () => ({ value: 1 }) }),
      s.effect({
        name: 'first',
        writes: ['value'],
        run: () => {
          order.push('first');
        },
        compensate: () => {
          order.push('undo-first');
        },
      }),
      s.effect({
        name: 'second',
        writes: ['value'],
        run: () => {
          order.push('second');
          return 'superseded';
        },
        compensate: () => {
          order.push('undo-second');
        },
      }),
      s.halt({ name: 'end', run: () => 'done' }),
    ]);
    const outcome = await flow({});
    expect(outcome.status).toBe('superseded');
    expect(outcome.unwind).toEqual([
      { stage: 'second', status: 'compensated' },
      { stage: 'first', status: 'compensated' },
    ]);
    expect(order).toEqual(['first', 'second', 'undo-second', 'undo-first']);
  });

  test('an effect return outside the CAS contract is a stage error', async () => {
    const flow = stagedRun<Box>('bad-return', (s) => [
      s.snapshot({ name: 'load', provides: ['value'], run: () => ({ value: 1 }) }),
      s.effect({
        name: 'fx',
        writes: ['value'],
        run: (() => 'nope') as unknown as () => void,
      }),
      s.halt({ name: 'end', run: () => 'done' }),
    ]);
    const outcome = await flow({});
    expect(outcome.status).toBe('error');
    expect(String(outcome.error)).toContain('must return void or a CAS outcome');
  });
});

describe('stagedRun stage failure and compensation', () => {
  test('a failing stage unwinds every started effect in reverse order', async () => {
    const order: string[] = [];
    const log: StagedRunLogEvent[] = [];
    const flow = stagedRun<Box>(
      'unwind-reverse',
      (s) => [
        s.snapshot({ name: 'load', provides: ['value'], run: () => ({ value: 1 }) }),
        s.effect({
          name: 'one',
          writes: ['value'],
          run: () => {
            order.push('one');
          },
          compensate: () => {
            order.push('undo-one');
          },
        }),
        s.effect({
          name: 'two',
          writes: ['value'],
          run: () => {
            order.push('two');
            throw new Error('boom');
          },
          compensate: () => {
            order.push('undo-two');
          },
        }),
        s.halt({ name: 'end', run: () => 'done' }),
      ],
      { log: (event) => log.push(event) }
    );
    const outcome = await flow({});
    expect(outcome.status).toBe('error');
    expect(outcome.stage).toBe('two');
    expect((outcome.error as Error).message).toBe('boom');
    expect(order).toEqual(['one', 'two', 'undo-two', 'undo-one']);
    expect(outcome.unwind).toEqual([
      { stage: 'two', status: 'compensated' },
      { stage: 'one', status: 'compensated' },
    ]);
    expect(eventsOf(log, 'stage-error')).toHaveLength(1);
  });

  test('the failing stage owns compensation is registered at start, covering partial work', async () => {
    const order: string[] = [];
    const flow = stagedRun<Box>('partial-compensate', (s) => [
      s.snapshot({ name: 'load', provides: ['value'], run: () => ({ value: 1 }) }),
      s.effect({
        name: 'partial',
        writes: ['value'],
        run: () => {
          order.push('partial-start');
          throw new Error('mid-flight');
        },
        compensate: () => {
          order.push('undo-partial');
        },
      }),
      s.halt({ name: 'end', run: () => 'done' }),
    ]);
    const outcome = await flow({});
    expect(outcome.status).toBe('error');
    expect(order).toEqual(['partial-start', 'undo-partial']);
  });

  test('a failing compensation is recorded while unwinding continues', async () => {
    const order: string[] = [];
    const log: StagedRunLogEvent[] = [];
    const failure = new Error('undo-exploded');
    const flow = stagedRun<Box>(
      'compensation-failure',
      (s) => [
        s.snapshot({ name: 'load', provides: ['value'], run: () => ({ value: 1 }) }),
        s.effect({
          name: 'one',
          writes: ['value'],
          run: () => {},
          compensate: () => {
            order.push('undo-one');
          },
        }),
        s.effect({
          name: 'two',
          writes: ['value'],
          run: () => {},
          compensate: () => {
            order.push('undo-two');
            throw failure;
          },
        }),
        s.effect({
          name: 'three',
          writes: ['value'],
          run: () => {
            throw new Error('trigger');
          },
        }),
        s.halt({ name: 'end', run: () => 'done' }),
      ],
      { log: (event) => log.push(event) }
    );
    const outcome = await flow({});
    expect(outcome.status).toBe('error');
    expect(outcome.stage).toBe('three');
    expect(order).toEqual(['undo-two', 'undo-one']);
    expect(outcome.unwind).toEqual([
      { stage: 'two', status: 'failed', error: failure },
      { stage: 'one', status: 'compensated' },
    ]);
    expect(eventsOf(log, 'compensation-failed')).toEqual([
      { event: 'compensation-failed', flow: 'compensation-failure', stage: 'two', error: failure },
    ]);
  });

  test('a successful flow never runs compensations', async () => {
    const order: string[] = [];
    const flow = stagedRun<Box>('no-compensation', (s) => [
      s.snapshot({ name: 'load', provides: ['value'], run: () => ({ value: 1 }) }),
      s.effect({
        name: 'one',
        writes: ['value'],
        run: () => {
          order.push('one');
        },
        compensate: () => {
          order.push('undo-one');
        },
      }),
      s.halt({ name: 'end', run: () => 'done' }),
    ]);
    await expect(flow({})).resolves.toEqual({ status: 'completed', result: 'done' });
    expect(order).toEqual(['one']);
  });

  test('a failing async effect stage still unwinds', async () => {
    const order: string[] = [];
    const flow = stagedRun<Box>('async-failure', (s) => [
      s.snapshot({ name: 'load', provides: ['value'], run: () => ({ value: 1 }) }),
      s.effect({
        name: 'async-fx',
        writes: ['value'],
        run: async () => {
          order.push('async-fx');
          throw new Error('async-boom');
        },
        compensate: () => {
          order.push('undo-async-fx');
        },
      }),
      s.halt({ name: 'end', run: () => 'done' }),
    ]);
    const outcome = await flow({});
    expect(outcome.status).toBe('error');
    expect(outcome.stage).toBe('async-fx');
    expect(order).toEqual(['async-fx', 'undo-async-fx']);
  });

  test('a throwing log observer cannot hang failure outcomes', async () => {
    const flow = stagedRun<Box>(
      'bad-log',
      (s) => [
        s.snapshot({ name: 'load', provides: ['value'], run: () => ({ value: 1 }) }),
        s.effect({
          name: 'doomed',
          writes: ['value'],
          run: async () => {
            throw new Error('boom');
          },
        }),
        s.halt({ name: 'end', run: () => 'done' }),
      ],
      {
        log: () => {
          throw new Error('observer exploded');
        },
      }
    );
    const outcome = await flow({});
    expect(outcome.status).toBe('error');
    expect(outcome.stage).toBe('doomed');
    expect((outcome.error as Error).message).toBe('boom');
  });

  test('a throwing log observer does not stop reverse unwinding', async () => {
    const order: string[] = [];
    const undoBoom = new Error('undo-boom');
    const flow = stagedRun<Box>(
      'bad-log-unwind',
      (s) => [
        s.snapshot({ name: 'load', provides: ['value'], run: () => ({ value: 1 }) }),
        s.effect({
          name: 'one',
          writes: ['value'],
          run: () => {},
          compensate: () => {
            order.push('undo-one');
          },
        }),
        s.effect({
          name: 'two',
          writes: ['value'],
          run: () => {},
          compensate: () => {
            order.push('undo-two');
            throw undoBoom;
          },
        }),
        s.effect({
          name: 'three',
          writes: ['value'],
          run: () => {
            throw new Error('trigger');
          },
        }),
        s.halt({ name: 'end', run: () => 'done' }),
      ],
      {
        log: () => {
          throw new Error('observer exploded');
        },
      }
    );
    const outcome = await flow({});
    expect(outcome.status).toBe('error');
    expect(outcome.stage).toBe('three');
    expect(order).toEqual(['undo-two', 'undo-one']);
    expect(outcome.unwind).toEqual([
      { stage: 'two', status: 'failed', error: undoBoom },
      { stage: 'one', status: 'compensated' },
    ]);
  });

  test('a failed pass leaves no compensation state behind for the next run', async () => {
    const order: string[] = [];
    const flow = stagedRun<Box>('run-isolation', (s) => [
      s.snapshot({ name: 'load', provides: ['value'], run: () => ({ value: 1 }) }),
      s.effect({
        name: 'guarded',
        writes: ['value'],
        run: () => {
          order.push('guarded');
        },
        compensate: () => {
          order.push('undo-guarded');
        },
      }),
      s.halt({ name: 'end', run: () => 'done' }),
    ]);
    const failing = stagedRun<Box>('run-isolation-fail', (s) => [
      s.snapshot({ name: 'load', provides: ['value'], run: () => ({ value: 1 }) }),
      s.effect({
        name: 'doomed',
        writes: ['value'],
        run: () => {
          order.push('doomed');
          throw new Error('boom');
        },
        compensate: () => {
          order.push('undo-doomed');
        },
      }),
      s.halt({ name: 'end', run: () => 'done' }),
    ]);
    await failing({});
    await expect(flow({})).resolves.toEqual({ status: 'completed', result: 'done' });
    expect(order).toEqual(['doomed', 'undo-doomed', 'guarded']);
  });
});

describe('stagedRun microtask profile', () => {
  test('a fully synchronous flow executes every stage inside the invoke call', async () => {
    const ran: string[] = [];
    const flow = stagedRun<Box>('all-sync', (s) => [
      s.snapshot({
        name: 'load',
        provides: ['value'],
        run: () => {
          ran.push('load');
          return { value: 1 };
        },
      }),
      s.decide({
        name: 'route',
        reads: ['value'],
        run: ({ value }) => {
          ran.push('route');
          return { decision: value };
        },
      }),
      s.effect({
        name: 'fx',
        writes: ['value'],
        run: () => {
          ran.push('fx');
        },
      }),
      s.halt({
        name: 'end',
        run: () => {
          ran.push('end');
          return 'done';
        },
      }),
    ]);
    const promise = flow({});
    expect(ran).toEqual(['load', 'route', 'fx', 'end']);
    await promise;
  });

  test('a sync decide after an async snapshot runs before an already-queued microtask', async () => {
    const order: string[] = [];
    const flow = stagedRun<Box>('mixed-profile', (s) => [
      s.snapshot({
        name: 'load',
        provides: ['value'],
        run: () => {
          order.push('load');
          return Promise.resolve({ value: 1 });
        },
      }),
      s.decide({
        name: 'route',
        reads: ['value'],
        run: ({ value }) => {
          order.push('route');
          return { decision: value };
        },
      }),
      s.effect({
        name: 'fx',
        writes: ['value'],
        run: async () => {
          order.push('fx');
        },
      }),
      s.halt({ name: 'end', run: () => 'done' }),
    ]);
    const promise = flow({});
    queueMicrotask(() => order.push('observer'));
    const outcome = await promise;
    expect(outcome.status).toBe('completed');
    expect(order).toEqual(['load', 'route', 'fx', 'observer']);
  });
});

describe('stagedRun verified-stop shaped composite', () => {
  type StopState = {
    sessionId: string;
    presence: string;
    interrupted: boolean;
    verified: boolean;
  };

  function buildFlow(calls: string[]) {
    return stagedRun<StopState>(
      'verified-stop',
      (s) => [
        s.snapshot({
          name: 'presence',
          provides: ['presence', 'interrupted'],
          reads: ['sessionId'],
          run: ({ sessionId }) => ({ presence: `present:${sessionId}`, interrupted: false }),
        }),
        s.decide({
          name: 'down-check',
          reads: ['presence'],
          branches: ['alreadyDown', 'interrupt'],
          run: ({ presence }) =>
            presence === 'present:down'
              ? { decision: 'already_down', alreadyDown: { verdict: 'noop' } }
              : { decision: 'interrupt', interrupt: { mode: 'strict' } },
        }),
        s.halt({
          name: 'exit-already-down',
          when: 'alreadyDown',
          run: (view) => (view.alreadyDown as { verdict: string }).verdict,
        }),
        s.effect({
          name: 'interrupt-session',
          when: 'interrupt',
          writes: ['interrupted'],
          run: async () => {
            calls.push('interrupt');
          },
        }),
        s.resnapshot({
          name: 'inspect',
          provides: ['verified'],
          run: () => ({ verified: calls.includes('interrupt') }),
        }),
        s.decide({
          name: 'verify-check',
          reads: ['verified'],
          branches: ['settled', 'escalate'],
          run: ({ verified }) =>
            verified
              ? { decision: 'done', settled: { verdict: 'stopped' } }
              : { decision: 'escalate', escalate: { force: true } },
        }),
        s.effect({
          name: 'terminate-processes',
          when: 'escalate',
          writes: ['verified'],
          run: async () => {
            calls.push('terminate');
          },
        }),
        s.halt({
          name: 'verdict',
          when: 'settled',
          run: (view) => (view.settled as { verdict: string }).verdict,
        }),
      ],
      { input: ['sessionId'] }
    );
  }

  test('the interrupt path runs effect, resnapshot, decide, and halts with the verdict', async () => {
    const calls: string[] = [];
    const flow = buildFlow(calls);
    await expect(flow({ sessionId: 's-42' })).resolves.toEqual({
      status: 'completed',
      result: 'stopped',
    });
    expect(calls).toEqual(['interrupt']);
  });

  test('the already-down path halts before any effect stage runs', async () => {
    const calls: string[] = [];
    const flow = buildFlow(calls);
    await expect(flow({ sessionId: 'down' })).resolves.toEqual({
      status: 'completed',
      result: 'noop',
    });
    expect(calls).toEqual([]);
  });
});

describe('stagedRun deferred durability', () => {
  test('the durable compensation arms stay explicitly deferred', () => {
    expect([...DEFERRED_DURABLE_COMPENSATION_ARMS]).toEqual([
      'durable-saga-record',
      'outbox-replay',
    ]);
  });

  test('a plain error outcome carries an empty unwind report by default', async () => {
    const flow = stagedRun<Box>('empty-unwind', (s) => [
      s.snapshot({ name: 'load', provides: ['value'], run: () => ({ value: 1 }) }),
      s.effect({
        name: 'fx',
        writes: ['value'],
        run: () => {
          throw new Error('boom');
        },
      }),
      s.halt({ name: 'end', run: () => 'done' }),
    ]);
    const outcome: StagedRunOutcome = await flow({});
    expect(outcome.unwind).toEqual([]);
  });
});
