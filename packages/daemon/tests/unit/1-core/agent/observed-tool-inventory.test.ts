import { describe, expect, it } from 'bun:test';
import { ObservedToolInventory } from '../../../../src/lib/agent/observed-tool-inventory.ts';
import { QueryAttemptRegistry } from '../../../../src/lib/agent/query-attempt-token.ts';

const init = {
  tools: ['Read', 'mcp__browser__navigate', 'Read'],
  skills: ['playwright'],
  plugins: [{ name: 'browser-skill', path: '/private/plugin' }],
  mcp_servers: [{ name: 'browser', status: 'connected' }],
};

describe('ObservedToolInventory', () => {
  it('reports no running query and never treats configuration as observation', () => {
    const inventory = new ObservedToolInventory();
    expect(inventory.snapshot()).toEqual({
      state: 'not_running',
      tools: [],
      skills: [],
      plugins: [],
      mcpServers: [],
    });
    const token = new QueryAttemptRegistry().allocate();
    inventory.begin(token, 'sdk');
    expect(inventory.snapshot().state).toBe('awaiting_init');
    expect(inventory.snapshot().tools).toEqual([]);
  });

  it('projects only observed names, with unknown server tool count until status arrives', () => {
    const inventory = new ObservedToolInventory();
    const token = new QueryAttemptRegistry().allocate();
    inventory.begin(token, 'sdk');
    inventory.captureInit(token, init);
    expect(inventory.snapshot()).toEqual({
      state: 'observed',
      tools: ['Read', 'mcp__browser__navigate'],
      skills: ['playwright'],
      plugins: ['browser-skill'],
      mcpServers: [{ name: 'browser', status: 'connected', tools: null }],
    });
    inventory.captureStatus(token, [
      {
        name: 'browser',
        status: 'connected',
        tools: [{ name: 'navigate', description: 'private description' }],
        config: { url: 'https://example.invalid/?token=secret' },
        error: 'secret diagnostic',
      },
    ]);
    expect(inventory.snapshot().mcpServers).toEqual([
      { name: 'browser', status: 'connected', tools: ['navigate'] },
    ]);
    expect(JSON.stringify(inventory.snapshot())).not.toMatch(/secret|private|description|config/);
  });

  it('refreshes MCP tool names after live replacement while preserving native tools', () => {
    const inventory = new ObservedToolInventory();
    const token = new QueryAttemptRegistry().allocate();
    inventory.begin(token, 'sdk');
    inventory.captureInit(token, init);
    inventory.captureStatus(token, [
      { name: 'selected', status: 'connected', tools: [{ name: 'search' }] },
    ]);
    expect(inventory.snapshot().tools).toEqual(['Read', 'mcp__selected__search']);
    inventory.captureStatus(token, []);
    expect(inventory.snapshot().tools).toEqual(['Read']);
  });

  it('preserves observed names while a server status or tool payload is unverified', () => {
    for (const server of [
      { name: 'browser', status: 'unverified' },
      { name: 'browser', status: 'unverified', tools: [] },
      { name: 'browser', status: 'connected' },
      { name: 'browser', status: 'failed' },
    ]) {
      const inventory = new ObservedToolInventory();
      const token = new QueryAttemptRegistry().allocate();
      inventory.begin(token, 'sdk');
      inventory.captureInit(token, init);
      inventory.captureStatus(token, [server]);
      expect(inventory.snapshot().tools).toEqual(['Read', 'mcp__browser__navigate']);
      expect(inventory.snapshot().mcpServers[0].status).toBe(server.status);
      inventory.captureStatus(token, [{ name: 'browser', status: 'connected', tools: [] }]);
      expect(inventory.snapshot().tools).toEqual(['Read']);
    }
  });

  it('drops historical attachment immediately when the owning attempt is reaped', () => {
    const registry = new QueryAttemptRegistry();
    const inventory = new ObservedToolInventory();
    const token = registry.allocate();
    inventory.begin(token, 'sdk');
    inventory.captureInit(token, init);
    registry.invalidate(token);
    expect(inventory.snapshot().state).toBe('not_running');
    expect(inventory.snapshot().tools).toEqual([]);
    expect(inventory.snapshot().mcpServers).toEqual([]);
  });

  it('ignores delayed init, status and stop from a superseded attempt', () => {
    const registry = new QueryAttemptRegistry();
    const inventory = new ObservedToolInventory();
    const old = registry.allocate();
    inventory.begin(old, 'sdk');
    inventory.captureInit(old, init);
    const current = registry.allocate();
    inventory.begin(current, 'sdk');
    inventory.captureInit(old, init);
    inventory.captureStatus(old, [{ name: 'stale', status: 'connected', tools: [] }]);
    inventory.end(old);
    expect(inventory.snapshot().state).toBe('awaiting_init');
    expect(inventory.snapshot().mcpServers).toEqual([]);
    inventory.captureInit(current, { ...init, tools: ['Write'] });
    expect(inventory.snapshot().tools).toEqual(['Write']);
    inventory.end(current);
    expect(inventory.snapshot().state).toBe('not_running');
  });

  it('never lets a late begin from an invalidated attempt replace the current query', () => {
    const registry = new QueryAttemptRegistry();
    const inventory = new ObservedToolInventory();
    const old = registry.allocate();
    const current = registry.allocate();
    inventory.begin(current, 'sdk');
    inventory.captureInit(current, init);
    inventory.begin(old, 'sdk');
    expect(inventory.snapshot().state).toBe('observed');
  });

  it('does not certify ACP attachments even when init-like data is supplied', () => {
    const inventory = new ObservedToolInventory();
    const token = new QueryAttemptRegistry().allocate();
    inventory.begin(token, 'acp');
    inventory.captureInit(token, init);
    inventory.captureStatus(token, [{ name: 'browser', status: 'connected' }]);
    expect(inventory.snapshot()).toEqual({
      state: 'unverified',
      tools: [],
      skills: [],
      plugins: [],
      mcpServers: [],
    });
  });

  it('distinguishes missing status tools from an explicitly empty tool list', () => {
    const inventory = new ObservedToolInventory();
    const token = new QueryAttemptRegistry().allocate();
    inventory.begin(token, 'sdk');
    inventory.captureInit(token, init);
    inventory.captureStatus(token, [
      { name: 'browser', status: 'connected', tools: [] },
      { name: 'login', status: 'needs-auth' },
      { name: 'future', status: 'new-sdk-state' },
    ]);
    expect(inventory.snapshot().mcpServers).toEqual([
      { name: 'browser', status: 'connected', tools: [] },
      { name: 'login', status: 'needs-auth', tools: null },
      { name: 'future', status: 'unverified', tools: null },
    ]);
  });

  it('keeps observations independent from caller mutations', () => {
    const inventory = new ObservedToolInventory();
    const token = new QueryAttemptRegistry().allocate();
    inventory.begin(token, 'sdk');
    const message = structuredClone(init);
    inventory.captureInit(token, message);
    message.tools.push('injected');
    const first = inventory.snapshot();
    first.tools.push('another');
    first.mcpServers[0].name = 'changed';
    expect(inventory.snapshot().tools).toEqual(['Read', 'mcp__browser__navigate']);
    expect(inventory.snapshot().mcpServers[0].name).toBe('browser');
  });
});
