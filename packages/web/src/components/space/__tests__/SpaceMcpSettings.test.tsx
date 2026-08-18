import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/preact';
import type { SpaceMcpEntry } from '@hyperneo/shared';

const mockEntriesMap = vi.hoisted(() => new Map<string, SpaceMcpEntry>());
const mockSubscribe = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockUnsubscribe = vi.hoisted(() => vi.fn());

const mockHubRequest = vi.hoisted(() => vi.fn().mockResolvedValue({ ok: true }));
const mockGetHubIfConnected = vi.hoisted(() =>
  vi.fn(() => ({
    request: mockHubRequest,
  }))
);

const mockToastSuccess = vi.hoisted(() => vi.fn());
const mockToastError = vi.hoisted(() => vi.fn());
const mockToastInfo = vi.hoisted(() => vi.fn());

vi.mock('../../../lib/space-mcp-store.ts', () => ({
  spaceMcpStore: {
    entries: { value: mockEntriesMap, subscribe: vi.fn() },
    loading: { value: false, subscribe: vi.fn() },
    error: { value: null, subscribe: vi.fn() },
    subscribe: mockSubscribe,
    unsubscribe: mockUnsubscribe,
  },
}));

vi.mock('../../../lib/connection-manager.ts', () => ({
  connectionManager: {
    getHubIfConnected: mockGetHubIfConnected,
  },
}));

vi.mock('../../../lib/toast.ts', () => ({
  toast: {
    success: mockToastSuccess,
    error: mockToastError,
    info: mockToastInfo,
  },
}));

import { SpaceMcpSettings } from '../SpaceMcpSettings';

function makeEntry(name: string, overrides: Partial<SpaceMcpEntry> = {}): SpaceMcpEntry {
  return {
    serverId: `srv-${name}`,
    name,
    sourceType: 'stdio',
    source: 'user',
    globallyEnabled: true,
    overridden: false,
    enabled: true,
    ...overrides,
  };
}

function setEntries(entries: SpaceMcpEntry[]): void {
  mockEntriesMap.clear();
  for (const e of entries) mockEntriesMap.set(e.serverId, e);
}

