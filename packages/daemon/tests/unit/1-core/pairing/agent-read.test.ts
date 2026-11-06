import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createAgentReadGuard } from '../../../../src/lib/pairing/agent-read.ts';
import { runMigration481 } from '../../../../src/storage/schema/m481-agent-devices.ts';
import { runMigrations } from '../../../../src/storage/schema/migrations.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';

function legacy(db = new Database(':memory:')) {
  db.exec(`CREATE TABLE paired_devices (id TEXT PRIMARY KEY, name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('human', 'relay', 'daemon')), secret_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL, last_seen_at INTEGER, last_seen_host TEXT, revoked_at INTEGER);
    CREATE TABLE pairing_codes (id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('human', 'relay', 'daemon')), name TEXT,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, approved_at INTEGER, used_at INTEGER);
    INSERT INTO paired_devices VALUES ('phone','Phone','human','original-hash',1,2,'host',3);
    INSERT INTO pairing_codes VALUES ('code','code-hash','relay','Relay',1,9,NULL,NULL);`);
  return db;
}

describe('runMigration481', () => {
  test('retains credentials, revocation and pending codes while enabling agent devices', () => {
    const db = legacy();
    try {
      const devices = db.prepare('SELECT * FROM paired_devices').all();
      const codes = db.prepare('SELECT * FROM pairing_codes').all();
      runMigration481(db);
      runMigration481(db);
      expect(db.prepare('SELECT * FROM paired_devices').all()).toEqual(devices);
      expect(db.prepare('SELECT * FROM pairing_codes').all()).toEqual(codes);
      db.exec(
        "INSERT INTO paired_devices VALUES ('reader','Reader','agent','new-hash',1,NULL,NULL,NULL)"
      );
      db.exec(
        "INSERT INTO pairing_codes VALUES ('agent-code','new-code','agent',NULL,1,9,NULL,NULL)"
      );
      expect(() =>
        db.exec("UPDATE paired_devices SET kind='administrator' WHERE id='reader'")
      ).toThrow();
      expect(() =>
        db.exec("UPDATE pairing_codes SET kind='administrator' WHERE id='agent-code'")
      ).toThrow();
    } finally {
      db.close();
    }
  });
});

describe('agent migration registry', () => {
  test('upgrades devices after the work-session migration has already completed', () => {
    const db = new Database(':memory:');
    try {
      runMigrations(db, () => {});
      db.exec(`DROP TABLE paired_devices; DROP TABLE pairing_codes;
        DELETE FROM migration_markers WHERE key = 'migration_481';
        INSERT INTO work_sessions (adapter, id, name, status, updated_at, last_activity_at)
        VALUES ('synthetic', 'worker', 'Worker', 'idle', 1, 7);`);
      legacy(db);
      runMigrations(db, () => {});
      db.exec(
        "INSERT INTO paired_devices VALUES ('reader','Reader','agent','new-hash',1,NULL,NULL,NULL)"
      );
      expect(db.prepare("SELECT revoked_at FROM paired_devices WHERE id='phone'").get()).toEqual({
        revoked_at: 3,
      });
      expect(db.prepare("SELECT id FROM pairing_codes WHERE id='code'").get()).toEqual({
        id: 'code',
      });
      expect(
        db.prepare("SELECT status, last_activity_at FROM work_sessions WHERE id='worker'").get()
      ).toEqual({
        status: 'idle',
        last_activity_at: 7,
      });
    } finally {
      db.close();
    }
  });
});

describe('createAgentReadGuard', () => {
  test('refuses other routes even for revoked agent credentials before public handlers', async () => {
    const db = legacy();
    runMigration481(db);
    const credential = 'a'.repeat(43);
    db.prepare("INSERT INTO paired_devices VALUES ('reader','Reader','agent',?,1,NULL,NULL,2)").run(
      createHash('sha256').update(credential).digest('hex')
    );
    const gateway = new DbGateway(':memory:', db);
    const guard = createAgentReadGuard(() => gateway);
    try {
      for (const path of ['/ws', '/', '/pair', '/hello', '/neo-peer/pair', '/external-hook']) {
        expect(
          (
            await guard(
              new Request(`http://localhost${path}`, {
                headers: { authorization: `Bearer ${credential}` },
              })
            )
          )?.status
        ).toBe(401);
      }
      expect(
        await guard(
          new Request('http://localhost/ask/card.md', {
            headers: { cookie: `hyperneo_device=${credential}` },
          })
        )
      ).toBeNull();
      expect(await guard(new Request('http://localhost/'))).toBeNull();
    } finally {
      db.close();
    }
  });

  test('cannot fall through to a public handler when device classification fails', async () => {
    const guard = createAgentReadGuard(
      () =>
        ({
          run: async () => {
            throw new Error('database unavailable');
          },
        }) as unknown as DbGateway
    );
    await expect(
      guard(new Request('http://localhost/', { headers: { authorization: 'Bearer credential' } }))
    ).rejects.toThrow('database unavailable');
  });
});
