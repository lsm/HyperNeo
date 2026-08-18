// @ts-nocheck

import type { ConnectionState } from '@hyperneo/shared';
import { getBannerLevel } from '../ConnectionOverlay';

describe('ConnectionOverlay - getBannerLevel logic', () => {
  describe('States that should be hidden', () => {
    it('should be hidden when connected', () => {
      expect(getBannerLevel('connected', 0)).toBe('hidden');
    });

    it('should be hidden when connecting (initial load)', () => {
      expect(getBannerLevel('connecting', 0)).toBe('hidden');
    });
  });

  describe('Connecting during reconnect cycle', () => {
    it('should show reconnecting banner when connecting with attempts > 0', () => {
      expect(getBannerLevel('connecting', 1)).toBe('reconnecting');
      expect(getBannerLevel('connecting', 2)).toBe('reconnecting');
    });

    it('should show lost banner when connecting with high attempt count', () => {
      expect(getBannerLevel('connecting', 3)).toBe('lost');
      expect(getBannerLevel('connecting', 5)).toBe('lost');
    });
  });

  describe('Reconnecting progression', () => {
    it('should show reconnecting level on first attempt', () => {
      expect(getBannerLevel('reconnecting', 1)).toBe('reconnecting');
    });

    it('should show reconnecting level on second attempt', () => {
      expect(getBannerLevel('reconnecting', 2)).toBe('reconnecting');
    });

    it('should escalate to lost level on third attempt', () => {
      expect(getBannerLevel('reconnecting', 3)).toBe('lost');
    });

    it('should escalate to lost level on higher attempts', () => {
      expect(getBannerLevel('reconnecting', 5)).toBe('lost');
      expect(getBannerLevel('reconnecting', 10)).toBe('lost');
    });
  });

  describe('Connection lost states', () => {
    it('should show lost level for disconnected', () => {
      expect(getBannerLevel('disconnected', 0)).toBe('lost');
    });

    it('should show lost level for error', () => {
      expect(getBannerLevel('error', 0)).toBe('lost');
    });
  });

  describe('Failed state', () => {
    it('should show failed level', () => {
      expect(getBannerLevel('failed', 10)).toBe('failed');
    });
  });

  describe('Full state progression', () => {
    it('should follow: hidden → reconnecting → lost → failed', () => {
      expect(getBannerLevel('connected', 0)).toBe('hidden');

      expect(getBannerLevel('reconnecting', 1)).toBe('reconnecting');

      expect(getBannerLevel('reconnecting', 4)).toBe('lost');

      expect(getBannerLevel('disconnected', 5)).toBe('lost');

      expect(getBannerLevel('failed', 10)).toBe('failed');

      expect(getBannerLevel('connected', 0)).toBe('hidden');
    });
  });

  describe('Non-blocking behavior verification', () => {
    it('should never show "hidden" for non-connected states', () => {
      const nonConnectedStates: ConnectionState[] = [
        'disconnected',
        'error',
        'reconnecting',
        'failed',
      ];

      for (const state of nonConnectedStates) {
        expect(getBannerLevel(state, 1)).not.toBe('hidden');
      }
    });

    it('should never show "failed" for transient states', () => {
      const transientStates: Array<{ state: ConnectionState; attempts: number }> = [
        { state: 'reconnecting', attempts: 1 },
        { state: 'reconnecting', attempts: 5 },
        { state: 'disconnected', attempts: 0 },
        { state: 'error', attempts: 0 },
      ];

      for (const { state, attempts } of transientStates) {
        expect(getBannerLevel(state, attempts)).not.toBe('failed');
      }
    });
  });
});
