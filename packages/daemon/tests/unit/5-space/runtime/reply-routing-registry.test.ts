import { describe, expect, test } from 'bun:test';
import { ReplyRoutingRegistry } from '../../../../src/lib/space/runtime/reply-routing-registry.ts';

describe('ReplyRoutingRegistry', () => {
  test('returns null when no entry exists', () => {
    const registry = new ReplyRoutingRegistry();
    expect(registry.get('task-1')).toBeNull();
    expect(registry.get('task-1', 'coder')).toBeNull();
  });

  test('stores and retrieves replyToSessionId by taskId', () => {
    const registry = new ReplyRoutingRegistry();
    registry.set('task-1', 'session-adhoc-1');
    expect(registry.get('task-1')).toBe('session-adhoc-1');
  });

  test('stores and retrieves replyToSessionId by taskId + agentName', () => {
    const registry = new ReplyRoutingRegistry();
    registry.set('task-1', 'session-adhoc-1', 'coder');
    expect(registry.get('task-1', 'coder')).toBe('session-adhoc-1');
    expect(registry.get('task-1')).toBeNull();
  });

  test('overwrites previous entry for same key', () => {
    const registry = new ReplyRoutingRegistry();
    registry.set('task-1', 'session-adhoc-1');
    registry.set('task-1', 'session-adhoc-2');
    expect(registry.get('task-1')).toBe('session-adhoc-2');
  });

  test('deleteByTask removes all entries for a task', () => {
    const registry = new ReplyRoutingRegistry();
    registry.set('task-1', 'session-a');
    registry.set('task-1', 'session-b', 'coder');
    registry.set('task-1', 'session-c', 'reviewer');
    registry.set('task-2', 'session-d');

    registry.deleteByTask('task-1');

    expect(registry.get('task-1')).toBeNull();
    expect(registry.get('task-1', 'coder')).toBeNull();
    expect(registry.get('task-1', 'reviewer')).toBeNull();
    expect(registry.get('task-2')).toBe('session-d');
  });

  test('delete removes a specific entry', () => {
    const registry = new ReplyRoutingRegistry();
    registry.set('task-1', 'session-a');
    registry.set('task-1', 'session-b', 'coder');

    registry.delete('task-1', 'coder');

    expect(registry.get('task-1')).toBe('session-a');
    expect(registry.get('task-1', 'coder')).toBeNull();
  });

  test('expired entries return null', async () => {
    const registry = new ReplyRoutingRegistry(100);
    registry.set('task-1', 'session-adhoc-1');

    expect(registry.get('task-1')).toBe('session-adhoc-1');

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(registry.get('task-1')).toBeNull();
  });

  test('size reports correct count', () => {
    const registry = new ReplyRoutingRegistry();
    expect(registry.size).toBe(0);
    registry.set('task-1', 'session-a');
    expect(registry.size).toBe(1);
    registry.set('task-1', 'session-b', 'coder');
    expect(registry.size).toBe(2);
    registry.deleteByTask('task-1');
    expect(registry.size).toBe(0);
  });

  test('purgeExpired removes stale entries without requiring get()', async () => {
    const registry = new ReplyRoutingRegistry(100);
    registry.set('task-1', 'session-a');
    registry.set('task-2', 'session-b');
    expect(registry.size).toBe(2);

    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(registry.size).toBe(2);

    registry.purgeExpired();
    expect(registry.size).toBe(0);
    expect(registry.get('task-1')).toBeNull();
    expect(registry.get('task-2')).toBeNull();
  });
});
