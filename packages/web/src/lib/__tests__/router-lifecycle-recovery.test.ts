import { describe, expect, it } from 'vitest';
import {
  createSessionPath,
  createSpacePath,
  createSpaceSessionPath,
  createSpaceTaskPath,
  getSessionIdFromPath,
  getSpaceIdFromPath,
  getSpaceSessionIdFromPath,
  getSpaceTaskIdFromPath,
} from '../router';

const UUID = '04062505-780f-4881-a3be-9cb9062790fb';
const COORDINATOR_SESSION_ID = 'space:chat:b90171e4-1111-2222-3333-444444444444';

describe('chat/thread lifecycle recovery — route IDs with special characters', () => {
  describe('create -> parse round-trip', () => {
    it('round-trips a standard session UUID through /session/', () => {
      const path = createSessionPath(UUID);
      expect(getSessionIdFromPath(path)).toBe(UUID);
    });

    it('round-trips a space id through /space/', () => {
      const path = createSpacePath('hyperneo-dev');
      expect(getSpaceIdFromPath(path)).toBe('hyperneo-dev');
    });

    it('round-trips a coordinator session id (with colons) through the space-session route', () => {
      const path = createSpaceSessionPath('hyperneo-dev', COORDINATOR_SESSION_ID);
      expect(getSpaceSessionIdFromPath(path)).toEqual({
        spaceId: 'hyperneo-dev',
        sessionId: COORDINATOR_SESSION_ID,
      });
    });

    it('round-trips a UUID task id and a short task id through /space/<slug>/task/', () => {
      expect(getSpaceTaskIdFromPath(createSpaceTaskPath('hyperneo-dev', UUID))).toEqual({
        spaceId: 'hyperneo-dev',
        taskId: UUID,
      });
      expect(getSpaceTaskIdFromPath(createSpaceTaskPath('hyperneo-dev', 't-42'))).toEqual({
        spaceId: 'hyperneo-dev',
        taskId: 't-42',
      });
    });
  });

  describe('coordinator / special-character ids resolve on the space-session route', () => {
    it('matches a coordinator session id containing colons', () => {
      expect(
        getSpaceSessionIdFromPath(`/space/hyperneo-dev/session/${COORDINATOR_SESSION_ID}`)
      ).toEqual({
        spaceId: 'hyperneo-dev',
        sessionId: COORDINATOR_SESSION_ID,
      });
    });

    it('matches a coordinator session id containing underscores', () => {
      const id = 'space:chat_worker:b90171e4-1111-2222-3333-444444444444';
      expect(getSpaceSessionIdFromPath(`/space/hyperneo-dev/session/${id}`)).toEqual({
        spaceId: 'hyperneo-dev',
        sessionId: id,
      });
    });
  });

  describe('the plain /session/ route rejects special-character ids', () => {
    it('does not match a coordinator id with colons', () => {
      expect(getSessionIdFromPath(`/session/${COORDINATOR_SESSION_ID}`)).toBeNull();
    });

    it('does not match an id containing a non-hex letter', () => {
      expect(getSessionIdFromPath('/session/zzzz-not-hex')).toBeNull();
    });

    it('does not match an id containing a slash', () => {
      expect(getSessionIdFromPath('/session/space/chat/abc')).toBeNull();
    });
  });

  describe('raw-pathname matching (no percent-decoding)', () => {
    it('does not match a percent-encoded colon in a space-session id', () => {
      const encoded = encodeURIComponent(COORDINATOR_SESSION_ID);
      expect(getSpaceSessionIdFromPath(`/space/hyperneo-dev/session/${encoded}`)).toBeNull();
    });

    it('does not match a percent-encoded space slug', () => {
      expect(getSpaceIdFromPath('/space/hyperneo%20dev')).toBeNull();
    });
  });
});
