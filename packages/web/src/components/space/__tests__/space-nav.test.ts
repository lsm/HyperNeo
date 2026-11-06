import { afterEach, describe, expect, it } from 'vitest';
import { navSectionSignal } from '../../../lib/signals';
import {
  currentSpaceCanonicalIdSignal,
  currentSpaceIdSignal,
  currentSpaceViewModeSignal,
} from '../../../lib/space-signals';
import { spaceNav } from '../space-nav';

describe('spaceNav.voiceScope', () => {
  afterEach(() => {
    currentSpaceCanonicalIdSignal.value = null;
    currentSpaceIdSignal.value = null;
  });

  it('is empty outside a Space', () => {
    expect(spaceNav.voiceScope()).toBeNull();
  });

  it('names the canonical Space a recording can return to', () => {
    currentSpaceIdSignal.value = 'space-slug';
    expect(spaceNav.voiceScope()).toBe('space:space-slug');

    currentSpaceCanonicalIdSignal.value = 'space-1';
    expect(spaceNav.voiceScope()).toBe('space:space-1');
    expect(spaceNav.recordingReturn('space:space-1', 'session-1', null)?.path).toBe(
      '/space/space-1/session/session-1'
    );
  });
});

describe('spaceNav.contentKey', () => {
  afterEach(() => {
    currentSpaceIdSignal.value = null;
    currentSpaceViewModeSignal.value = 'overview';
    navSectionSignal.value = 'spaces';
  });

  it('claims the Spaces home and each Space view', () => {
    navSectionSignal.value = 'spaces';
    expect(spaceNav.contentKey()).toBe('spaces');

    currentSpaceIdSignal.value = 'space-1';
    currentSpaceViewModeSignal.value = 'goals';
    expect(spaceNav.contentKey()).toBe('space-space-1-goals');
  });

  it('leaves other sections to the shell', () => {
    navSectionSignal.value = 'chats';

    expect(spaceNav.contentKey()).toBeNull();
  });
});
