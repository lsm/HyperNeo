import { signal } from '@preact/signals';
import { cleanup, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  artifactPreviewWorkspace,
  closeArtifactPreview,
  openArtifactPreview,
} from '../../lib/artifact-preview-store.ts';

const store = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }));
vi.mock('../../lib/session-store.ts', () => ({
  SessionStore: class {
    constructor() {
      return store.current as object;
    }
  },
}));
vi.mock('../../lib/connection-manager.ts', () => ({ connectionManager: {} }));
vi.mock('../../hooks/useInputDraft.ts', () => ({
  useInputDraft: () => ({
    content: '',
    setContent: () => {},
    holdDraftAdoption: async (run: () => Promise<unknown>) => run(),
    clearSubmitted: async () => {},
  }),
}));
vi.mock('../../hooks/useInterrupt.ts', () => ({
  useInterrupt: () => ({ handleInterrupt: () => {} }),
}));
vi.mock('../NeoComposer.tsx', () => ({ NeoComposer: () => null }));

import { NeoSessionPane } from '../NeoSessionPane.tsx';

function fakeStore(worker?: string) {
  return {
    select: async () => {},
    destroy: async () => {},
    loadOlderMessages: async () => ({ messages: [] }),
    prependMessages: () => {},
    refresh: async () => {},
    sessionState: signal(worker ? { worker: { label: worker } } : null),
    isWorking: signal(false),
    sdkMessages: signal([]),
    messagesLoaded: signal(true),
    hasMoreMessages: signal(false),
    loadErrorKind: signal(null),
    agentState: signal({ status: 'idle' }),
    error: signal(null),
  };
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
});
afterEach(() => {
  cleanup();
  closeArtifactPreview();
  store.current = null;
  vi.unstubAllGlobals();
});

describe('NeoSessionPane title', () => {
  it('keeps the caller title on the preview tab over the daemon worker label', () => {
    store.current = fakeStore('Daemon label');
    openArtifactPreview({ kind: 'session', sessionId: 's1' }, 'Todo worker');
    render(<NeoSessionPane sessionId="s1" title="HyperNeo · s1" label="Todo worker" />);
    expect(artifactPreviewWorkspace.state.value.files[0].title).toBe('Todo worker');
  });

  it('shows the caller title in the overlay header over the daemon worker label', () => {
    store.current = fakeStore('Daemon label');
    render(
      <NeoSessionPane sessionId="s3" title="HyperNeo · s3" label="Todo worker" onClose={() => {}} />
    );
    expect(screen.getByRole('heading', { name: 'Todo worker' })).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Todo worker chat' })).toBeTruthy();
  });

  it('uses the daemon worker label only when no caller label was given', () => {
    store.current = fakeStore('Daemon label');
    render(<NeoSessionPane sessionId="s2" title="HyperNeo · s2" onClose={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Daemon label' })).toBeTruthy();
  });
});
