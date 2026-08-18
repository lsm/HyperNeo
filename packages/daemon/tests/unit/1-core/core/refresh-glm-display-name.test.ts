import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { unlinkSync } from 'node:fs';
import { Database } from '../../../../src/storage';
import { createReactiveDatabase } from '../../../../src/storage/reactive-database';
import { refreshGlmDisplayName } from '../../../../src/lib/credential-discovery';

describe('refreshGlmDisplayName', () => {
  let db: Database;
  let dbPath: string;

  beforeEach(async () => {
    const tmpBase = (process.env.TMPDIR || '/tmp').replace(/\/$/, '');
    dbPath = `${tmpBase}/test-glm-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`;
    db = new Database(dbPath);
    const reactiveDb = createReactiveDatabase(db);
    await db.initialize(reactiveDb);
  });

  afterEach(() => {
    db?.close();
    try {
      unlinkSync(dbPath);
    } catch {
      // Ignore cleanup errors.
    }
  });

  function seedGlm(displayName: string): void {
    db.providers.createProvider({
      providerId: 'glm',
      displayName,
      kind: 'built_in',
      authType: 'api_key',
    });
  }

  it('refreshes a stale "GLM" display name to "Z.ai"', () => {
    seedGlm('GLM');
    refreshGlmDisplayName(db);
    expect(db.providers.getProviderByProviderId('glm')?.displayName).toBe('Z.ai');
  });

  it('refreshes the legacy "GLM (智谱AI)" display name to "Z.ai"', () => {
    seedGlm('GLM (智谱AI)');
    refreshGlmDisplayName(db);
    expect(db.providers.getProviderByProviderId('glm')?.displayName).toBe('Z.ai');
  });

  it('preserves a user-customized display name', () => {
    seedGlm('My GLM');
    refreshGlmDisplayName(db);
    expect(db.providers.getProviderByProviderId('glm')?.displayName).toBe('My GLM');
  });

  it('leaves an already-current "Z.ai" display name unchanged', () => {
    seedGlm('Z.ai');
    refreshGlmDisplayName(db);
    expect(db.providers.getProviderByProviderId('glm')?.displayName).toBe('Z.ai');
  });

  it('is idempotent when run twice on a stale row', () => {
    seedGlm('GLM');
    refreshGlmDisplayName(db);
    refreshGlmDisplayName(db);
    expect(db.providers.getProviderByProviderId('glm')?.displayName).toBe('Z.ai');
  });

  it('touches only display_name — provider_id and other fields are unchanged', () => {
    seedGlm('GLM');
    const before = db.providers.getProviderByProviderId('glm');
    refreshGlmDisplayName(db);
    const after = db.providers.getProviderByProviderId('glm');
    expect(after?.providerId).toBe('glm');
    expect(after?.authType).toBe(before?.authType);
    expect(after?.isEnabled).toBe(before?.isEnabled);
    expect(after?.kind).toBe(before?.kind);
  });

  it('is a no-op when no glm provider row exists', () => {
    db.providers.createProvider({
      providerId: 'anthropic',
      displayName: 'Anthropic',
      kind: 'built_in',
      authType: 'api_key',
    });
    expect(() => refreshGlmDisplayName(db)).not.toThrow();
    expect(db.providers.getProviderByProviderId('glm')).toBeNull();
  });
});
