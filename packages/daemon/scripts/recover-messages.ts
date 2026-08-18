#!/usr/bin/env bun

import { readFileSync } from 'fs';
import { Database } from '../src/storage/sqlite-compat';
import { SDKMessageRepository } from '../src/storage/repositories/sdk-message-repository';

const dbPath = process.argv[2];

if (!dbPath) {
  console.error('Usage: bun recover-messages.ts <db-path>');
  console.error('Example: bun recover-messages.ts ./tmp/self-dev/daemon.db');
  process.exit(1);
}

console.log(`\n🔍 Recovering messages from: ${dbPath}\n`);

console.log('Step 1: Scanning raw database for message remnants...');

const raw = readFileSync(dbPath);
const content = raw.toString('utf8', 0, raw.length);

interface RecoveredMessage {
  type: string;
  uuid: string;
  sdk_session_id?: string;
  raw: string;
}

const messages: RecoveredMessage[] = [];
const seen = new Set<string>();

let pos = 0;
while (pos < raw.length) {
  const idx = content.indexOf('{"type":"', pos);
  if (idx === -1) break;

  let depth = 0;
  const start = idx;
  let end = idx;

  for (let i = idx; i < Math.min(idx + 100000, raw.length); i++) {
    const char = content[i];
    if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }

  if (end > start && depth === 0) {
    const jsonStr = content.slice(start, end);
    try {
      const obj = JSON.parse(jsonStr);
      if (obj.type && obj.uuid && !seen.has(obj.uuid)) {
        seen.add(obj.uuid);
        messages.push({
          type: obj.type,
          uuid: obj.uuid,
          sdk_session_id: obj.session_id,
          raw: jsonStr,
        });
      }
    } catch {
      // Invalid JSON, skip
    }
  }

  pos = idx + 1;
}

console.log(`   Found ${messages.length} unique messages`);

console.log('\nStep 2: Building session mappings...');

const db = new Database(dbPath);

const sdkToKai = new Map<string, string>();
const sessions = db.query('SELECT id, sdk_session_id FROM sessions').all() as {
  id: string;
  sdk_session_id: string | null;
}[];

for (const s of sessions) {
  if (s.sdk_session_id) {
    sdkToKai.set(s.sdk_session_id, s.id);
  }
}

const existingSessionIds = new Set(sessions.map((s) => s.id));
const existingMessageIds = new Set(
  db
    .query('SELECT id FROM sdk_messages')
    .all()
    .map((r: unknown) => (r as { id: string }).id)
);

console.log(`   Existing sessions: ${existingSessionIds.size}`);
console.log(`   SDK→HyperNeo mappings: ${sdkToKai.size}`);
console.log(`   Existing messages: ${existingMessageIds.size}`);

console.log('\nStep 3: Resolving message ownership...');

const messagesByKaiSession = new Map<string, RecoveredMessage[]>();
const orphanMessages: RecoveredMessage[] = [];

for (const msg of messages) {
  if (!msg.sdk_session_id) {
    orphanMessages.push(msg);
    continue;
  }

  const kaiSessionId = sdkToKai.get(msg.sdk_session_id);

  if (kaiSessionId) {
    if (!messagesByKaiSession.has(kaiSessionId)) {
      messagesByKaiSession.set(kaiSessionId, []);
    }
    messagesByKaiSession.get(kaiSessionId)!.push(msg);
  } else {
    orphanMessages.push(msg);
  }
}

console.log(`   Messages matched to existing sessions: ${messages.length - orphanMessages.length}`);
console.log(`   Orphan messages (no session found): ${orphanMessages.length}`);

console.log('\nStep 4: Restoring messages to existing sessions...');

const insertMessage = db.prepare(`
  INSERT OR IGNORE INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp)
  VALUES (?, ?, ?, ?, ?, ?)
`);

let messagesInserted = 0;
const touchedSessions = new Set<string>();

for (const [kaiSessionId, msgs] of messagesByKaiSession.entries()) {
  touchedSessions.add(kaiSessionId);
  for (const msg of msgs) {
    if (existingMessageIds.has(msg.uuid)) continue;

    try {
      const parsed = JSON.parse(msg.raw);
      const result = insertMessage.run(
        msg.uuid,
        kaiSessionId,
        msg.type,
        parsed.subtype || null,
        msg.raw,
        new Date().toISOString()
      );
      if (result.changes > 0) messagesInserted++;
    } catch {
      // Skip insert errors
    }
  }
}

