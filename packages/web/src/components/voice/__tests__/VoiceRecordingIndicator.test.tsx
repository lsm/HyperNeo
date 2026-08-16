// @ts-nocheck
/**
 * Tests for the global "recording elsewhere" indicator: renders only while a
 * live recording is not visible on the rendering surface (its owning composer
 * mounted there, or orphaned for the displayed session), hides behind an open
 * overlay (which renders its own in-panel instance), and navigates back to
 * the recording's session through its OWNING surface on click.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const voiceRecorderStore = vi.hoisted(() => ({
  isRecording: { value: false },
  isStarting: { value: false },
  durationLimitHit: { value: false },
  recordingSessionId: { value: null },
  recordingSpaceId: { value: null },
  recordingTaskId: { value: null },
  recordingOwnerId: { value: null },
}));

const routerState = vi.hoisted(() => ({
  currentSessionId: 'session-current',
  spaceSessionId: null,
  spaceId: null,
  overlaySessionId: null,
  overlayPending: null,
  currentPath: '/',
  navigatedTo: null,
  navigatedSpace: null,
  navigatedTask: null,
}));

vi.mock('../../../lib/voice/voice-recorder-store.ts', () => ({ voiceRecorderStore }));
vi.mock('../../../lib/signals.ts', () => ({
  currentSessionIdSignal: {
    get value() {
      return routerState.currentSessionId;
    },
  },
  currentSpaceSessionIdSignal: {
    get value() {
      return routerState.spaceSessionId;
    },
  },
  currentSpaceIdSignal: {
    get value() {
      return routerState.spaceId;
    },
  },
  spaceOverlaySessionIdSignal: {
    get value() {
      return routerState.overlaySessionId;
    },
  },
  spaceOverlayPendingAgentNameSignal: {
    get value() {
      return routerState.overlayPending;
    },
  },
}));
const closeOverlayHistory = vi.hoisted(() => vi.fn());
const clearOverlaySignals = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/router.ts', () => ({
  navigateToSession: vi.fn((sessionId: string) => {
    routerState.navigatedTo = sessionId;
  }),
  navigateToSpaceSession: vi.fn((spaceId: string, sessionId: string) => {
    routerState.navigatedSpace = { spaceId, sessionId };
  }),
  navigateToSpaceTask: vi.fn((spaceId: string, taskId: string, view: string) => {
    routerState.navigatedTask = { spaceId, taskId, view };
  }),
  closeOverlayHistory,
  clearOverlaySignals,
  createSessionPath: (sessionId: string) => `/chat/${sessionId}`,
  createSpaceSessionPath: (spaceId: string, sessionId: string) =>
    `/space/${spaceId}/session/${sessionId}`,
  createSpaceTaskPath: (spaceId: string, taskId: string, view?: string) =>
    view ? `/space/${spaceId}/task/${taskId}/${view}` : `/space/${spaceId}/task/${taskId}`,
  getCurrentPath: () => routerState.currentPath,
}));

import { VoiceRecordingIndicator } from '../VoiceRecordingIndicator.tsx';
import { VoiceSurfaceContext } from '../../../hooks/useVoiceRecorder';
import {
  registerVoiceComposer,
  unregisterVoiceComposer,
  voiceReturnTaskTargetSessionSignal,
} from '../../../lib/voice/voice-composer-registry.ts';
import {
  clearOverlaySignals,
  closeOverlayHistory,
  navigateToSession,
  navigateToSpaceSession,
  navigateToSpaceTask,
} from '../../../lib/router.ts';

/** Render the base (MainContent) instance. */
const renderBase = () => render(<VoiceRecordingIndicator />);
/** Render the in-overlay instance inside the overlay's surface context. */
const renderInOverlay = () =>
  render(
    <VoiceSurfaceContext.Provider value={{ surfaceId: 'agent-overlay', spaceId: 'space-9' }}>
      <VoiceRecordingIndicator inOverlay />
    </VoiceSurfaceContext.Provider>
  );