describe('SpaceMcpSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEntriesMap.clear();
    mockHubRequest.mockResolvedValue({ ok: true });
    mockGetHubIfConnected.mockReturnValue({ request: mockHubRequest });
  });

  afterEach(() => {
    cleanup();
  });

  it('subscribes to the store on mount with the given spaceId', () => {
    render(<SpaceMcpSettings spaceId="space-1" />);
    expect(mockSubscribe).toHaveBeenCalledWith('space-1');
  });

  it('renders grouped entries with group labels', () => {
    setEntries([
      makeEntry('alpha', { source: 'user' }),
      makeEntry('bravo', { source: 'builtin' }),
      makeEntry('charlie', {
        source: 'imported',
        sourcePath: '/repo/.mcp.json',
      }),
    ]);

    const { container } = render(<SpaceMcpSettings spaceId="space-1" />);

    expect(container.textContent).toContain('Built-in');
    expect(container.textContent).toContain('Added in HyperNeo');
    expect(container.textContent).toContain('Imported from .mcp.json');
    expect(container.textContent).toContain('alpha');
    expect(container.textContent).toContain('bravo');
    expect(container.textContent).toContain('charlie');
  });

  it('shows sourcePath text for imported entries', () => {
    setEntries([
      makeEntry('imp', {
        source: 'imported',
        sourcePath: '/repo/.mcp.json',
      }),
    ]);
    const { container } = render(<SpaceMcpSettings spaceId="space-1" />);
    expect(container.textContent).toContain('/repo/.mcp.json');
  });

  it('renders the "space override" badge only for overridden entries', () => {
    setEntries([makeEntry('plain'), makeEntry('overridden', { overridden: true, enabled: false })]);
    const { container } = render(<SpaceMcpSettings spaceId="space-1" />);
    const text = container.textContent ?? '';
    expect((text.match(/space override/g) ?? []).length).toBe(1);
  });

  it('shows "disabled globally" when global is false and no override', () => {
    setEntries([makeEntry('off', { globallyEnabled: false, enabled: false })]);
    const { container } = render(<SpaceMcpSettings spaceId="space-1" />);
    expect(container.textContent).toContain('disabled globally');
  });

  it('toggles a server — calls space.mcp.setEnabled with inverse value', async () => {
    setEntries([makeEntry('alpha', { enabled: true })]);
    const { getByTestId } = render(<SpaceMcpSettings spaceId="space-1" />);
    const toggle = getByTestId('space-mcp-toggle-alpha') as HTMLInputElement;

    fireEvent.change(toggle);

    await waitFor(() => {
      expect(mockHubRequest).toHaveBeenCalledWith('space.mcp.setEnabled', {
        spaceId: 'space-1',
        serverId: 'srv-alpha',
        enabled: false,
      });
    });
  });

  it('reset button calls space.mcp.clearOverride for overridden entry', async () => {
    setEntries([makeEntry('reset-me', { overridden: true, enabled: false })]);
    const { getByTestId } = render(<SpaceMcpSettings spaceId="space-1" />);
    const btn = getByTestId('space-mcp-reset-reset-me') as HTMLButtonElement;

    fireEvent.click(btn);

    await waitFor(() => {
      expect(mockHubRequest).toHaveBeenCalledWith('space.mcp.clearOverride', {
        spaceId: 'space-1',
        serverId: 'srv-reset-me',
      });
    });
    expect(mockToastSuccess).toHaveBeenCalled();
  });

  it('refresh imports calls mcp.imports.refresh and toasts a summary', async () => {
    mockHubRequest.mockResolvedValueOnce({ ok: true, imported: 2, removed: 0, notes: [] });
    const { getByTestId } = render(<SpaceMcpSettings spaceId="space-1" />);
    const btn = getByTestId('space-mcp-refresh-imports') as HTMLButtonElement;

    fireEvent.click(btn);

    await waitFor(() => {
      expect(mockHubRequest).toHaveBeenCalledWith('mcp.imports.refresh', {});
    });
    await waitFor(() => {
      expect(mockToastSuccess).toHaveBeenCalledWith(expect.stringContaining('2 imported'));
    });
  });

  it('surfaces scanner notes via toast.info', async () => {
    mockHubRequest.mockResolvedValueOnce({
      ok: true,
      imported: 0,
      removed: 0,
      notes: ['/tmp/foo: parse error — oops'],
    });
    const { getByTestId } = render(<SpaceMcpSettings spaceId="space-1" />);
    fireEvent.click(getByTestId('space-mcp-refresh-imports') as HTMLButtonElement);

    await waitFor(() => {
      expect(mockToastInfo).toHaveBeenCalledWith('/tmp/foo: parse error — oops');
    });
  });

  it('shows empty state when there are no entries', () => {
    setEntries([]);
    const { container } = render(<SpaceMcpSettings spaceId="space-1" />);
    expect(container.textContent).toContain('No MCP servers configured');
  });

  it('toasts an error when toggle call rejects', async () => {
    setEntries([makeEntry('fail-srv')]);
    mockHubRequest.mockRejectedValueOnce(new Error('nope'));
    const { getByTestId } = render(<SpaceMcpSettings spaceId="space-1" />);
    fireEvent.change(getByTestId('space-mcp-toggle-fail-srv') as HTMLInputElement);

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalled();
      expect(mockToastError.mock.calls[0][0]).toMatch(/nope/);
    });
  });

  it('toasts error when not connected', async () => {
    mockGetHubIfConnected.mockReturnValue(null as never);
    setEntries([makeEntry('offline-srv')]);
    const { getByTestId } = render(<SpaceMcpSettings spaceId="space-1" />);
    fireEvent.change(getByTestId('space-mcp-toggle-offline-srv') as HTMLInputElement);

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('Not connected to server');
    });
  });
});
