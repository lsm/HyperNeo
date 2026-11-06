import { afterEach, describe, expect, it } from 'vitest';
import { currentSpaceCanonicalIdSignal, currentSpaceIdSignal } from '../signals';
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
