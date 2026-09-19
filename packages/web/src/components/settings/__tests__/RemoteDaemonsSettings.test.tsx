import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor, fireEvent } from '@testing-library/preact';

const { mockRequest, mockToastError, mockToastSuccess } = vi.hoisted(() => ({
  mockRequest: vi.fn(),
  mockToastError: vi.fn(),
  mockToastSuccess: vi.fn(),
}));

vi.mock('../../../lib/connection-manager', () => ({
  connectionManager: {
    getHubIfConnected: () => ({ request: mockRequest }),
  },
}));

vi.mock('../../../lib/toast.ts', () => ({
  toast: {
    error: (msg: string) => mockToastError(msg),
    success: (msg: string) => mockToastSuccess(msg),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

import { RemoteDaemonsSettings, validateAttachForm } from '../RemoteDaemonsSettings.tsx';

interface Invocation {
  name: string;
  input: unknown;
}

function invocations(): Invocation[] {
  return mockRequest.mock.calls
    .filter(([method]) => method === 'operation.invoke')
    .map(([, params]) => params as Invocation);
}

function attached(daemonId: string, url: string) {
  return { daemonId, url, addressExample: `daemon:${daemonId}::session:%3CsessionId%3E` };
}

function respondWith(listPages: Array<ReturnType<typeof attached>[]>) {
  let listCall = 0;
  mockRequest.mockImplementation(async (_method: string, params: Invocation) => {
    if (params.name === 'daemon.list') {
      const daemons = listPages[Math.min(listCall, listPages.length - 1)] ?? [];
      listCall += 1;
      return { kind: 'listed', daemons };
    }
    if (params.name === 'daemon.attach') {
      return { kind: 'attached', daemonId: (params.input as { daemonId: string }).daemonId };
    }
    if (params.name === 'daemon.probe') {
      return { kind: 'reachable', url: (params.input as { url: string }).url };
    }
    return { kind: 'detached', daemonId: (params.input as { daemonId: string }).daemonId };
  });
}

function typeForm(daemonId: string, url: string) {
  fireEvent.input(screen.getByLabelText('Daemon id'), { target: { value: daemonId } });
  fireEvent.input(screen.getByLabelText('MessageHub URL'), { target: { value: url } });
}

describe('validateAttachForm', () => {
  it('accepts a ws:// endpoint under a simple id', () => {
    expect(validateAttachForm('staging', 'ws://127.0.0.1:8484/ws')).toBeNull();
    expect(validateAttachForm('a.b_c-1', 'wss://host/ws')).toBeNull();
  });

  it('rejects an empty id, a punctuation-led id and a non-websocket URL', () => {
    expect(validateAttachForm('', 'ws://host/ws')).toBe('Daemon id is required');
    expect(validateAttachForm('-nope', 'ws://host/ws')).toContain('Daemon id must start with');
    expect(validateAttachForm('ok', 'https://host/ws')).toContain('ws:// or wss://');
  });
});

describe('RemoteDaemonsSettings', () => {
  beforeEach(() => {
    mockRequest.mockReset();
    mockToastError.mockReset();
    mockToastSuccess.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('lists the daemons the daemon reports as attached', async () => {
    respondWith([[attached('b', 'ws://127.0.0.1:9/ws'), attached('c', 'wss://elsewhere.test/ws')]]);

    render(<RemoteDaemonsSettings />);

    await waitFor(() => expect(screen.getByText('b')).toBeTruthy());
    expect(screen.getByText('ws://127.0.0.1:9/ws')).toBeTruthy();
    expect(screen.getByText('c')).toBeTruthy();
    expect(screen.getByText('daemon:c::session:%3CsessionId%3E')).toBeTruthy();
    expect(invocations()[0]).toEqual({ name: 'daemon.list', input: {} });
  });

  it('says plainly that attachments do not survive a daemon restart', async () => {
    respondWith([[]]);

    render(<RemoteDaemonsSettings />);

    await waitFor(() => expect(screen.getByText('No remote daemons attached.')).toBeTruthy());
    expect(document.body.textContent).toContain('gone when it restarts');
  });

  it('attaches what the form holds and shows the daemon in the refreshed list', async () => {
    respondWith([[], [attached('staging', 'ws://staging.test:8484/ws')]]);

    render(<RemoteDaemonsSettings />);
    await waitFor(() => expect(screen.getByText('No remote daemons attached.')).toBeTruthy());

    typeForm('staging', 'ws://staging.test:8484/ws');
    fireEvent.click(screen.getByText('Attach'));

    await waitFor(() => expect(screen.getByText('staging')).toBeTruthy());
    expect(invocations()[1]).toEqual({
      name: 'daemon.attach',
      input: { daemonId: 'staging', url: 'ws://staging.test:8484/ws' },
    });
    expect(mockToastSuccess).toHaveBeenCalledWith("Attached 'staging'");
  });

  it('tests the form URL without attaching it', async () => {
    respondWith([[]]);

    render(<RemoteDaemonsSettings />);
    await waitFor(() => expect(screen.getByText('No remote daemons attached.')).toBeTruthy());

    typeForm('staging', 'ws://staging.test:8484/ws');
    fireEvent.click(screen.getByText('Test'));

    await waitFor(() =>
      expect(mockToastSuccess).toHaveBeenCalledWith('Remote daemon is reachable')
    );
    expect(invocations()[1]).toEqual({
      name: 'daemon.probe',
      input: { url: 'ws://staging.test:8484/ws' },
    });
    expect(invocations().map(({ name }) => name)).toEqual(['daemon.list', 'daemon.probe']);
  });

  it('shows the probe failure reason', async () => {
    mockRequest.mockImplementation(async (_method: string, params: Invocation) =>
      params.name === 'daemon.list'
        ? { kind: 'listed', daemons: [] }
        : { kind: 'unreachable', url: 'ws://bad.test/ws', reason: 'connection refused' }
    );

    render(<RemoteDaemonsSettings />);
    await waitFor(() => expect(screen.getByText('No remote daemons attached.')).toBeTruthy());

    typeForm('bad', 'ws://bad.test/ws');
    fireEvent.click(screen.getByText('Test'));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('connection refused'));
  });

  it('refuses a non-websocket URL in the form without reaching the daemon', async () => {
    respondWith([[]]);

    render(<RemoteDaemonsSettings />);
    await waitFor(() => expect(screen.getByText('No remote daemons attached.')).toBeTruthy());

    typeForm('staging', 'http://staging.test');
    fireEvent.click(screen.getByText('Attach'));

    await waitFor(() =>
      expect(screen.getByText('URL must be a ws:// or wss:// MessageHub endpoint')).toBeTruthy()
    );
    expect(invocations().map(({ name }) => name)).toEqual(['daemon.list']);
  });

  it('detaches the daemon on the row and drops it from the refreshed list', async () => {
    respondWith([[attached('b', 'ws://127.0.0.1:9/ws')], []]);

    render(<RemoteDaemonsSettings />);
    await waitFor(() => expect(screen.getByText('b')).toBeTruthy());

    fireEvent.click(screen.getByText('Detach'));

    await waitFor(() => expect(screen.getByText('No remote daemons attached.')).toBeTruthy());
    expect(invocations()[1]).toEqual({ name: 'daemon.detach', input: { daemonId: 'b' } });
    expect(screen.queryByText('ws://127.0.0.1:9/ws')).toBeNull();
  });

  it('surfaces a rejection from the daemon instead of pretending the daemon attached', async () => {
    mockRequest.mockImplementation(async (_method: string, params: Invocation) =>
      params.name === 'daemon.list'
        ? { kind: 'listed', daemons: [] }
        : { kind: 'rejected', reason: 'restricted to the RPC door' }
    );

    render(<RemoteDaemonsSettings />);
    await waitFor(() => expect(screen.getByText('No remote daemons attached.')).toBeTruthy());

    typeForm('staging', 'ws://staging.test/ws');
    fireEvent.click(screen.getByText('Attach'));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('restricted to the RPC door'));
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });
});
