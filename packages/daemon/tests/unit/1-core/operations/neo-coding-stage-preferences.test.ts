import { describe, test, expect } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import {
  CODING_STAGE_PREFERENCES,
  planCodingStageTarget,
} from '../../../../src/lib/neo/packs/coding/stage-preferences.ts';
import { validatePackPreference } from '../../../../src/lib/neo/preference-operations.ts';

const place = { machine: 'fixture', name: 'Fixture' };
const standard = { adapter: 'hyperneo', place, model: 'claude-opus-5-5' };
const preferred = { adapter: 'codex-desktop', place, model: 'gpt-6', effort: 'high' };
const repo = 'synthetic/preferences';
function setup() {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  const set = (key: string, value: string, scope = repo) =>
    db
      .prepare(`INSERT INTO neo_pack_preferences
    (pack,scope_kind,scope_key,key,value_json,set_by,set_at) VALUES ('coding',?,?,?,?,'human',1)`)
      .run(scope ? 'repo' : 'global', scope, key, JSON.stringify(value));
  return { db, set };
}

describe('coding stage target preferences', () => {
  test.each(['write', 'review', 'verify'] as const)(
    'shares the prefer shape for %s without storing defaults',
    (stage) => {
      const { db, set } = setup();
      try {
        const input = {
          repo,
          stage,
          candidates: [standard, preferred],
          body: 'Agent: Claude Sonnet 5.5 via claude-code',
        };
        expect(planCodingStageTarget(db, input, true)).toEqual({
          ok: true,
          target: standard,
          fallback: [],
        });
        expect(db.prepare('SELECT COUNT(*) AS n FROM neo_pack_preferences').get()).toEqual({
          n: 0,
        });
        for (const [field, value] of Object.entries({
          harness: preferred.adapter,
          model: preferred.model,
          effort: preferred.effort,
        }))
          set(`${stage}.${field}`, value);
        expect(planCodingStageTarget(db, input, true)).toEqual({
          ok: true,
          target: preferred,
          fallback: [],
        });
      } finally {
        db.close();
      }
    }
  );
  test('an unavailable preference uses the default with a reason, without changing the saved setting', () => {
    const { db, set } = setup();
    try {
      set('verify.model', 'not-available');
      const result = planCodingStageTarget(
        db,
        { repo, stage: 'verify', candidates: [standard, preferred], body: '' },
        true
      );
      expect(result).toEqual({
        ok: true,
        target: standard,
        fallback: [
          'Preferred model "not-available" is unavailable for this selection; using "claude-opus-5-5".',
        ],
      });
      expect(db.prepare('SELECT value_json FROM neo_pack_preferences').get()).toEqual({
        value_json: '"not-available"',
      });
    } finally {
      db.close();
    }
  });
  test('repository values override global preferences with case-insensitive repository matching', () => {
    const { db, set } = setup();
    try {
      set('write.model', standard.model, '');
      set('write.model', preferred.model, 'Synthetic/Preferences');
      expect(
        planCodingStageTarget(
          db,
          { repo, stage: 'write', candidates: [standard, preferred], body: '' },
          true
        )
      ).toEqual({ ok: true, target: preferred, fallback: [] });
      expect(
        planCodingStageTarget(
          db,
          { repo: 'other/repo', stage: 'write', candidates: [preferred, standard], body: '' },
          true
        )
      ).toEqual({ ok: true, target: standard, fallback: [] });
    } finally {
      db.close();
    }
  });
  test('review preferences cannot select the author model; a different harness breaks otherwise equal ties', () => {
    const { db, set } = setup();
    try {
      set('review.model', preferred.model);
      const otherHarness = { ...standard, adapter: 'claude-code' };
      const result = planCodingStageTarget(
        db,
        {
          repo,
          stage: 'review',
          candidates: [preferred, { ...standard, adapter: preferred.adapter }, otherHarness],
          body: 'Agent: GPT-6 via codex-desktop',
        },
        true
      );
      expect(result).toEqual({
        ok: true,
        target: otherHarness,
        fallback: [
          'Preferred model "gpt-6" is unavailable for this selection; using "claude-opus-5-5".',
        ],
      });
      expect(
        planCodingStageTarget(
          db,
          { repo, stage: 'review', candidates: [preferred], body: 'Agent: GPT-6 via other' },
          true
        )
      ).toMatchObject({ ok: false, reason: expect.stringContaining('same_model') });
      expect(
        planCodingStageTarget(
          db,
          { repo, stage: 'review', candidates: [preferred], body: '' },
          true
        )
      ).toMatchObject({ ok: false, reason: expect.stringContaining('author_provenance_required') });
      expect(
        planCodingStageTarget(
          db,
          { repo, stage: 'review', candidates: [preferred], body: '' },
          false
        )
      ).toEqual({ ok: true, target: preferred, fallback: [] });
    } finally {
      db.close();
    }
  });
  test('declares all nine fields as bounded text, including vendor model IDs and explicit defaults', () => {
    const pack = {
      id: 'coding',
      describe: '',
      instructions: () => null,
      preferences: CODING_STAGE_PREFERENCES,
    };
    expect(Object.keys(pack.preferences)).toHaveLength(9);
    for (const key of Object.keys(pack.preferences)) {
      for (const value of ['', 'openai/gpt-6', 'high'])
        expect(
          validatePackPreference(
            { pack: 'coding', key, scope: { kind: 'repo', key: repo }, value },
            [pack]
          )
        ).toHaveProperty('value');
      for (const value of [true, 'x'.repeat(201)])
        expect(
          validatePackPreference(
            { pack: 'coding', key, scope: { kind: 'repo', key: repo }, value },
            [pack]
          )
        ).toHaveProperty('reason');
    }
  });
});
