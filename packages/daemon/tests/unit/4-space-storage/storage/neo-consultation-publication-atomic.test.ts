import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Mock, vi } from 'vitest';
import type { NeoPublicationInput } from '@hyperneo/shared/types/neo-publication';
import {
  CONSULTATION_EXPIRED,
  CONSULTATION_TIMEOUT_MS,
} from '../../../../src/lib/neo/consultation-policy.ts';
import { getExcludedTableNames } from '../../../../src/lib/db-query/scope-config.ts';
import { NeoConsultationRepository } from '../../../../src/storage/repositories/neo-consultation-repository.ts';
import type { NeoConsultationPublicationSettlement } from '../../../../src/storage/repositories/neo-consultation-repository.ts';
import { NeoPublicationRepository } from '../../../../src/storage/repositories/neo-publication-repository.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables } from '../../../../src/storage/schema/index.ts';
import { runMigrations } from '../../../../src/storage/schema/migrations.ts';

const conversationId = '10000000-0000-4000-8000-000000000001';
type PragmaRow = Record<string, string | null>;
const root = `neo:${conversationId}`;
const holder = 'neo:holder:research';
const publication = (id = 1): NeoPublicationInput => ({
  conversationId,
  publicationId: `20000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
  askOrigin: { sessionId: holder, messageId: 'holder-human-ask' },
  producerInput: { sessionId: holder, messageId: 'neo-consult:consult-1:request' },
  shortText: 'Checked. The third source differs.',
  fullText: '**Detail** behind the short answer.',
  links: [{ label: 'View comparison', kind: 'concern', id: 'research' }],
});
const count = (db: Database, table: string) =>
  (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
const payloadOf = (db: Database) =>
  (db.prepare('SELECT payload_json AS p FROM neo_publications').get() as { p: string } | undefined)
    ?.p;
const shapeOf = (db: Database) => ({
  columns: db.prepare('PRAGMA table_info(neo_consultation_publications)').all() as PragmaRow[],
  keys: db.prepare('PRAGMA foreign_key_list(neo_consultation_publications)').all() as PragmaRow[],
  indexes: db
    .prepare(
      `SELECT name, sql FROM sqlite_master
      WHERE type = 'index' AND tbl_name = 'neo_consultation_publications' ORDER BY name`
    )
    .all() as PragmaRow[],
});

describe('atomic consultation publication settlement', () => {
  let directory: string;
  let path: string;
  let writer: Database;
  let reader: Database;
  let consultations: NeoConsultationRepository;
  let notified: number;
  let notify: Mock<() => void>;

  const open = () => {
    writer = new Database(path);
    reader = new Database(path);
  };
  const seed = (id: string, createdAt = Date.now(), status: 'pending' | 'reported' = 'pending') => {
    writer
      .prepare(
        `INSERT INTO neo_concerns(id, title, summary, context, revision, created_at, updated_at)
        VALUES ('research', 'Fictional', '', '', 1, 0, 0) ON CONFLICT DO NOTHING`
      )
      .run();
    writer
      .prepare(
        `INSERT INTO neo_consultations
        (id, request_key, concern_id, origin_session_id, origin_message_id, session_id, question, status, created_at)
        VALUES (?, ?, 'research', ?, 'root-human-ask', ?, 'Compare the fictional sources.', ?, ?)`
      )
      .run(id, id, root, holder, status, createdAt);
  };
  const settle = (
    input: NeoPublicationInput = publication(),
    answer = 'Checked.',
    id = 'consult-1'
  ) => consultations.settleWithPublication({ consultationId: id, answer, publication: input });
  const variant = (over: Partial<NeoPublicationInput>) => ({ ...publication(), ...over });

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'neo-consultation-publication-'));
    path = join(directory, 'fictional.db');
    open();
    runMigrations(writer, () => {});
    createTables(writer);
    notified = 0;
    notify = vi.fn(() => {
      notified += 1;
    });
    consultations = new NeoConsultationRepository(writer, notify);
    seed('consult-1');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    reader.close();
    writer.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const unchanged = (status: 'pending' | 'reported' | 'failed' = 'pending') => {
    expect(count(writer, 'neo_publications')).toBe(0);
    expect(count(writer, 'neo_consultation_publications')).toBe(0);
    expect(consultations.get('consult-1')?.status).toBe(status);
    expect(notified).toBe(0);
  };
  const accepted = (result: NeoConsultationPublicationSettlement) => {
    expect(result.accepted).toBe(true);
    return result as Extract<typeof result, { accepted: true }>;
  };

  test('commits all three rows and notifies only after the outer commit', () => {
    const atNotify: unknown[] = [];
    notify.mockImplementation(() => {
      notified += 1;
      atNotify.push(
        reader.prepare('SELECT status, answer FROM neo_consultations').get(),
        payloadOf(reader),
        reader
          .prepare(
            'SELECT consultation_id AS id, answer, payload_json AS payload FROM neo_consultation_publications'
          )
          .get(),
        settle(publication(9), 'Checked.', 'absent-id')
      );
    });
    expect(settle()).toEqual({
      accepted: true,
      created: true,
      association: {
        consultationId: 'consult-1',
        conversationId,
        publicationId: publication().publicationId,
        answer: 'Checked.',
        createdAt: expect.any(String),
      },
    });
    expect(notified).toBe(1);
    expect(atNotify).toEqual([
      { status: 'reported', answer: 'Checked.' },
      JSON.stringify(publication()),
      { id: 'consult-1', answer: 'Checked.', payload: JSON.stringify(publication()) },
      { accepted: false, reason: 'unknown_consultation' },
    ]);
    expect(count(writer, 'neo_publications')).toBe(1);
  });

  test('keeps both original ask ids and the holder producer unchanged in the stored payload', () => {
    settle();
    expect(JSON.parse(payloadOf(writer)!)).toMatchObject({
      conversationId,
      askOrigin: { sessionId: holder, messageId: 'holder-human-ask' },
      producerInput: { sessionId: holder, messageId: 'neo-consult:consult-1:request' },
      shortText: publication().shortText,
      fullText: publication().fullText,
      links: publication().links,
    });
  });

  test('treats a reordered but semantically identical payload as the same retry', () => {
    const first = accepted(settle());
    const reordered = Object.fromEntries(
      Object.entries(publication()).reverse()
    ) as unknown as NeoPublicationInput;
    expect(accepted(settle(reordered))).toEqual({ ...first, created: false });
    expect(count(writer, 'neo_publications')).toBe(1);
    expect(notified).toBe(2);
  });

  test('returns the durable receipt for an identical retry after reopening past the timeout', () => {
    const first = accepted(settle());
    writer.close();
    reader.close();
    open();
    consultations = new NeoConsultationRepository(writer, notify);
    writer
      .prepare('UPDATE neo_consultations SET created_at = ? WHERE id = ?')
      .run(Date.now() - CONSULTATION_TIMEOUT_MS - 1000, 'consult-1');
    expect(accepted(settle())).toEqual({ ...first, created: false });
    expect(count(writer, 'neo_publications')).toBe(1);
    expect(consultations.getPublication('consult-1')).toMatchObject({
      conversationId,
      publicationId: publication().publicationId,
      answer: 'Checked.',
    });
  });

  test.each([
    { name: 'a different publication id', input: publication(2) },
    { name: 'a changed answer', input: publication(), answer: 'Different.' },
    { name: 'a changed short reply', input: variant({ shortText: 'Reword.' }) },
    { name: 'a changed full detail', input: variant({ fullText: 'Reword.' }) },
    {
      name: 'a changed scene label',
      input: variant({ links: [{ label: 'Relabelled', kind: 'concern', id: 'research' }] }),
    },
    {
      name: 'a changed original ask',
      input: variant({ askOrigin: { sessionId: holder, messageId: 'other-ask' } }),
    },
    {
      name: 'a changed producer',
      input: variant({ producerInput: { sessionId: holder, messageId: 'other-request' } }),
    },
  ])('refuses $name for a settled consultation', ({ input, answer = 'Checked.' }) => {
    settle();
    expect(settle(input, answer)).toEqual({ accepted: false, reason: 'publication_conflict' });
    expect(count(writer, 'neo_publications')).toBe(1);
    expect(count(writer, 'neo_consultation_publications')).toBe(1);
    expect(notified).toBe(1);
  });

  test('refuses a publication already associated with another consultation', () => {
    settle();
    seed('consult-2');
    expect(settle(publication(), 'Checked.', 'consult-2')).toEqual({
      accepted: false,
      reason: 'publication_conflict',
    });
    expect(count(writer, 'neo_consultation_publications')).toBe(1);
    expect(consultations.get('consult-2')?.status).toBe('pending');
    expect(notified).toBe(1);
  });

  test.each([
    { name: 'association insert', table: 'neo_consultation_publications', event: 'INSERT' },
    { name: 'publication insert', table: 'neo_publications', event: 'INSERT' },
    { name: 'consultation settlement', table: 'neo_consultations', event: 'UPDATE' },
  ])('rolls back all three writes when the $name faults', ({ table, event, name }) => {
    writer.exec(
      `CREATE TRIGGER refuse BEFORE ${event} ON ${table} BEGIN SELECT RAISE(ABORT, '${name} fault'); END`
    );
    expect(() => settle()).toThrow(`${name} fault`);
    unchanged();
  });

  test('rolls back the publication when the settlement loses its reservation', () => {
    writer.exec(
      `CREATE TRIGGER supersede BEFORE UPDATE ON neo_consultations
      BEGIN SELECT RAISE(IGNORE); END`
    );
    expect(settle()).toEqual({ accepted: false, reason: 'consultation_settled' });
    unchanged();
  });

  test('refuses an ambient transaction so the primitive owns its commit', () => {
    expect(() => writer.transaction(() => settle())()).toThrow('must own its commit boundary');
    unchanged();
  });

  test.each([
    { name: 'unknown', id: 'missing', expect: 'unknown_consultation', status: 'pending' },
    {
      name: 'settled without an association',
      id: 'consult-1',
      expect: 'consultation_settled',
      status: 'reported',
      set: "status = 'reported'",
    },
    {
      name: 'failed',
      id: 'consult-1',
      expect: 'consultation_settled',
      status: 'failed',
      set: `status = 'failed', answer = '${CONSULTATION_EXPIRED}'`,
    },
    {
      name: 'expired',
      id: 'consult-1',
      expect: 'consultation_expired',
      status: 'pending',
      set: 'expired',
    },
  ])('refuses a $name consultation without publishing', ({ id, expect: reason, status, set }) => {
    if (set === 'expired')
      writer
        .prepare('UPDATE neo_consultations SET created_at = ? WHERE id = ?')
        .run(Date.now() - CONSULTATION_TIMEOUT_MS - 1000, 'consult-1');
    else if (set)
      writer.prepare(`UPDATE neo_consultations SET ${set} WHERE id = ?`).run('consult-1');
    expect(settle(publication(), 'Checked.', id)).toEqual({ accepted: false, reason });
    unchanged(status);
  });

  test('refuses an invalid publication before any write', () => {
    expect(settle({ ...publication(), publicationId: 'not-a-uuid' })).toEqual({
      accepted: false,
      reason: 'invalid_publication',
    });
    unchanged();
  });

  test('keeps durable success when the listener throws after commit', () => {
    notify.mockImplementation(() => {
      throw new Error('listener fault');
    });
    expect(settle()).toMatchObject({ accepted: true, created: true });
    expect(count(writer, 'neo_consultation_publications')).toBe(1);
    expect(count(writer, 'neo_publications')).toBe(1);
    expect(consultations.get('consult-1')?.status).toBe('reported');
  });

  test('registers the association table through the upgrade and fresh creation paths', () => {
    const upgraded = new Database(':memory:');
    runMigrations(upgraded, () => {});
    createTables(upgraded);
    const fresh = new Database(':memory:');
    createTables(fresh);
    const shape = shapeOf(fresh);
    expect(shapeOf(upgraded)).toEqual(shape);
    expect(shape.columns).toHaveLength(6);
    expect(shape.keys.map((key) => `${key.from} to ${key.table}.${key.to}`).sort()).toEqual([
      'consultation_id to neo_consultations.id',
      'conversation_id to neo_publications.conversation_id',
      'publication_id to neo_publications.publication_id',
    ]);
    expect(shape.indexes).toEqual([
      expect.objectContaining({
        name: 'idx_neo_consultation_publications_publication',
        sql: expect.stringContaining('CREATE UNIQUE INDEX'),
      }),
      { name: 'sqlite_autoindex_neo_consultation_publications_1', sql: null },
    ]);
    expect(shape.indexes[0].sql).toContain('(conversation_id, publication_id)');
    upgraded.exec('DROP TABLE neo_consultation_publications');
    upgraded.prepare('DELETE FROM migration_markers WHERE key LIKE ?').run('migration_291%');
    runMigrations(upgraded, () => {});
    expect(shapeOf(upgraded)).toEqual(shapeOf(fresh));
    expect(getExcludedTableNames()).toContain('neo_consultation_publications');
    upgraded.close();
    fresh.close();
  });

  test.each([
    { name: 'a missing consultation', consult: 'absent', pub: publication(2).publicationId },
    { name: 'a missing publication', consult: 'consult-3', pub: publication(9).publicationId },
  ])('rejects an association for $name', ({ consult, pub: publicationId }) => {
    writer.exec('PRAGMA foreign_keys = ON');
    settle();
    new NeoPublicationRepository(writer).append(publication(2));
    seed('consult-3');
    expect(() =>
      writer
        .prepare(
          `INSERT INTO neo_consultation_publications
          (consultation_id, conversation_id, publication_id, answer, payload_json, created_at)
          VALUES (?, ?, ?, 'x', '{}', 'now')`
        )
        .run(consult, conversationId, publicationId)
    ).toThrow();
  });
});
