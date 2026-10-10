import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from '../../../../src/storage';
import { createReactiveDatabase } from '../../../../src/storage/reactive-database';
import type { Session } from '@hyperneo/shared';

describe('Database.countHumanSessions', () => {
  let db: Database;

  const session = (id: string, overrides: Partial<Session> = {}): Session => {
    const now = new Date().toISOString();
    return {
      id,
      title: id,
      workspacePath: '/workspace',
      createdAt: now,
      lastActiveAt: now,
      status: 'active',
      config: { model: 'claude-sonnet-4-5-20250929', maxTokens: 4096, temperature: 0.7 },
      metadata: {
        messageCount: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalCost: 0,
        toolCallCount: 0,
      },
      ...overrides,
    } as Session;
  };

  beforeEach(async () => {
    db = new Database(':memory:');
    await db.initialize(createReactiveDatabase(db));
  });

  it('matches the archived-inclusive session list across session kinds', () => {
    db.createSession(session('plain'));
    db.createSession(session('archived', { status: 'archived' }));
    db.createSession(session('general', { type: 'general' }));
    db.createSession(session('lobby', { type: 'lobby' }));
    db.createSession(
      session('space-chat', { type: 'space_chat', context: { spaceId: 'space-1' } })
    );
    db.createSession(session('space-worker', { context: { spaceId: 'space-1' } }));
    db.createSession(session('room-worker', { context: { roomId: 'room-1' } }));

    expect(db.countHumanSessions()).toBe(3);
    expect(db.countHumanSessions()).toBe(db.listSessions({ includeArchived: true }).length);
  });

  it('tracks archive and context changes', () => {
    db.createSession(session('a'));
    db.createSession(session('b'));
    db.updateSession('a', { status: 'archived' });
    db.updateSession('b', { context: { spaceId: 'space-1' } });

    expect(db.countHumanSessions()).toBe(1);
    expect(db.countHumanSessions()).toBe(db.listSessions({ includeArchived: true }).length);

    db.deleteSession('a');

    expect(db.countHumanSessions()).toBe(0);
  });
});
