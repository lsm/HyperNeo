// @ts-nocheck

import { renderHook, act } from '@testing-library/preact';
import { useModal } from '../useModal.ts';

describe('useModal', () => {
  describe('initialization', () => {
    it('should initialize with isOpen as false by default', () => {
      const { result } = renderHook(() => useModal());

      expect(result.current.isOpen).toBe(false);
    });

    it('should initialize with isOpen as true when initialOpen is true', () => {
      const { result } = renderHook(() => useModal(true));

      expect(result.current.isOpen).toBe(true);
    });

    it('should initialize with isOpen as false when initialOpen is false', () => {
      const { result } = renderHook(() => useModal(false));

      expect(result.current.isOpen).toBe(false);
    });
  });

  describe('open', () => {
    it('should set isOpen to true when open is called', () => {
      const { result } = renderHook(() => useModal());

      expect(result.current.isOpen).toBe(false);

      act(() => {
        result.current.open();
      });

      expect(result.current.isOpen).toBe(true);
    });

    it('should maintain isOpen as true when open is called multiple times', () => {
      const { result } = renderHook(() => useModal());

      act(() => {
        result.current.open();
        result.current.open();
        result.current.open();
      });

      expect(result.current.isOpen).toBe(true);
    });
  });

  describe('close', () => {
    it('should set isOpen to false when close is called', () => {
      const { result } = renderHook(() => useModal(true));

      expect(result.current.isOpen).toBe(true);

      act(() => {
        result.current.close();
      });

      expect(result.current.isOpen).toBe(false);
    });

    it('should maintain isOpen as false when close is called multiple times', () => {
      const { result } = renderHook(() => useModal(true));

      act(() => {
        result.current.close();
        result.current.close();
        result.current.close();
      });

      expect(result.current.isOpen).toBe(false);
    });
  });

  describe('toggle', () => {
    it('should toggle isOpen from false to true', () => {
      const { result } = renderHook(() => useModal());

      expect(result.current.isOpen).toBe(false);

      act(() => {
        result.current.toggle();
      });

      expect(result.current.isOpen).toBe(true);
    });

    it('should toggle isOpen from true to false', () => {
      const { result } = renderHook(() => useModal(true));

      expect(result.current.isOpen).toBe(true);

      act(() => {
        result.current.toggle();
      });

      expect(result.current.isOpen).toBe(false);
    });

    it('should toggle multiple times correctly', () => {
      const { result } = renderHook(() => useModal());

      act(() => {
        result.current.toggle();
      });
      expect(result.current.isOpen).toBe(true);

      act(() => {
        result.current.toggle();
      });
      expect(result.current.isOpen).toBe(false);

      act(() => {
        result.current.toggle();
      });
      expect(result.current.isOpen).toBe(true);
    });
  });

  describe('setIsOpen', () => {
    it('should set isOpen to true directly', () => {
      const { result } = renderHook(() => useModal());

      act(() => {
        result.current.setIsOpen(true);
      });

      expect(result.current.isOpen).toBe(true);
    });

    it('should set isOpen to false directly', () => {
      const { result } = renderHook(() => useModal(true));

      act(() => {
        result.current.setIsOpen(false);
      });

      expect(result.current.isOpen).toBe(false);
    });
  });

  describe('function stability', () => {
    it('should return stable open function reference', () => {
      const { result, rerender } = renderHook(() => useModal());

      const firstOpen = result.current.open;
      rerender();
      const secondOpen = result.current.open;

      expect(firstOpen).toBe(secondOpen);
    });

    it('should return stable close function reference', () => {
      const { result, rerender } = renderHook(() => useModal());

      const firstClose = result.current.close;
      rerender();
      const secondClose = result.current.close;

      expect(firstClose).toBe(secondClose);
    });

    it('should return stable toggle function reference', () => {
      const { result, rerender } = renderHook(() => useModal());

      const firstToggle = result.current.toggle;
      rerender();
      const secondToggle = result.current.toggle;

      expect(firstToggle).toBe(secondToggle);
    });
  });

  describe('combined operations', () => {
    it('should handle sequence of operations correctly', () => {
      const { result } = renderHook(() => useModal());

      expect(result.current.isOpen).toBe(false);

      act(() => {
        result.current.open();
      });
      expect(result.current.isOpen).toBe(true);

      act(() => {
        result.current.toggle();
      });
      expect(result.current.isOpen).toBe(false);

      act(() => {
        result.current.setIsOpen(true);
      });
      expect(result.current.isOpen).toBe(true);

      act(() => {
        result.current.close();
      });
      expect(result.current.isOpen).toBe(false);
    });
  });
});
