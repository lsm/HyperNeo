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
    db.exec('CREATE TABLE global_settings (id INTEGER PRIMARY KEY, settings TEXT NOT NULL, updated_at TEXT NOT NULL)');
    gateway = new DbGateway(':memory:', db);
    settings = new SettingsRepository(db);
    settings.updateGlobalSettings({ autoScroll: false, neo: { autoDispatch: false, packs: ['keep-pack'] } });
  });
  afterEach(async () => { await gateway.close(); db.close(); });

  it('retains simultaneous mute and rule edits alongside a UI settings patch', async () => {
    await Promise.all([
      gateway.call(globalSettingsWrites, 'neoMute', 'first', true),
      gateway.call(globalSettingsWrites, 'neoMute', 'second', true),
      gateway.call(globalSettingsWrites, 'neoRules', { add: ['First rule.'] }),
      gateway.call(globalSettingsWrites, 'neoRules', { add: ['Second rule.'] }),
      gateway.call(globalSettingsWrites, 'apply', { neo: { autoDispatch: true, packs: ['new-pack'] } }),
    ]);
    expect(settings.getGlobalSettings()).toMatchObject({
      autoScroll: false,
      neo: { autoDispatch: true, packs: ['new-pack'], mutedSessions: ['first', 'second'], standingRules: ['First rule.', 'Second rule.'] },
    });
    await gateway.call(globalSettingsWrites, 'neoMute', 'first', false);
    expect(settings.getGlobalSettings().neo?.mutedSessions).toEqual(['second']);
  });

  it('keeps the latest saved fallback chain when a queued preference omits it', async () => {
    await gateway.call(globalSettingsWrites, 'neoPreferences', { ...preference, fallbacks: [{ ...preference, model: 'fallback' }] });
    const result = await gateway.call(globalSettingsWrites, 'neoPreferences', { ...preference, model: 'changed' });
    expect(result.neo?.preferences).toEqual({ ...preference, model: 'changed', fallbacks: [{ ...preference, model: 'fallback' }] });
    expect(result.neo).toMatchObject({ autoDispatch: false, packs: ['keep-pack'] });
    await gateway.call(globalSettingsWrites, 'neoPreferences', { ...preference, fallbacks: [] });
    expect(settings.getGlobalSettings().neo?.preferences?.fallbacks).toEqual([]);
  });

  it('refuses a missing removal or a rule-cap overflow without changing settings', async () => {
    await gateway.call(globalSettingsWrites, 'neoRules', { add: Array.from({ length: 20 }, (_, i) => `Rule ${i}`) });
    const before = settings.getGlobalSettings();
    expect(await gateway.call(globalSettingsWrites, 'neoRules', { remove: ['missing'] })).toMatchObject({ reason: { ok: false } });
    expect(await gateway.call(globalSettingsWrites, 'neoRules', { add: ['Overflow'] })).toMatchObject({ reason: { ok: false } });
    expect(settings.getGlobalSettings()).toEqual(before);
    expect(await gateway.call(globalSettingsWrites, 'neoRules', { remove: ['Rule 0'], add: ['Replacement'] })).toHaveProperty('value');
    expect(settings.getGlobalSettings().neo?.standingRules).toEqual([...before.neo!.standingRules!.slice(1), 'Replacement']);
  });

  it('preserves owner edits when a failed UI request compensates its own fields', async () => {
    const receipt = await gateway.call(globalSettingsWrites, 'apply', { neo: { autoDispatch: true, packs: ['temporary'] } });
    await gateway.call(globalSettingsWrites, 'neoPreferences', preference);
    await gateway.call(globalSettingsWrites, 'neoMute', 'retained-mute', true);
    await gateway.call(globalSettingsWrites, 'neoRules', { add: ['Retained rule.'] });
    await gateway.call(globalSettingsWrites, 'rollback', receipt);
    expect(settings.getGlobalSettings().neo).toEqual({ autoDispatch: false, packs: ['keep-pack'], preferences: preference, mutedSessions: ['retained-mute'], standingRules: ['Retained rule.'] });
  });
});
