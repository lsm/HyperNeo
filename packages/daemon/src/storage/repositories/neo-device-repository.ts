import type { Database } from '../sqlite-compat.ts';

export type NeoPushKind = 'needsYou' | 'done' | 'activity';

export interface NeoDevice {
  deviceId: string;
  apnsToken: string;
  environment: 'sandbox' | 'production';
  bundleId: string;
  pushToStartToken: string | null;
  kinds: NeoPushKind[];
}

export interface NeoLiveActivity {
  activityId: string;
  deviceId: string;
  pushToken: string;
}

type StoredDevice = Omit<NeoDevice, 'kinds'> & { kindsJson: string };

const deviceColumns =
  'device_id AS deviceId, apns_token AS apnsToken, environment, bundle_id AS bundleId, push_to_start_token AS pushToStartToken, kinds_json AS kindsJson';

export class NeoDeviceRepository {
  constructor(private readonly db: Database) {}

  get(deviceId: string): NeoDevice | null {
    const row = this.db
      .prepare(`SELECT ${deviceColumns} FROM neo_devices WHERE device_id = ?`)
      .get(deviceId) as StoredDevice | undefined;
    if (!row) return null;
    const { kindsJson, ...rest } = row;
    return { ...rest, kinds: JSON.parse(kindsJson) as NeoPushKind[] };
  }

  register(device: NeoDevice, at: number): NeoDevice | null {
    this.db.transaction(() => {
      this.db
        .prepare('DELETE FROM neo_devices WHERE apns_token = ? AND device_id != ?')
        .run(device.apnsToken, device.deviceId);
      this.db
        .prepare(
          `INSERT INTO neo_devices(device_id, apns_token, environment, bundle_id, push_to_start_token, kinds_json, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(device_id) DO UPDATE SET
             apns_token = excluded.apns_token, environment = excluded.environment,
             bundle_id = excluded.bundle_id, push_to_start_token = excluded.push_to_start_token,
             kinds_json = excluded.kinds_json, updated_at = excluded.updated_at`
        )
        .run(
          device.deviceId,
          device.apnsToken,
          device.environment,
          device.bundleId,
          device.pushToStartToken,
          JSON.stringify(device.kinds),
          at
        );
    })();
    return this.get(device.deviceId);
  }

  unregister(deviceId: string): boolean {
    return this.db.transaction(() => {
      this.db.prepare('DELETE FROM neo_live_activities WHERE device_id = ?').run(deviceId);
      return (
        this.db.prepare('DELETE FROM neo_devices WHERE device_id = ?').run(deviceId).changes > 0
      );
    })();
  }

  registerActivity(activity: NeoLiveActivity, at: number): void {
    this.db
      .prepare(
        `INSERT INTO neo_live_activities(activity_id, device_id, push_token, updated_at)
           VALUES (?, ?, ?, ?)
         ON CONFLICT(activity_id) DO UPDATE SET
           device_id = excluded.device_id, push_token = excluded.push_token,
           updated_at = excluded.updated_at`
      )
      .run(activity.activityId, activity.deviceId, activity.pushToken, at);
  }

  unregisterActivity(deviceId: string, activityId: string): boolean {
    return (
      this.db
        .prepare('DELETE FROM neo_live_activities WHERE device_id = ? AND activity_id = ?')
        .run(deviceId, activityId).changes > 0
    );
  }
}
