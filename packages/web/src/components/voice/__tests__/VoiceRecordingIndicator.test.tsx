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
  durationLimitHit: { value: false },
  recordingSessionId: { value: null },
  recordingSpaceId: { value: null },
  recordingOwnerId: { value: null },
}));

const routerState = vi.hoisted(() => ({
  currentSessionId: 'session-current',
  spaceSessionId: null,
  spaceId: null,
  overlaySessionId: null,
  navigatedTo: null,
  navigatedSpace: null,
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
  closeOverlayHistory,
  clearOverlaySignals,
}));

import { VoiceRecordingIndicator } from '../VoiceRecordingIndicator.tsx';
import { VoiceSurfaceContext } from '../../../hooks/useVoiceRecorder';
import {
  registerVoiceComposer,
  unregisterVoiceComposer,
} from '../../../lib/voice/voice-composer-registry.ts';
import {
  clearOverlaySignals,
  closeOverlayHistory,
  navigateToSession,
  navigateToSpaceSession,
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
    voiceRecorderStore.durationLimitHit.value = false;
    voiceRecorderStore.recordingSessionId.value = null;
    voiceRecorderStore.recordingSpaceId.value = null;
    voiceRecorderStore.recordingOwnerId.value = null;
    routerState.currentSessionId = 'session-current';
    routerState.spaceSessionId = null;
    routerState.spaceId = null;
    routerState.overlaySessionId = null;
    routerState.overlayPending = null;
    routerState.navigatedTo = null;
    closeOverlayHistory.mockClear();
    clearOverlaySignals.mockClear();
    routerState.navigatedSpace = null;
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
    const { container } = renderBase();
    expect(container.querySelector('[data-testid="voice-recording-elsewhere"]')).toBeNull();
  });

  it('renders nothing when this surface owns the displayed recording', () => {
    voiceRecorderStore.isRecording.value = true;
    voiceRecorderStore.recordingSessionId.value = 'session-current';
    voiceRecorderStore.recordingOwnerId.value = 'owner-base';
    registerVoiceComposer('owner-base', 'primary');
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
    registerVoiceComposer('owner-base', 'primary');
    routerState.currentSessionId = null;
    routerState.spaceSessionId = 'space-session-1';
    routerState.spaceId = 'space-9';
    routerState.overlaySessionId = 'overlay-session-7';
    renderInOverlay();
    expect(screen.getByTestId('voice-recording-elsewhere')).toBeTruthy();
  });

  it('closing from that state only dismisses the overlay (re-revealing the owning waveform)', () => {
    voiceRecorderStore.isRecording.value = true;
    voiceRecorderStore.recordingSessionId.value = 'overlay-session-7';
    voiceRecorderStore.recordingOwnerId.value = 'owner-base';
    registerVoiceComposer('owner-base', 'primary');
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
    registerVoiceComposer('owner-overlay', 'agent-overlay');
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
