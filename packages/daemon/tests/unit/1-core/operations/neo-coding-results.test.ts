import { describe, test, expect } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import {
  CodingAssignmentsRepository,
  type CodingAssignment,
} from '../../../../src/lib/neo/packs/coding/assignments.ts';
import { CodingPrLedgerRepository } from '../../../../src/lib/neo/packs/coding/pr-ledger.ts';
import { createCodingResultOperation } from '../../../../src/lib/neo/packs/coding/result-operation.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';

const url = 'https://github.com/synthetic/assignments/pull/1';
const write = { adapter: 'codex-desktop', id: 'writer' };
const ref = { adapter: 'hyperneo', id: 'reviewer' };
const actor = {
  kind: 'agent',
  id: ref.id,
  harness: ref.adapter,
  model: 'claude-opus-5-5',
} as const;
const assignment: CodingAssignment = {
  url,
  head: 'head-a',
  acceptanceContract: 'artifact:contract',
  newDispatch: true,
  write,
  ref,
  actor,
};
const fact = {
  url,
  head: 'head-a',
  acceptanceContract: assignment.acceptanceContract,
  actor,
  stage: 'review',
  verdict: 'pass',
  evidence: ['artifact:proof'],
};

function setup() {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  createCodingPackTables(db);
  db.exec(
    "INSERT INTO neo_asks (id,session_id,title,request,created_at,updated_at) VALUES ('ask','synthetic','Actors','Actors',1,1); INSERT INTO neo_todos (id,ask_id,position,title,done_when,state,created_at,updated_at) VALUES ('todo','ask',1,'Actors','Merged','doing',1,1)"
  );
  const assignments = new CodingAssignmentsRepository(db),
    ledger = new CodingPrLedgerRepository(db);
  ledger.stageFacts.observeHead(url, 'head-a', 1);
  const registry = createOperationRegistry([createCodingResultOperation(assignments, ledger)]);
  const result = (input: unknown, role = 'neo' as const) =>
    invokeOperation(registry, 'neo.coding.result', input, { source: 'internal', role });
  return { db, assignments, ledger, result };
}