console.log(`   Messages restored to existing sessions: ${messagesInserted}`);

console.log('\nStep 5: Handling orphan messages...');

const orphansBySDKSession = new Map<string, RecoveredMessage[]>();
for (const msg of orphanMessages) {
  const key = msg.sdk_session_id || 'unknown';
  if (!orphansBySDKSession.has(key)) {
    orphansBySDKSession.set(key, []);
  }
  orphansBySDKSession.get(key)!.push(msg);
}

const insertSession = db.prepare(`
  INSERT INTO sessions (
    id, title, workspace_path, created_at, last_active_at, status,
    config, metadata, is_worktree, worktree_path, main_repo_path,
    worktree_branch, git_branch, sdk_session_id, available_commands,
    processing_state, archived_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

let orphanSessionsCreated = 0;
let orphanMessagesInserted = 0;

for (const [sdkSessionId, msgs] of orphansBySDKSession.entries()) {
  if (sdkSessionId === 'unknown' || msgs.length === 0) continue;

  let workspacePath = '/tmp/recovered';
  let title = 'Recovered Session';

  for (const msg of msgs) {
    try {
      const parsed = JSON.parse(msg.raw);

      if (parsed.type === 'system' && parsed.subtype === 'init' && parsed.cwd) {
        workspacePath = parsed.cwd;
      }

      if (parsed.type === 'user' && title === 'Recovered Session') {
        const msgContent = parsed.message?.content;
        let text = '';
        if (typeof msgContent === 'string') {
          text = msgContent;
        } else if (Array.isArray(msgContent)) {
          const textBlock = msgContent.find(
            (b: unknown) => (b as { type: string }).type === 'text'
          );
          if (textBlock) text = (textBlock as { text: string }).text;
        }
        if (text) {
          title = text.slice(0, 50).replace(/\n/g, ' ').trim();
          if (text.length > 50) title += '...';
        }
      }
    } catch {
      // Skip parse errors
    }
  }

  const newSessionId = crypto.randomUUID();

  try {
    const config = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      maxTokens: 16000,
      temperature: 1,
    });
    const metadata = JSON.stringify({
      messageCount: msgs.length,
      recovered: true,
      recoveredAt: new Date().toISOString(),
    });
    const now = new Date().toISOString();

    insertSession.run(
      newSessionId,
      title,
      workspacePath,
      now,
      now,
      'active',
      config,
      metadata,
      0,
      null,
      null,
      null,
      null,
      sdkSessionId,
      null,
      null,
      null
    );
    orphanSessionsCreated++;
    touchedSessions.add(newSessionId);

    for (const msg of msgs) {
      try {
        const parsed = JSON.parse(msg.raw);
        const result = insertMessage.run(
          msg.uuid,
          newSessionId,
          msg.type,
          parsed.subtype || null,
          msg.raw,
          new Date().toISOString()
        );
        if (result.changes > 0) orphanMessagesInserted++;
      } catch {
        // Skip insert errors
      }
    }
  } catch (e) {
    console.error(`   Failed to create orphan session:`, e);
  }
}

console.log(`   Orphan sessions created: ${orphanSessionsCreated}`);
console.log(`   Orphan messages restored: ${orphanMessagesInserted}`);

console.log('\nStep 6: Recomputing visible_message_count for recovered sessions...');
const recoverRepo = new SDKMessageRepository(db);
let recomputed = 0;
for (const sid of touchedSessions) {
  try {
    recoverRepo.recomputeVisibleMessageCount(sid);
    recomputed++;
  } catch {
    // Skip recompute errors
  }
}
console.log(`   Recomputed ${recomputed} session(s)`);

const finalSessions = db.query('SELECT COUNT(*) as count FROM sessions').get() as { count: number };
const finalMessages = db.query('SELECT COUNT(*) as count FROM sdk_messages').get() as {
  count: number;
};

console.log('\n✅ Recovery complete!');
console.log(`   Total sessions: ${finalSessions.count}`);
console.log(`   Total messages: ${finalMessages.count}`);

db.close();
