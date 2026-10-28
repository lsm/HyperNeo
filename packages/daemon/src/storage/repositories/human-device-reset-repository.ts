import { randomUUID } from 'node:crypto';
import type { Database } from '../sqlite-compat.ts';
import { NeoRepository } from './neo-repository.ts';
import { NeoPublicationRepository } from './neo-publication-repository.ts';
import { reserveNeoConversation } from './neo-conversation-reservation.ts';

export function resetHumanDevices(db: Database, now: number, requestId?: string) {
  return db.transaction(() => {
    const id = requestId ?? randomUUID();
    const devices = db
      .prepare(
        "UPDATE paired_devices SET revoked_at = ? WHERE kind = 'human' AND revoked_at IS NULL RETURNING id, name"
      )
      .all(now) as { id: string; name: string }[];
    db.prepare(
      'UPDATE pairing_codes SET expires_at = MIN(expires_at, ?) WHERE used_at IS NULL'
    ).run(now);
    db.prepare('INSERT INTO human_device_resets (id, reset_at, devices_json) VALUES (?, ?, ?)').run(
      id,
      now,
      JSON.stringify(devices)
    );
    const conversationId = new NeoRepository(db).conversationId() ?? randomUUID();
    reserveNeoConversation(db, conversationId, now);
    const origin = { sessionId: 'daemon:device-recovery', messageId: id };
    const shortText = `Human-device pairing reset at ${new Date(now).toISOString()}. Cleared ${devices.length} active human devices. The next human device may pair without Allow.`;
    for (let start = 0; start < Math.max(devices.length, 1); start += 20) {
      const receipt = new NeoPublicationRepository(db).append({
        conversationId,
        publicationId: randomUUID(),
        askOrigin: origin,
        producerInput: origin,
        shortText,
        fullText: `${shortText}\n\nCleared devices (part ${Math.floor(start / 20) + 1}):\n\n${JSON.stringify(devices.slice(start, start + 20), null, 2)}\n\nRequested through the local CLI. An AI session with local shell access can also invoke this reset; the human accepted that risk.`,
        links: [],
      });
      if (!receipt.accepted) throw new Error(`Recovery notice was not saved: ${receipt.reason}`);
    }
    return { id, resetAt: now, devices, conversationId };
  })();
}