describe('linked coding assignment results', () => {
  test('assigned human Review results retain their explicit identity and ref', async () => {
    const { db, assignments, ledger, result } = setup();
    try {
      const human = { kind: 'human', id: 'person' } as const,
        humanRef = { adapter: 'human', id: 'person' };
      assignments.record('todo', 'review', { ...assignment, actor: human, ref: humanRef });
      expect(
        await result({ todoId: 'todo', ref: humanRef, fact: { ...fact, actor: human } })
      ).toEqual({ kind: 'completed', value: { ok: true } });
      expect(ledger.stageFacts.read(url)).toEqual([{ ...fact, actor: human, ref: humanRef }]);
    } finally {
      db.close();
    }
  });
  test('public Verify results keep the legacy stored stage and historical facts readable', async () => {
    const { db, assignments, ledger, result } = setup();
    try {
      assignments.record('todo', 'review', assignment);
      const verifyRef = { ...ref, id: 'verify' },
        verifyActor = { ...actor, id: 'verify' };
      assignments.record('todo', 'qa', { ...assignment, ref: verifyRef, actor: verifyActor });
      expect(
        await result({
          todoId: 'todo',
          ref: verifyRef,
          fact: { ...fact, stage: 'verify', actor: verifyActor },
        })
      ).toEqual({ kind: 'completed', value: { ok: true } });
      expect(ledger.stageFacts.read(url)).toEqual([
        { ...fact, stage: 'qa', actor: verifyActor, ref: verifyRef },
      ]);
    } finally {
      db.close();
    }
  });
  test.each(['review', 'qa'] as const)(
    'persists the validated full %s worker ref rather than a claimed fact ref',
    async (stage) => {
      const { db, assignments, ledger, result } = setup();
      try {
        assignments.record('todo', 'review', assignment);
        const assignedRef = {
          adapter: 'codex-desktop',
          id: 'independent',
          daemon: 'fixture-daemon',
        };
        const assignedActor = { ...actor, id: assignedRef.id, harness: assignedRef.adapter };
        if (stage === 'qa')
          assignments.record('todo', 'qa', {
            ...assignment,
            ref: assignedRef,
            actor: assignedActor,
          });
        const validatedRef = stage === 'qa' ? assignedRef : ref;
        const validatedActor = stage === 'qa' ? assignedActor : actor;
        expect(
          await result({
            todoId: 'todo',
            ref: validatedRef,
            fact: {
              ...fact,
              stage,
              actor: validatedActor,
              ref: { ...validatedRef, id: 'unassigned-claim' },
            },
          })
        ).toEqual({ kind: 'completed', value: { ok: true } });
        expect(ledger.stageFacts.read(url)).toEqual([
          { ...fact, stage, actor: validatedActor, ref: validatedRef },
        ]);
      } finally {
        db.close();
      }
    }
  );
  test('persists the same contract for review and independent QA without changing the todo', async () => {
    const { db, assignments, ledger, result } = setup();
    try {
      expect(assignments.read('todo', url, 'head-a')).toEqual({});
      expect(await assignments.recordLater('todo', 'review', assignment)).toBe(true);
      expect(
        await assignments.recordLater('todo', 'qa', {
          ...assignment,
          ref: { ...ref, id: 'qa' },
          actor: { ...actor, id: 'qa' },
        })
      ).toBe(true);
      expect(await result({ todoId: 'todo', ref, fact })).toEqual({
        kind: 'completed',
        value: { ok: true },
      });
      expect(ledger.stageFacts.read(url)).toHaveLength(1);
      expect(db.prepare("SELECT state FROM neo_todos WHERE id = 'todo'").get()).toEqual({
        state: 'doing',
      });
    } finally {
      db.close();
    }
  });
  test('refuses author reuse, reviewer reuse, contract changes and stale assignments', async () => {
    const { db, assignments, ledger } = setup();
    try {
      expect(() =>
        assignments.record('todo', 'review', {
          ...assignment,
          ref: write,
          actor: { ...actor, id: write.id, harness: write.adapter },
        })
      ).toThrow();
      expect(assignments.record('todo', 'review', assignment)).toBe(true);
      expect(
        assignments.record('todo', 'review', { ...assignment, acceptanceContract: 'changed' })
      ).toBe(false);
      expect(assignments.record('todo', 'qa', assignment)).toBe(false);
      expect(
        assignments.record('todo', 'qa', {
          ...assignment,
          acceptanceContract: 'changed',
          ref: { ...ref, id: 'qa' },
          actor: { ...actor, id: 'qa' },
        })
      ).toBe(false);
      ledger.stageFacts.observeHead(url, 'head-b', 2);
      expect(assignments.record('todo', 'review', assignment)).toBe(false);
      expect(assignments.read('todo', url, 'head-b')).toEqual({});
      expect(
        assignments.record('todo', 'review', {
          ...assignment,
          head: 'head-b',
          acceptanceContract: 'changed',
        })
      ).toBe(false);
      expect(assignments.record('todo', 'review', { ...assignment, head: 'head-b' })).toBe(true);
    } finally {
      db.close();
    }
  });
  test.each([
    { ref: { ...ref, id: 'other' } },
    { ref: { ...ref, daemon: 'other' } },
    { fact: { ...fact, actor: { ...actor, model: 'gpt-6' } } },
    { fact: { ...fact, actor: { ...actor, harness: 'codex-desktop' } } },
    { fact: { ...fact, acceptanceContract: 'changed' } },
    { fact: { ...fact, head: 'head-b' } },
    { todoId: 'other' },
  ])('refuses mismatched result %j without recording a verdict', async (patch) => {
    const { db, assignments, ledger, result } = setup();
    try {
      assignments.record('todo', 'review', assignment);
      expect(await result({ todoId: 'todo', ref, fact, ...patch })).toEqual({
        kind: 'completed',
        value: { ok: false, reason: 'stage_assignment_mismatch' },
      });
      expect(ledger.stageFacts.read(url)).toEqual([]);
    } finally {
      db.close();
    }
  });
  test('rejects late results and cannot turn a failed assigned stage into a pass', async () => {
    const { db, assignments, ledger, result } = setup();
    try {
      assignments.record('todo', 'review', assignment);
      expect(await result({ todoId: 'todo', ref, fact: { ...fact, verdict: 'fail' } })).toEqual({
        kind: 'completed',
        value: { ok: true },
      });
      expect(await result({ todoId: 'todo', ref, fact })).toEqual({
        kind: 'completed',
        value: { ok: false, reason: 'head_changed_or_failed_stage' },
      });
      ledger.stageFacts.observeHead(url, 'head-b', 2);
      expect(await result({ todoId: 'todo', ref, fact })).toEqual({
        kind: 'completed',
        value: { ok: false, reason: 'head_changed_or_failed_stage' },
      });
    } finally {
      db.close();
    }
  });
  test('an assigned bot cannot be impersonated through the agent result door', async () => {
    const { db, assignments, ledger, result } = setup();
    try {
      assignments.record('todo', 'review', {
        url,
        head: assignment.head,
        acceptanceContract: assignment.acceptanceContract,
        newDispatch: true,
        write,
        bot: 'repo-bot',
      });
      expect(await result({ todoId: 'todo', ref, fact })).toEqual({
        kind: 'completed',
        value: { ok: false, reason: 'stage_assignment_mismatch' },
      });
      expect(ledger.stageFacts.read(url)).toEqual([]);
    } finally {
      db.close();
    }
  });
});
