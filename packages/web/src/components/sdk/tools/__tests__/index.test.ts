// @ts-nocheck

import { ToolProgressCard, ToolResultCard, AuthStatusCard } from '../index.ts';

describe('Tool Components Index', () => {
  describe('Component exports', () => {
    it('should export ToolProgressCard', () => {
      expect(ToolProgressCard).toBeDefined();
      expect(typeof ToolProgressCard).toBe('function');
    });

    it('should export ToolResultCard', () => {
      expect(ToolResultCard).toBeDefined();
      expect(typeof ToolResultCard).toBe('function');
    });

    it('should export AuthStatusCard', () => {
      expect(AuthStatusCard).toBeDefined();
      expect(typeof AuthStatusCard).toBe('function');
    });
  });
});
