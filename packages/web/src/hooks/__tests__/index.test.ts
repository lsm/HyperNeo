// @ts-nocheck

import {
  useModal,
  useInputDraft,
  useModelSwitcher,
  MODEL_FAMILY_ICONS,
  useMessageHub,
  useCommandAutocomplete,
  useInterrupt,
  useFileAttachments,
  useGroupMessages,
  useReferenceAutocomplete,
  extractActiveAtQuery,
} from '../index.ts';

describe('Hooks Index', () => {
  describe('Hook exports', () => {
    it('should export useModal', () => {
      expect(useModal).toBeDefined();
      expect(typeof useModal).toBe('function');
    });

    it('should export useInputDraft', () => {
      expect(useInputDraft).toBeDefined();
      expect(typeof useInputDraft).toBe('function');
    });

    it('should export useModelSwitcher', () => {
      expect(useModelSwitcher).toBeDefined();
      expect(typeof useModelSwitcher).toBe('function');
    });

    it('should export MODEL_FAMILY_ICONS constant', () => {
      expect(MODEL_FAMILY_ICONS).toBeDefined();
      expect(typeof MODEL_FAMILY_ICONS).toBe('object');
    });

    it('should export useMessageHub', () => {
      expect(useMessageHub).toBeDefined();
      expect(typeof useMessageHub).toBe('function');
    });

    it('should export useCommandAutocomplete', () => {
      expect(useCommandAutocomplete).toBeDefined();
      expect(typeof useCommandAutocomplete).toBe('function');
    });

    it('should export useInterrupt', () => {
      expect(useInterrupt).toBeDefined();
      expect(typeof useInterrupt).toBe('function');
    });

    it('should export useFileAttachments', () => {
      expect(useFileAttachments).toBeDefined();
      expect(typeof useFileAttachments).toBe('function');
    });

    it('should export useGroupMessages', () => {
      expect(useGroupMessages).toBeDefined();
      expect(typeof useGroupMessages).toBe('function');
    });

    it('should export useReferenceAutocomplete', () => {
      expect(useReferenceAutocomplete).toBeDefined();
      expect(typeof useReferenceAutocomplete).toBe('function');
    });

    it('should export extractActiveAtQuery', () => {
      expect(extractActiveAtQuery).toBeDefined();
      expect(typeof extractActiveAtQuery).toBe('function');
    });
  });
});
