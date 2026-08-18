// @ts-nocheck
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  pushOverlayHistory,
  closeOverlayHistory,
  initializeRouter,
  cleanupRouter,
} from '../router';
import {
  navSectionSignal,
  spaceOverlaySessionIdSignal,
  spaceOverlayAgentNameSignal,
  spaceOverlayTaskContextSignal,
  currentSpaceIdSignal,
} from '../signals';

let originalHistory: unknown;
let originalLocation: unknown;
let mockHistory: unknown;
let mockLocation: unknown;

describe('Overlay history', () => {
  beforeEach(() => {
    originalHistory = window.history;
    originalLocation = window.location;

    mockHistory = {
      pushState: vi.fn(),
      replaceState: vi.fn(),
      back: vi.fn(),
      state: {},
    };
    mockLocation = { pathname: '/space/my-space' };

    Object.defineProperty(window, 'history', {
      value: mockHistory,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, 'location', {
      value: mockLocation,
      writable: true,
      configurable: true,
    });

    spaceOverlaySessionIdSignal.value = null;
    spaceOverlayAgentNameSignal.value = null;
    spaceOverlayTaskContextSignal.value = null;
    navSectionSignal.value = 'spaces';
    currentSpaceIdSignal.value = null;

    vi.clearAllMocks();
    cleanupRouter();
  });

  afterEach(() => {
    Object.defineProperty(window, 'history', {
      value: originalHistory,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
      configurable: true,
    });

    cleanupRouter();
    spaceOverlaySessionIdSignal.value = null;
    spaceOverlayAgentNameSignal.value = null;
    spaceOverlayTaskContextSignal.value = null;
  });

  describe('pushOverlayHistory', () => {
    it('should push a history entry with overlay marker and set overlay signals', () => {
      pushOverlayHistory('session-abc', 'Task Agent');

      expect(mockHistory.pushState).toHaveBeenCalledWith(
        expect.objectContaining({ overlaySessionId: 'session-abc' }),
        '',
        '/space/my-space'
      );
      expect(spaceOverlaySessionIdSignal.value).toBe('session-abc');
      expect(spaceOverlayAgentNameSignal.value).toBe('Task Agent');
    });

    it('should set agentName to null when not provided', () => {
      pushOverlayHistory('session-abc');

      expect(spaceOverlayAgentNameSignal.value).toBeNull();
    });

    it('should preserve task context for workflow node-agent overlays', () => {
      pushOverlayHistory('session-abc', 'Coder', undefined, {
        taskId: 'task-1',
        agentName: 'coder',
        nodeExecutionId: 'exec-coder-1',
      });

      expect(spaceOverlayTaskContextSignal.value).toEqual({
        taskId: 'task-1',
        agentName: 'coder',
        nodeExecutionId: 'exec-coder-1',
      });
    });

    it('should preserve existing history state', () => {
      mockHistory.state = { spaceId: 'my-space' };

      pushOverlayHistory('session-abc');

      expect(mockHistory.pushState).toHaveBeenCalledWith(
        expect.objectContaining({
          spaceId: 'my-space',
          overlaySessionId: 'session-abc',
        }),
        '',
        '/space/my-space'
      );
    });
  });

  describe('closeOverlayHistory', () => {
    it('should call history.back() and clear overlay signals when overlay is open', () => {
      mockHistory.state = { overlaySessionId: 'session-abc' };

      closeOverlayHistory();

      expect(mockHistory.back).toHaveBeenCalled();
      expect(spaceOverlaySessionIdSignal.value).toBeNull();
      expect(spaceOverlayAgentNameSignal.value).toBeNull();
      expect(spaceOverlayTaskContextSignal.value).toBeNull();
    });

    it('should just clear signals when no overlay history entry exists', () => {
      mockHistory.state = {};

      closeOverlayHistory();

      expect(mockHistory.back).not.toHaveBeenCalled();
      expect(spaceOverlaySessionIdSignal.value).toBeNull();
      expect(spaceOverlayAgentNameSignal.value).toBeNull();
      expect(spaceOverlayTaskContextSignal.value).toBeNull();
    });
  });

  describe('popstate with overlay', () => {
    it('should close overlay signals when popstate removes overlay marker', () => {
      spaceOverlaySessionIdSignal.value = 'session-abc';
      spaceOverlayAgentNameSignal.value = 'Task Agent';
      mockHistory.state = {};

      initializeRouter();
      window.dispatchEvent(new PopStateEvent('popstate', {}));

      expect(spaceOverlaySessionIdSignal.value).toBeNull();
      expect(spaceOverlayAgentNameSignal.value).toBeNull();
      expect(spaceOverlayTaskContextSignal.value).toBeNull();
    });

    it('should not interfere with normal navigation when overlay is closed', () => {
      spaceOverlaySessionIdSignal.value = null;
      mockHistory.state = {};

      initializeRouter();
      mockLocation.pathname = '/space/other-space';
      window.dispatchEvent(new PopStateEvent('popstate', {}));

      expect(navSectionSignal.value).toBe('spaces');
      expect(currentSpaceIdSignal.value).toBe('other-space');
    });
  });
});