describe('VoiceRecordingIndicator', () => {
  beforeEach(() => {
    voiceRecorderStore.isRecording.value = false;
    voiceRecorderStore.isStarting.value = false;
    voiceRecorderStore.durationLimitHit.value = false;
    voiceRecorderStore.recordingSessionId.value = null;
    voiceRecorderStore.recordingSpaceId.value = null;
    voiceRecorderStore.recordingTaskId.value = null;
    voiceRecorderStore.recordingOwnerId.value = null;
    routerState.currentSessionId = 'session-current';
    routerState.spaceSessionId = null;
    routerState.spaceId = null;
    routerState.overlaySessionId = null;
    routerState.overlayPending = null;
    routerState.currentPath = '/';
    routerState.navigatedTo = null;
    closeOverlayHistory.mockClear();
    clearOverlaySignals.mockClear();
    routerState.navigatedSpace = null;
    routerState.navigatedTask = null;
    voiceReturnTaskTargetSessionSignal.value = null;
  });

  afterEach(() => {
    cleanup();
    // Leave the composer registry pristine for the next test.
    voiceRecorderStore.recordingOwnerId.value = null;
    unregisterVoiceComposer('owner-base');
    unregisterVoiceComposer('owner-overlay');
  });

  it('renders nothing when no recording is live', () => {
    const { container } = renderBase();
    expect(container.querySelector('[data-testid="voice-recording-elsewhere"]')).toBeNull();
  });

  it('renders nothing when the displayed session shows an orphaned recording (it adopts)', () => {
    voiceRecorderStore.isRecording.value = true;
    voiceRecorderStore.recordingSessionId.value = 'session-current';
    // The displayed composer displays the recording's session and may adopt.
    registerVoiceComposer('owner-base', {
      surfaceId: 'primary',
      sessionId: 'session-current',
      canAdopt: true,
    });
    const { container } = renderBase();
    expect(container.querySelector('[data-testid="voice-recording-elsewhere"]')).toBeNull();
  });

  it('keeps the chip when the only same-session composer refuses adoption (mid-transcription)', () => {
    voiceRecorderStore.isRecording.value = true;
    voiceRecorderStore.recordingSessionId.value = 'session-current';
    // The displayed composer is mid-transcription: adoption is deliberately
    // disabled, so the orphaned recording is NOT visible here — the chip is
    // the only Return affordance while the capture continues.
    registerVoiceComposer('owner-base', {
      surfaceId: 'primary',
      sessionId: 'session-current',
      canAdopt: false,
    });
    const { container } = renderBase();
    expect(container.querySelector('[data-testid="voice-recording-elsewhere"]')).toBeTruthy();
  });

  it('renders nothing when this surface owns the displayed recording', () => {
    voiceRecorderStore.isRecording.value = true;
    voiceRecorderStore.recordingSessionId.value = 'session-current';
    voiceRecorderStore.recordingOwnerId.value = 'owner-base';
    registerVoiceComposer('owner-base', {
      surfaceId: 'primary',
      sessionId: 'session-current',
      canAdopt: true,
    });
    const { container } = renderBase();
    expect(container.querySelector('[data-testid="voice-recording-elsewhere"]')).toBeNull();
  });

  it('renders for a recording in another session and navigates back on click', () => {
    voiceRecorderStore.isRecording.value = true;
    voiceRecorderStore.recordingSessionId.value = 'session-other';
    renderBase();

    const chip = screen.getByTestId('voice-recording-elsewhere');
    expect(chip).toBeTruthy();
    fireEvent.click(chip);
    expect(navigateToSession).toHaveBeenCalledWith('session-other', false);
    expect(routerState.navigatedTo).toBe('session-other');
  });

  it('renders while recording startup is still pending (survivable permission prompt)', () => {
    voiceRecorderStore.isRecording.value = false;
    voiceRecorderStore.isStarting.value = true;
    voiceRecorderStore.recordingSessionId.value = 'session-other';
    const { container } = renderBase();
    expect(container.querySelector('[data-testid="voice-recording-elsewhere"]')).toBeTruthy();
  });

  it('renders for a limit-hit recording (buffered audio awaiting its owner)', () => {
    voiceRecorderStore.isRecording.value = false;
    voiceRecorderStore.durationLimitHit.value = true;
    voiceRecorderStore.recordingSessionId.value = 'session-other';
    const { container } = renderBase();
    expect(container.querySelector('[data-testid="voice-recording-elsewhere"]')).toBeTruthy();
  });

  it('treats a Space session view as the displayed session (no chip, space-aware return)', () => {
    voiceRecorderStore.isRecording.value = true;
    voiceRecorderStore.recordingSessionId.value = 'space-session-1';
    // A Space session view leaves the primary signal null and keys by space id.
    routerState.currentSessionId = null;
    routerState.spaceSessionId = 'space-session-1';
    routerState.spaceId = 'space-9';
    registerVoiceComposer('owner-base', {
      surfaceId: 'primary',
      sessionId: 'space-session-1',
      canAdopt: true,
    });
    const { container } = renderBase();
    expect(container.querySelector('[data-testid="voice-recording-elsewhere"]')).toBeNull();
  });

  it('returns through the recording Space when a recording is elsewhere while a Space view is open', () => {
    voiceRecorderStore.isRecording.value = true;
    voiceRecorderStore.recordingSessionId.value = 'space-session-2';
    // Stamp captured at recording start in space-9 — routing follows the
    // recording's OWNING surface, not the displayed one.
    voiceRecorderStore.recordingSpaceId.value = 'space-9';
    routerState.currentSessionId = null;
    routerState.spaceSessionId = 'space-session-1';
    routerState.spaceId = 'space-9';
    renderBase();
    fireEvent.click(screen.getByTestId('voice-recording-elsewhere'));
    expect(navigateToSpaceSession).toHaveBeenCalledWith('space-9', 'space-session-2', false);
    expect(navigateToSession).not.toHaveBeenCalled();
  });

  it('returns a task-scoped recording to the TASK thread (task messaging path)', () => {
    voiceRecorderStore.isRecording.value = true;
    voiceRecorderStore.recordingSessionId.value = 'task-agent-session';
    voiceRecorderStore.recordingSpaceId.value = 'space-9';
    voiceRecorderStore.recordingTaskId.value = 'task-42';
    routerState.currentSessionId = null;
    routerState.spaceSessionId = 'space-session-1';
    routerState.spaceId = 'space-9';
    renderBase();
    fireEvent.click(screen.getByTestId('voice-recording-elsewhere'));
    expect(navigateToSpaceTask).toHaveBeenCalledWith('space-9', 'task-42', 'thread', false);
    expect(navigateToSpaceSession).not.toHaveBeenCalled();
    expect(navigateToSession).not.toHaveBeenCalled();
    // The task thread must restore this target as recipient, or a non-default
    // agent's recording could never be adopted.
    expect(voiceReturnTaskTargetSessionSignal.value).toBe('task-agent-session');
  });

  it('routes a primary-chat recording through the chat route even while a Space is displayed', () => {
    voiceRecorderStore.isRecording.value = true;
    voiceRecorderStore.recordingSessionId.value = 'session-other';
    // No owning space (primary-chat recording); user is viewing space-9.
    routerState.currentSessionId = null;
    routerState.spaceSessionId = 'space-session-1';
    routerState.spaceId = 'space-9';
    renderBase();
    fireEvent.click(screen.getByTestId('voice-recording-elsewhere'));
    expect(navigateToSession).toHaveBeenCalledWith('session-other', false);
    expect(navigateToSpaceSession).not.toHaveBeenCalled();
  });

  it('hides the base instance while an overlay is open (the overlay shows its own)', () => {
    voiceRecorderStore.isRecording.value = true;
    voiceRecorderStore.recordingSessionId.value = 'space-session-2';
    routerState.currentSessionId = null;
    routerState.spaceSessionId = 'space-session-1';
    routerState.spaceId = 'space-9';
    routerState.overlaySessionId = 'overlay-session-7';
    const { container } = renderBase();
    expect(container.querySelector('[data-testid="voice-recording-elsewhere"]')).toBeNull();
  });

  it('shows the in-overlay chip when an overlay covers the recording base session', () => {
    voiceRecorderStore.isRecording.value = true;
    voiceRecorderStore.recordingSessionId.value = 'space-session-1';
    routerState.currentSessionId = null;
    routerState.spaceSessionId = 'space-session-1';
    routerState.spaceId = 'space-9';
    routerState.overlaySessionId = 'overlay-session-7';
    renderInOverlay();
    // The overlay displays a DIFFERENT session — the base recording is
    // elsewhere and the chip must offer a return.
    expect(screen.getByTestId('voice-recording-elsewhere')).toBeTruthy();
  });

  it('shows the in-overlay chip when the overlay displays a recording owned by the base composer', () => {
    // The finding-4 case: a Space task composer owns a recording for agent
    // session S; the overlay opens S. The overlay composer cannot adopt (the
    // base still owns), so the recording would be invisible without the chip.
    voiceRecorderStore.isRecording.value = true;
    voiceRecorderStore.recordingSessionId.value = 'overlay-session-7';
    voiceRecorderStore.recordingOwnerId.value = 'owner-base';
    registerVoiceComposer('owner-base', {
      surfaceId: 'primary',
      sessionId: 'overlay-session-7',
      canAdopt: true,
    });
    routerState.currentSessionId = null;
    routerState.spaceSessionId = 'space-session-1';
    routerState.spaceId = 'space-9';
    routerState.overlaySessionId = 'overlay-session-7';
    renderInOverlay();
    const chip = screen.getByTestId('voice-recording-elsewhere');
    expect(chip).toBeTruthy();
    // The accessible name must match the visible "in this session" wording —
    // a fixed "another session" label would mislead screen-reader users.
    expect(chip.getAttribute('aria-label')).toContain('in this session');
  });

  it('closing from that state only dismisses the overlay (re-revealing the owning waveform)', () => {
    voiceRecorderStore.isRecording.value = true;
    voiceRecorderStore.recordingSessionId.value = 'overlay-session-7';
    voiceRecorderStore.recordingOwnerId.value = 'owner-base';
    registerVoiceComposer('owner-base', {
      surfaceId: 'primary',
      sessionId: 'overlay-session-7',
      canAdopt: true,
    });
    routerState.currentSessionId = null;
    routerState.spaceSessionId = 'space-session-1';
    routerState.spaceId = 'space-9';
    routerState.overlaySessionId = 'overlay-session-7';
    renderInOverlay();
    fireEvent.click(screen.getByTestId('voice-recording-elsewhere'));
    expect(closeOverlayHistory).toHaveBeenCalledTimes(1);
    expect(clearOverlaySignals).not.toHaveBeenCalled();
    expect(navigateToSession).not.toHaveBeenCalled();
    expect(navigateToSpaceSession).not.toHaveBeenCalled();
  });

  it('hides the in-overlay chip for a recording owned by the overlay composer', () => {
    voiceRecorderStore.isRecording.value = true;
    voiceRecorderStore.recordingSessionId.value = 'overlay-session-7';
    voiceRecorderStore.recordingOwnerId.value = 'owner-overlay';
    registerVoiceComposer('owner-overlay', {
      surfaceId: 'agent-overlay',
      sessionId: 'overlay-session-7',
      canAdopt: true,
    });
    routerState.currentSessionId = null;
    routerState.spaceSessionId = 'space-session-1';
    routerState.spaceId = 'space-9';
    routerState.overlaySessionId = 'overlay-session-7';
    const { container } = renderInOverlay();
    expect(container.querySelector('[data-testid="voice-recording-elsewhere"]')).toBeNull();
  });

  it('shows the in-overlay chip when a PENDING overlay covers the recording base session', () => {
    voiceRecorderStore.isRecording.value = true;
    voiceRecorderStore.recordingSessionId.value = 'space-session-1';
    routerState.currentSessionId = null;
    routerState.spaceSessionId = 'space-session-1';
    routerState.spaceId = 'space-9';
    routerState.overlayPending = 'pending-agent';
    renderInOverlay();
    expect(screen.getByTestId('voice-recording-elsewhere')).toBeTruthy();
  });

  it('clears the overlay synchronously and replaces its history entry when returning past it', () => {
    voiceRecorderStore.isRecording.value = true;
    voiceRecorderStore.recordingSessionId.value = 'space-session-2';
    voiceRecorderStore.recordingSpaceId.value = 'space-9';
    routerState.currentSessionId = null;
    routerState.spaceSessionId = 'space-session-1';
    routerState.spaceId = 'space-9';
    routerState.overlaySessionId = 'overlay-session-7';
    renderInOverlay();
    fireEvent.click(screen.getByTestId('voice-recording-elsewhere'));
    // Synchronous signal clear (no async history.back()) + replace=true so
    // the overlay's still-top history entry is consumed, not stacked under.
    expect(clearOverlaySignals).toHaveBeenCalledTimes(1);
    expect(closeOverlayHistory).not.toHaveBeenCalled();
    expect(navigateToSpaceSession).toHaveBeenCalledWith('space-9', 'space-session-2', true);
  });

  it('pops the duplicate overlay entry when the destination URL already matches', () => {
    // Recording belongs to the base Space session UNDER a different overlay:
    // overlays keep the base URL, so the target path equals the current one
    // and the navigate fast-path would perform no history write — the chip
    // must pop the overlay's duplicate entry instead of relying on replace.
    voiceRecorderStore.isRecording.value = true;
    voiceRecorderStore.recordingSessionId.value = 'space-session-1';
    voiceRecorderStore.recordingSpaceId.value = 'space-9';
    routerState.currentSessionId = null;
    routerState.spaceSessionId = 'space-session-1';
    routerState.spaceId = 'space-9';
    routerState.overlaySessionId = 'overlay-session-7';
    routerState.currentPath = '/space/space-9/session/space-session-1';
    renderInOverlay();
    fireEvent.click(screen.getByTestId('voice-recording-elsewhere'));
    expect(closeOverlayHistory).toHaveBeenCalledTimes(1);
    expect(clearOverlaySignals).not.toHaveBeenCalled();
    // Navigation still runs (its same-path branch sets route signals without
    // a history write) with replace requested for the consumed entry.
    expect(navigateToSpaceSession).toHaveBeenCalledWith('space-9', 'space-session-1', true);
  });

  it('pops a task same-path overlay entry (thread view matches the navigation)', () => {
    // The task thread's URL already matches (overlay keeps the base /thread
    // URL); the comparison path must use the 'thread' view or this entry is
    // missed and never popped, leaving a ghost Back entry.
    voiceRecorderStore.isRecording.value = true;
    voiceRecorderStore.recordingSessionId.value = 'task-agent-session';
    voiceRecorderStore.recordingSpaceId.value = 'space-9';
    voiceRecorderStore.recordingTaskId.value = 'task-42';
    routerState.currentSessionId = null;
    routerState.spaceSessionId = 'space-session-1';
    routerState.spaceId = 'space-9';
    routerState.overlaySessionId = 'overlay-session-7';
    routerState.currentPath = '/space/space-9/task/task-42/thread';
    renderInOverlay();
    fireEvent.click(screen.getByTestId('voice-recording-elsewhere'));
    expect(closeOverlayHistory).toHaveBeenCalledTimes(1);
    expect(clearOverlaySignals).not.toHaveBeenCalled();
    expect(navigateToSpaceTask).toHaveBeenCalledWith('space-9', 'task-42', 'thread', true);
  });

  it('routes through the Space surface when only spaceId remains (overview/task pages)', () => {
    voiceRecorderStore.isRecording.value = true;
    voiceRecorderStore.recordingSessionId.value = 'space-session-2';
    voiceRecorderStore.recordingSpaceId.value = 'space-9';
    routerState.currentSessionId = null;
    routerState.spaceSessionId = null; // cleared on overview/task pages
    routerState.spaceId = 'space-9';
    renderBase();
    fireEvent.click(screen.getByTestId('voice-recording-elsewhere'));
    expect(navigateToSpaceSession).toHaveBeenCalledWith('space-9', 'space-session-2', false);
    expect(navigateToSession).not.toHaveBeenCalled();
  });

  it('renders when no session is displayed but a recording is live', () => {
    voiceRecorderStore.isRecording.value = true;
    voiceRecorderStore.recordingSessionId.value = 'session-other';
    routerState.currentSessionId = null;
    const { container } = renderBase();
    expect(container.querySelector('[data-testid="voice-recording-elsewhere"]')).toBeTruthy();
  });
});
