import { cleanup, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../components/voice/VoiceRecordingIndicator', () => ({
  VoiceRecordingIndicator: () => null,
}));

import MainContent from '../MainContent';
import { currentSessionIdSignal, navSectionSignal } from '../../lib/signals';
import { currentSpaceIdSignal } from '../../lib/space-signals';

describe('MainContent while Space is still loading', () => {
  afterEach(() => cleanup());

  it('shows the loading placeholder on the Spaces home instead of a blank page', () => {
    navSectionSignal.value = 'spaces';
    currentSessionIdSignal.value = null;
    currentSpaceIdSignal.value = null;
    render(<MainContent />);
    expect(screen.getByText('Loading...')).toBeTruthy();
  });

  it('shows the loading placeholder on a space route', () => {
    navSectionSignal.value = 'spaces';
    currentSessionIdSignal.value = null;
    currentSpaceIdSignal.value = 'space-1';
    render(<MainContent />);
    expect(screen.getByText('Loading...')).toBeTruthy();
  });
});
