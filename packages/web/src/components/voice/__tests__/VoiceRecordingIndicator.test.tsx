// @ts-nocheck
/**
 * Tests for the global "recording elsewhere" indicator: renders only while a
 * live recording belongs to a session other than the displayed one, and
 * navigates back to the recording's session on click.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const voiceRecorderStore = vi.hoisted(() => ({
  isRecording: { value: false },
  durationLimitHit: { value: false },
  recordingSessionId: { value: null },
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
}));
vi.mock('../../../lib/router.ts', () => ({
  navigateToSession: vi.fn((sessionId: string) => {
    routerState.navigatedTo = sessionId;
  }),
  navigateToSpaceSession: vi.fn((spaceId: string, sessionId: string) => {
    routerState.navigatedSpace = { spaceId, sessionId };
  }),
}));

import { VoiceRecordingIndicator } from '../VoiceRecordingIndicator.tsx';
import { navigateToSession, navigateToSpaceSession } from '../../../lib/router.ts';

describe('VoiceRecordingIndicator', () => {
  beforeEach(() => {
    voiceRecorderStore.isRecording.value = false;
    voiceRecorderStore.durationLimitHit.value = false;
    voiceRecorderStore.recordingSessionId.value = null;
    routerState.currentSessionId = 'session-current';
    routerState.spaceSessionId = null;
    routerState.spaceId = null;
    routerState.overlaySessionId = null;
    routerState.navigatedTo = null;
    routerState.navigatedSpace = null;
  });

  afterEach(cleanup);

  it('renders nothing when no recording is live', () => {
    const { container } = render(<VoiceRecordingIndicator />);
    expect(container.querySelector('[data-testid="voice-recording-elsewhere"]')).toBeNull();
  });

  it('renders nothing when the recording belongs to the displayed session', () => {
    voiceRecorderStore.isRecording.value = true;
    voiceRecorderStore.recordingSessionId.value = 'session-current';
    const { container } = render(<VoiceRecordingIndicator />);
    expect(container.querySelector('[data-testid="voice-recording-elsewhere"]')).toBeNull();
  });

  it('renders for a recording in another session and navigates back on click', () => {
    voiceRecorderStore.isRecording.value = true;
    voiceRecorderStore.recordingSessionId.value = 'session-other';
    render(<VoiceRecordingIndicator />);

    const chip = screen.getByTestId('voice-recording-elsewhere');
    expect(chip).toBeTruthy();
    fireEvent.click(chip);
    expect(navigateToSession).toHaveBeenCalledWith('session-other');
    expect(routerState.navigatedTo).toBe('session-other');
  });

  it('renders for a limit-hit recording (buffered audio awaiting its owner)', () => {
    voiceRecorderStore.isRecording.value = false;
    voiceRecorderStore.durationLimitHit.value = true;
    voiceRecorderStore.recordingSessionId.value = 'session-other';
    const { container } = render(<VoiceRecordingIndicator />);
    expect(container.querySelector('[data-testid="voice-recording-elsewhere"]')).toBeTruthy();
  });

  it('treats a Space session view as the displayed session (no chip, space-aware return)', () => {
    voiceRecorderStore.isRecording.value = true;
    voiceRecorderStore.recordingSessionId.value = 'space-session-1';
    // A Space session view leaves the primary signal null and keys by space id.
    routerState.currentSessionId = null;
    routerState.spaceSessionId = 'space-session-1';
    routerState.spaceId = 'space-9';
    const { container } = render(<VoiceRecordingIndicator />);
    expect(container.querySelector('[data-testid="voice-recording-elsewhere"]')).toBeNull();
  });

  it('returns through the Space route when a recording is elsewhere while a Space view is open', () => {
    voiceRecorderStore.isRecording.value = true;
    voiceRecorderStore.recordingSessionId.value = 'space-session-2';
    routerState.currentSessionId = null;
    routerState.spaceSessionId = 'space-session-1';
    routerState.spaceId = 'space-9';
    render(<VoiceRecordingIndicator />);
    fireEvent.click(screen.getByTestId('voice-recording-elsewhere'));
    expect(navigateToSpaceSession).toHaveBeenCalledWith('space-9', 'space-session-2');
    expect(navigateToSession).not.toHaveBeenCalled();
  });

  it('shows the chip when an overlay covers the recording base session', () => {
    voiceRecorderStore.isRecording.value = true;
    voiceRecorderStore.recordingSessionId.value = 'space-session-1';
    routerState.currentSessionId = null;
    routerState.spaceSessionId = 'space-session-1';
    routerState.spaceId = 'space-9';
    routerState.overlaySessionId = 'overlay-session-7';
    render(<VoiceRecordingIndicator />);
    // The overlay displays a DIFFERENT session — the base recording is
    // elsewhere and the chip must offer a return.
    expect(screen.getByTestId('voice-recording-elsewhere')).toBeTruthy();
  });

  it('hides the chip for a recording made in the open overlay session', () => {
    voiceRecorderStore.isRecording.value = true;
    voiceRecorderStore.recordingSessionId.value = 'overlay-session-7';
    routerState.currentSessionId = null;
    routerState.spaceSessionId = 'space-session-1';
    routerState.spaceId = 'space-9';
    routerState.overlaySessionId = 'overlay-session-7';
    const { container } = render(<VoiceRecordingIndicator />);
    expect(container.querySelector('[data-testid="voice-recording-elsewhere"]')).toBeNull();
  });

  it('routes through the Space surface when only spaceId remains (overview/task pages)', () => {
    voiceRecorderStore.isRecording.value = true;
    voiceRecorderStore.recordingSessionId.value = 'space-session-2';
    routerState.currentSessionId = null;
    routerState.spaceSessionId = null; // cleared on overview/task pages
    routerState.spaceId = 'space-9';
    render(<VoiceRecordingIndicator />);
    fireEvent.click(screen.getByTestId('voice-recording-elsewhere'));
    expect(navigateToSpaceSession).toHaveBeenCalledWith('space-9', 'space-session-2');
    expect(navigateToSession).not.toHaveBeenCalled();
  });

  it('renders when no session is displayed but a recording is live', () => {
    voiceRecorderStore.isRecording.value = true;
    voiceRecorderStore.recordingSessionId.value = 'session-other';
    routerState.currentSessionId = null;
    const { container } = render(<VoiceRecordingIndicator />);
    expect(container.querySelector('[data-testid="voice-recording-elsewhere"]')).toBeTruthy();
  });
});
