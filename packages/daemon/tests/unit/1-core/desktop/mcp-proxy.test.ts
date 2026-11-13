import { expect, test, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createDesktopProxy } from '../../../../src/lib/desktop/mcp-proxy.ts';

const binding = {
  todo_id: '10000000-0000-4000-8000-000000000001',
  worker_id: '10000000-0000-4000-8000-000000000002',
  driver_instance_id: '123-456-789',
  target_app_id: null,
};
function fixture(enabled = true) {
  const audit = vi.fn();
  const dispatch = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
  const proxy = createDesktopProxy({
    binding: async () => (enabled ? binding : null),
    dispatch,
    audit,
  });
  return { proxy, audit, dispatch };
}

test('unlisted tool is invisible and refused', async () => {
  const { proxy, audit, dispatch } = fixture();
  const tools = await proxy.list();
  expect(tools).toHaveLength(12);
  expect(tools.map((tool) => tool.name)).not.toContain('run_script');
  for (const name of ['run_script', 'CLICK', 'unknown-sensitive-value']) {
    expect(await proxy.call(name, {})).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'tool_not_allowed' }],
    });
  }
  expect(dispatch).not.toHaveBeenCalled();
  expect(audit).toHaveBeenCalledTimes(3);
  expect(audit.mock.calls.every(([line]) => JSON.parse(line).tool === 'unlisted')).toBe(true);
});

test('tool list under the token budget', async () => {
  const tools = await fixture().proxy.list();
  const serialized = JSON.stringify(tools);
  expect(tools).toHaveLength(12);
  expect(Buffer.byteLength(serialized)).toBe(6055);
  expect(Buffer.byteLength(serialized)).toBeLessThan(8000);
  expect(createHash('sha256').update(serialized).digest('hex')).toBe(
    '3f6e8413b7b464c5c697743684b8adf508544982348033179a89a14dcbc0c0ad'
  );
});

test('audit has no typed values', async () => {
  const { proxy, audit, dispatch } = fixture();
  const secret = 'synthetic-private-value-do-not-record';
  expect(await proxy.call('type_text', { text: secret })).toMatchObject({ isError: true });
  expect(audit).toHaveBeenCalledTimes(1);
  const [line] = audit.mock.calls[0];
  expect(line).not.toContain(secret);
  const record = JSON.parse(line);
  expect(Object.keys(record).sort()).toEqual(
    [
      'call_id',
      'decision',
      'driver_instance_id',
      'duration_ms',
      'reason_code',
      'target_app_id',
      'target_pid',
      'target_window_id',
      'timestamp',
      'todo_id',
      'tool',
      'upstream_dispatched',
      'worker_id',
    ].sort()
  );
  expect(record).toMatchObject({
    todo_id: binding.todo_id,
    worker_id: binding.worker_id,
    tool: 'type_text',
    target_pid: null,
    target_window_id: null,
    decision: 'refused',
    reason_code: 'guards_unavailable',
    upstream_dispatched: false,
  });
  expect(record.timestamp).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
  expect(record.duration_ms).toBeGreaterThanOrEqual(0);
  expect(dispatch).not.toHaveBeenCalled();
});

test('without a recorded opt-in no tools or dispatch are available', async () => {
  const { proxy, dispatch, audit } = fixture(false);
  expect(await proxy.list()).toEqual([]);
  expect(await proxy.call('list_windows', {})).toMatchObject({
    isError: true,
    content: [{ type: 'text', text: 'desktop_not_opted_in' }],
  });
  expect(dispatch).not.toHaveBeenCalled();
  expect(JSON.parse(audit.mock.calls[0][0]).worker_id).toBeNull();
});

test('schemas and session binding refuse before dispatch', async () => {
  const dispatch = vi.fn();
  const proxy = createDesktopProxy({
    binding: async () => binding,
    dispatch,
    audit: () => {},
    authorize: async () => ({ pid: 42, window_id: 7 }),
  });
  for (const args of [{ private_field: true }, { pid: '42' }, { session: 'other-worker' }])
    expect(await proxy.call('list_windows', args)).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'invalid_arguments' }],
    });
  expect(dispatch).not.toHaveBeenCalled();
});
