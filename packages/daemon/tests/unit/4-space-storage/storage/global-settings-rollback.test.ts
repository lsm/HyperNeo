import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { DbGateway } from '../../../../src/storage/db-gateway/db-gateway';
import { SettingsRepository } from '../../../../src/storage/repositories/settings-repository';
import { globalSettingsWrites } from '../../../../src/storage/repositories/global-settings-writes';

describe('Global settings compensation ownership', () => {
  let db: Database;
  let gateway: DbGateway;
  let settings: SettingsRepository;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(
      'CREATE TABLE global_settings (id INTEGER PRIMARY KEY, settings TEXT NOT NULL, updated_at TEXT NOT NULL)'
    );
    gateway = new DbGateway(':memory:', db);
    settings = new SettingsRepository(db);
  });
  afterEach(async () => {
    await gateway.close();
    db.close();
  });

  it('restores only request-owned fields and retains unrelated commits', async () => {
    settings.updateGlobalSettings({ showArchived: true, autoScroll: true });
    const receipt = await gateway.call(globalSettingsWrites, 'apply', { showArchived: false });
    settings.updateGlobalSettings({ autoScroll: false, neo: { standingRules: ['later rule'] } });
    await gateway.call(globalSettingsWrites, 'rollback', receipt);
    expect(settings.getGlobalSettings()).toMatchObject({
      showArchived: true,
      autoScroll: false,
      neo: { standingRules: ['later rule'] },
    });
    expect(Object.keys(receipt.before)).toEqual(['showArchived']);
    expect(Object.keys(receipt.after)).toEqual(['showArchived']);
  });

  it('does not overwrite a later edit to the same field', async () => {
    settings.updateGlobalSettings({ outputStyle: 'before' });
    const receipt = await gateway.call(globalSettingsWrites, 'apply', {
      outputStyle: 'failed request',
    });
    settings.updateGlobalSettings({ outputStyle: 'later writer' });
    await gateway.call(globalSettingsWrites, 'rollback', receipt);
    expect(settings.getGlobalSettings().outputStyle).toBe('later writer');
  });

  it('captures the before-image inside the queued writer transaction', async () => {
    settings.updateGlobalSettings({ outputStyle: 'early' });
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = gateway.run.bind(gateway);
    gateway.run = async (op, args) => {
      await hold;
      return run(op, args);
    };
    const pending = gateway.call(globalSettingsWrites, 'apply', { outputStyle: 'failed request' });
    settings.updateGlobalSettings({ outputStyle: 'committed while queued' });
    release();
    const receipt = await pending;
    expect(receipt.before.outputStyle).toBe('committed while queued');
    await gateway.call(globalSettingsWrites, 'rollback', receipt);
    expect(settings.getGlobalSettings().outputStyle).toBe('committed while queued');
  });

  it('reverts Neo UI fields while preserving newer Neo-owned values', async () => {
    settings.updateGlobalSettings({ neo: { autoDispatch: true, standingRules: ['before'] } });
    const receipt = await gateway.call(globalSettingsWrites, 'apply', {
      neo: { autoDispatch: false },
    });
    settings.updateGlobalSettings({ neo: { autoDispatch: false, standingRules: ['after'] } });
    await gateway.call(globalSettingsWrites, 'rollback', receipt);
    expect(settings.getGlobalSettings().neo).toEqual({
      autoDispatch: true,
      standingRules: ['after'],
    });
  });

  it('retains a newly introduced Neo-owned field when removing a failed Neo patch', async () => {
    const receipt = await gateway.call(globalSettingsWrites, 'apply', {
      neo: { autoDispatch: false },
    });
    settings.updateGlobalSettings({ neo: { standingRules: ['after'], autoDispatch: false } });
    await gateway.call(globalSettingsWrites, 'rollback', receipt);
    expect(settings.getGlobalSettings().neo).toEqual({ standingRules: ['after'] });
  });

  it('preserves a newer Neo UI edit instead of restoring a stale subtree', async () => {
    settings.updateGlobalSettings({ neo: { packs: ['before'] } });
    const receipt = await gateway.call(globalSettingsWrites, 'apply', {
      neo: { packs: ['failed'] },
    });
    settings.updateGlobalSettings({ neo: { packs: ['later'], mutedSessions: ['new-muted'] } });
    await gateway.call(globalSettingsWrites, 'rollback', receipt);
    expect(settings.getGlobalSettings().neo).toEqual({
      packs: ['later'],
      mutedSessions: ['new-muted'],
    });
  });

  it('can compensate an omitted optional value', async () => {
    settings.updateGlobalSettings({ outputStyle: 'before' });
    const receipt = await gateway.call(globalSettingsWrites, 'apply', { outputStyle: undefined });
    await gateway.call(globalSettingsWrites, 'rollback', receipt);
    expect(settings.getGlobalSettings().outputStyle).toBe('before');
  });
});
