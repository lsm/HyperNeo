// @ts-nocheck

import {
  currentSessionIdSignal,
  sidebarOpenSignal,
  sessionsSignal,
  slashCommandsSignal,
} from '../signals';

describe('signals', () => {
  describe('currentSessionIdSignal', () => {
    beforeEach(() => {
      currentSessionIdSignal.value = null;
    });

    it('should start with null value', () => {
      expect(currentSessionIdSignal.value).toBeNull();
    });

    it('should accept string values', () => {
      currentSessionIdSignal.value = 'test-session-123';
      expect(currentSessionIdSignal.value).toBe('test-session-123');
    });

    it('should accept null to deselect session', () => {
      currentSessionIdSignal.value = 'some-session';
      currentSessionIdSignal.value = null;
      expect(currentSessionIdSignal.value).toBeNull();
    });

    it('should be reactive', () => {
      const values: (string | null)[] = [];
      const unsubscribe = currentSessionIdSignal.subscribe((value) => {
        values.push(value);
      });

      currentSessionIdSignal.value = 'session-1';
      currentSessionIdSignal.value = 'session-2';
      currentSessionIdSignal.value = null;

      unsubscribe();

      expect(values).toEqual([null, 'session-1', 'session-2', null]);
    });
  });

  describe('sidebarOpenSignal', () => {
    beforeEach(() => {
      sidebarOpenSignal.value = false;
    });

    it('should start with false value', () => {
      expect(sidebarOpenSignal.value).toBe(false);
    });

    it('should toggle between true and false', () => {
      sidebarOpenSignal.value = true;
      expect(sidebarOpenSignal.value).toBe(true);

      sidebarOpenSignal.value = false;
      expect(sidebarOpenSignal.value).toBe(false);
    });

    it('should be reactive', () => {
      const values: boolean[] = [];
      const unsubscribe = sidebarOpenSignal.subscribe((value) => {
        values.push(value);
      });

      sidebarOpenSignal.value = true;
      sidebarOpenSignal.value = false;
      sidebarOpenSignal.value = true;

      unsubscribe();

      expect(values).toEqual([false, true, false, true]);
    });
  });

  describe('sessionsSignal', () => {
    beforeEach(() => {
      sessionsSignal.value = [];
    });

    it('should start with empty array', () => {
      expect(sessionsSignal.value).toEqual([]);
    });

    it('should accept session objects', () => {
      const sessions = [
        {
          id: 'session-1',
          title: 'Session 1',
          workspacePath: '/path/1',
          status: 'active' as const,
          config: {},
          metadata: { messageCount: 0 },
          createdAt: new Date().toISOString(),
          lastActiveAt: new Date().toISOString(),
        },
      ];
      sessionsSignal.value = sessions;
      expect(sessionsSignal.value).toHaveLength(1);
      expect(sessionsSignal.value[0].id).toBe('session-1');
    });

    it('should be reactive', () => {
      let updateCount = 0;
      const unsubscribe = sessionsSignal.subscribe(() => {
        updateCount++;
      });

      sessionsSignal.value = [];
      sessionsSignal.value = [
        {
          id: '1',
          title: 'Test',
          workspacePath: '/',
          status: 'active' as const,
          config: {},
          metadata: { messageCount: 0 },
          createdAt: new Date().toISOString(),
          lastActiveAt: new Date().toISOString(),
        },
      ];

      unsubscribe();

      expect(updateCount).toBe(3);
    });
  });

  describe('slashCommandsSignal', () => {
    beforeEach(() => {
      slashCommandsSignal.value = [];
    });

    it('should start with empty array', () => {
      expect(slashCommandsSignal.value).toEqual([]);
    });

    it('should accept array of command strings', () => {
      slashCommandsSignal.value = ['/help', '/clear', '/reset', '/context'];
      expect(slashCommandsSignal.value).toEqual(['/help', '/clear', '/reset', '/context']);
    });

    it('should be able to add commands', () => {
      slashCommandsSignal.value = ['/help'];
      slashCommandsSignal.value = [...slashCommandsSignal.value, '/clear'];
      expect(slashCommandsSignal.value).toEqual(['/help', '/clear']);
    });

    it('should be reactive', () => {
      const updates: string[][] = [];
      const unsubscribe = slashCommandsSignal.subscribe((value) => {
        updates.push([...value]);
      });

      slashCommandsSignal.value = ['/help'];
      slashCommandsSignal.value = ['/help', '/clear'];

      unsubscribe();

      expect(updates).toEqual([[], ['/help'], ['/help', '/clear']]);
    });
  });
});
