import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { DbGateway } from '../../../../src/storage/db-gateway/db-gateway';
import { SettingsRepository } from '../../../../src/storage/repositories/settings-repository';
import { globalSettingsWrites } from '../../../../src/storage/repositories/global-settings-writes';

describe('Neo settings writer ownership', () => {
  let db: Database;
  let gateway: DbGateway;
  let settings: SettingsRepository;
  const preference = { model: 'synthetic', provider: 'anthropic', thinkingLevel: 'off' };
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(
      'CREATE TABLE global_settings (id INTEGER PRIMARY KEY, settings TEXT NOT NULL, updated_at TEXT NOT NULL)'
    );
    gateway = new DbGateway(':memory:', db);
    settings = new SettingsRepository(db);
    settings.updateGlobalSettings({
      autoScroll: false,
      neo: { autoDispatch: false, packs: ['keep-pack'] },
    });
  });
  afterEach(async () => {
    await gateway.close();
    db.close();
  });

  it('keeps fast replies off when an older whole-Neo patch arrives', async () => {
    settings.updateGlobalSettings({ neo: { front: { enabled: true } } });
    const stale = settings.getGlobalSettings().neo;
    settings.updateGlobalSettings({ neo: { ...stale, front: { enabled: false } } });
    await gateway.call(globalSettingsWrites, 'apply', {
      neo: { ...stale, autoDispatch: true },
    });
    expect(settings.getGlobalSettings().neo?.front?.enabled).toBe(false);
  });

  it('does not introduce front eligibility through a generic Neo patch', async () => {
    await gateway.call(globalSettingsWrites, 'apply', { neo: { front: { enabled: true } } });
    expect(settings.getGlobalSettings().neo?.front).toBeUndefined();
  });

  it('changes only the switch using the latest Neo settings', async () => {
    settings.updateGlobalSettings({
      neo: {
        packs: ['new-pack'],
        workerPermissionMode: 'default',
        front: { enabled: true, model: { ...preference, thinkingLevel: 'off' } },
      },
    });
    await gateway.call(globalSettingsWrites, 'neoFront', false);
    expect(settings.getGlobalSettings().neo).toMatchObject({
      packs: ['new-pack'],
      workerPermissionMode: 'default',
      front: { enabled: false, model: preference },
    });
    const stale = { neo: { front: { enabled: true } } };
    const commit = await gateway.call(globalSettingsWrites, 'apply', stale);
    await gateway.call(globalSettingsWrites, 'neoFront', true);
    await gateway.call(globalSettingsWrites, 'rollback', commit);
    expect(settings.getGlobalSettings().neo?.front?.enabled).toBe(true);
  });

  it('front model writes preserve concurrent switch, coordinator and permission settings', async () => {
    await gateway.call(globalSettingsWrites, 'neoPreferences', {
      ...preference,
      thinkingLevel: 'off',
    });
    settings.updateGlobalSettings({
      neo: { ...settings.getGlobalSettings().neo, workerPermissionMode: 'default' },
    });
    await Promise.all([
      gateway.call(globalSettingsWrites, 'neoFrontModel', {
        ...preference,
        model: 'front',
        thinkingLevel: 'off',
      }),
      gateway.call(globalSettingsWrites, 'neoFront', false),
      gateway.call(globalSettingsWrites, 'neoRules', { add: ['Keep this rule.'] }),
    ]);
    expect(settings.getGlobalSettings().neo).toMatchObject({
      preferences: preference,
      workerPermissionMode: 'default',
      packs: ['keep-pack'],
      standingRules: ['Keep this rule.'],
      front: { enabled: false, model: { ...preference, model: 'front' } },
    });
  });

  it('retains simultaneous mute and rule edits alongside a UI settings patch', async () => {
    await Promise.all([
      gateway.call(globalSettingsWrites, 'neoMute', 'first', true),
      gateway.call(globalSettingsWrites, 'neoMute', 'second', true),
      gateway.call(globalSettingsWrites, 'neoRules', { add: ['First rule.'] }),
      gateway.call(globalSettingsWrites, 'neoRules', { add: ['Second rule.'] }),
      gateway.call(globalSettingsWrites, 'apply', {
        neo: { autoDispatch: true, packs: ['new-pack'] },
      }),
    ]);
    expect(settings.getGlobalSettings()).toMatchObject({
      autoScroll: false,
      neo: {
        autoDispatch: true,
        packs: ['new-pack'],
        mutedSessions: ['first', 'second'],
        standingRules: ['First rule.', 'Second rule.'],
      },
    });
    await gateway.call(globalSettingsWrites, 'neoMute', 'first', false);
    expect(settings.getGlobalSettings().neo?.mutedSessions).toEqual(['second']);
  });

  it('keeps the latest saved fallback chain when a queued preference omits it', async () => {
    await gateway.call(globalSettingsWrites, 'neoPreferences', {
      ...preference,
      fallbacks: [{ ...preference, model: 'fallback' }],
    });
    const result = await gateway.call(globalSettingsWrites, 'neoPreferences', {
      ...preference,
      model: 'changed',
    });
    expect(result.neo?.preferences).toEqual({
      ...preference,
      model: 'changed',
      fallbacks: [{ ...preference, model: 'fallback' }],
    });
    expect(result.neo).toMatchObject({ autoDispatch: false, packs: ['keep-pack'] });
    await gateway.call(globalSettingsWrites, 'neoPreferences', { ...preference, fallbacks: [] });
    expect(settings.getGlobalSettings().neo?.preferences?.fallbacks).toEqual([]);
  });

  it('refuses missing removals and a twenty-first rule, but allows a replacement', async () => {
    await gateway.call(globalSettingsWrites, 'neoRules', {
      add: Array.from({ length: 20 }, (_, i) => `Rule ${i}`),
    });
    const before = settings.getGlobalSettings();
    expect(
      await gateway.call(globalSettingsWrites, 'neoRules', { remove: ['missing'] })
    ).toMatchObject({ reason: { ok: false } });
    expect(
      await gateway.call(globalSettingsWrites, 'neoRules', { add: ['Another rule'] })
    ).toMatchObject({ reason: { ok: false, reason: expect.stringContaining('At most 20') } });
    expect(settings.getGlobalSettings()).toEqual(before);
    expect(
      await gateway.call(globalSettingsWrites, 'neoRules', {
        remove: ['Rule 0'],
        add: ['Replacement'],
      })
    ).toHaveProperty('value');
    expect(settings.getGlobalSettings().neo?.standingRules).toEqual([
      ...before.neo!.standingRules!.slice(1),
      'Replacement',
    ]);
  });

  it('preserves owner edits when a failed UI request compensates its own fields', async () => {
    const receipt = await gateway.call(globalSettingsWrites, 'apply', {
      neo: { autoDispatch: true, packs: ['temporary'] },
    });
    await gateway.call(globalSettingsWrites, 'neoPreferences', preference);
    await gateway.call(globalSettingsWrites, 'neoMute', 'retained-mute', true);
    await gateway.call(globalSettingsWrites, 'neoRules', { add: ['Retained rule.'] });
    await gateway.call(globalSettingsWrites, 'rollback', receipt);
    expect(settings.getGlobalSettings().neo).toEqual({
      autoDispatch: false,
      packs: ['keep-pack'],
      preferences: preference,
      mutedSessions: ['retained-mute'],
      standingRules: ['Retained rule.'],
    });
  });
});
