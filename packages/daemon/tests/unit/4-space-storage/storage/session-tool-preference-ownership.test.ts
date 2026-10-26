import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables } from '../../../../src/storage/schema/index.ts';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository.ts';
import { createTestSession } from '../../../helpers/database.ts';

let db: Database;
let repo: SessionRepository;
const ID = 'owned-tool-preferences';
const selection = (selected = false) => ({
  version: 1 as const,
  choices: { 'skill:notes': { selected } },
});
const current = () => repo.getSession(ID)!.config;
beforeEach(() => {
  db = new Database(':memory:');
  createTables(db);
  repo = new SessionRepository(db);
  repo.createSession({
    ...createTestSession(ID),
    config: {
      ...createTestSession(ID).config,
      autoScroll: true,
      sdkToolsPreset: ['Read'],
      toolSelection: selection(),
      tools: { disabledSkills: ['notes'], useClaudeCodePreset: true },
    },
  });
});
afterEach(() => db.close());

describe('ordinary session updates preserve owned tool preferences', () => {
  it('does not overwrite newer preferences with a stale full config while applying ordinary fields', () => {
    const stale = current();
    const tools = { disabledSkills: [], useClaudeCodePreset: false };
    expect(
      repo.casSessionToolPreferences(
        repo.captureSessionRuntimeSettings(ID)!,
        { toolSelection: selection(true), tools },
        []
      )
    ).toBe('won');
    repo.updateSession(ID, { config: { ...stale, autoScroll: false } });
    expect(current().toolSelection).toEqual(selection(true));
    expect(current().tools).toEqual(tools);
    expect(current().autoScroll).toBe(false);
    expect(current().sdkToolsPreset).toEqual(['Read']);
  });
  it('keeps absence of legacy tools when canonical ownership already exists', () => {
    db.prepare("UPDATE sessions SET config=json_remove(config,'$.tools') WHERE id=?").run(ID);
    repo.updateSession(ID, {
      config: { ...current(), tools: { disabledSkills: ['injected'] }, autoScroll: false },
    });
    expect(Object.hasOwn(current(), 'tools')).toBe(false);
    expect(current().autoScroll).toBe(false);
  });
  it('still permits initial legacy configuration before a canonical selection exists', () => {
    db.prepare("UPDATE sessions SET config=json_remove(config,'$.toolSelection') WHERE id=?").run(
      ID
    );
    repo.updateSession(ID, { config: { ...current(), tools: { disabledSkills: [] } } });
    expect(current().tools).toEqual({ disabledSkills: [] });
    expect(Object.hasOwn(current(), 'toolSelection')).toBe(false);
  });
  it('never repairs a present-null selection through an ordinary settings save', () => {
    db.prepare("UPDATE sessions SET config=json_set(config,'$.toolSelection',NULL) WHERE id=?").run(
      ID
    );
    const before = current().tools;
    repo.updateSession(ID, {
      config: { ...current(), toolSelection: selection(true), tools: { disabledSkills: [] } },
    });
    expect(current().toolSelection).toBeNull();
    expect(current().tools).toEqual(before);
  });
});
