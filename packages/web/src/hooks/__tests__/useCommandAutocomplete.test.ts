// @ts-nocheck

import { renderHook, act } from '@testing-library/preact';
import { useCommandAutocomplete } from '../useCommandAutocomplete.ts';

const mockCommandsData = vi.hoisted(() => ({
  value: ['/help', '/clear', '/model', '/context', '/commit'] as string[],
}));

vi.mock('../../lib/session-store.ts', () => ({
  sessionStore: {
    commandsData: mockCommandsData,
  },
}));

describe('useCommandAutocomplete', () => {
  beforeEach(() => {
    mockCommandsData.value = ['/help', '/clear', '/model', '/context', '/commit'];
  });

  describe('initialization', () => {
    it('should initialize with autocomplete hidden', () => {
      const onSelect = vi.fn(() => {});
      const { result } = renderHook(() =>
        useCommandAutocomplete({
          content: '',
          onSelect,
        })
      );

      expect(result.current.showAutocomplete).toBe(false);
      expect(result.current.filteredCommands).toEqual([]);
      expect(result.current.selectedIndex).toBe(0);
    });

    it('should provide required functions', () => {
      const onSelect = vi.fn(() => {});
      const { result } = renderHook(() =>
        useCommandAutocomplete({
          content: '',
          onSelect,
        })
      );

      expect(typeof result.current.handleSelect).toBe('function');
      expect(typeof result.current.handleKeyDown).toBe('function');
      expect(typeof result.current.close).toBe('function');
      expect(typeof result.current.setSelectedIndex).toBe('function');
    });
  });

  describe('slash command detection', () => {
    it('should show autocomplete when content starts with /', () => {
      const onSelect = vi.fn(() => {});
      const { result } = renderHook(() =>
        useCommandAutocomplete({
          content: '/',
          onSelect,
        })
      );

      expect(result.current.showAutocomplete).toBe(true);
      expect(result.current.filteredCommands).toEqual([
        '/help',
        '/clear',
        '/model',
        '/context',
        '/commit',
      ]);
    });

    it('should show autocomplete when content has leading whitespace and starts with /', () => {
      const onSelect = vi.fn(() => {});
      const { result } = renderHook(() =>
        useCommandAutocomplete({
          content: '  /',
          onSelect,
        })
      );

      expect(result.current.showAutocomplete).toBe(true);
    });

    it('should not show autocomplete when content does not start with /', () => {
      const onSelect = vi.fn(() => {});
      const { result } = renderHook(() =>
        useCommandAutocomplete({
          content: 'hello',
          onSelect,
        })
      );

      expect(result.current.showAutocomplete).toBe(false);
    });

    it('should not show autocomplete when / is in the middle of text', () => {
      const onSelect = vi.fn(() => {});
      const { result } = renderHook(() =>
        useCommandAutocomplete({
          content: 'hello /world',
          onSelect,
        })
      );

      expect(result.current.showAutocomplete).toBe(false);
    });
  });

  describe('command filtering', () => {
    it('should filter commands based on input', () => {
      const onSelect = vi.fn(() => {});
      const { result } = renderHook(() =>
        useCommandAutocomplete({
          content: '/he',
          onSelect,
        })
      );

      expect(result.current.showAutocomplete).toBe(true);
      expect(result.current.filteredCommands).toEqual(['/help']);
    });

    it('should filter commands case-insensitively', () => {
      const onSelect = vi.fn(() => {});
      const { result } = renderHook(() =>
        useCommandAutocomplete({
          content: '/HE',
          onSelect,
        })
      );

      expect(result.current.filteredCommands).toEqual(['/help']);
    });

    it('should show all commands when just / is typed', () => {
      const onSelect = vi.fn(() => {});
      const { result } = renderHook(() =>
        useCommandAutocomplete({
          content: '/',
          onSelect,
        })
      );

      expect(result.current.filteredCommands.length).toBe(5);
    });

    it('should hide autocomplete when no commands match', () => {
      const onSelect = vi.fn(() => {});
      const { result } = renderHook(() =>
        useCommandAutocomplete({
          content: '/xyz',
          onSelect,
        })
      );

      expect(result.current.showAutocomplete).toBe(false);
      expect(result.current.filteredCommands).toEqual([]);
    });

    it('should match partial command names', () => {
      const onSelect = vi.fn(() => {});
      const { result } = renderHook(() =>
        useCommandAutocomplete({
          content: '/co',
          onSelect,
        })
      );

      expect(result.current.filteredCommands).toEqual(['/context', '/commit']);
    });
  });

  describe('handleSelect', () => {
    it('should call onSelect and close autocomplete', () => {
      const onSelect = vi.fn(() => {});
      const { result } = renderHook(() =>
        useCommandAutocomplete({
          content: '/',
          onSelect,
        })
      );

      act(() => {
        result.current.handleSelect('/commit');
      });

      expect(onSelect).toHaveBeenCalledWith('/commit');
      expect(result.current.showAutocomplete).toBe(false);
    });
  });

  describe('close', () => {
    it('should close autocomplete when close is called', () => {
      const onSelect = vi.fn(() => {});
      const { result } = renderHook(() =>
        useCommandAutocomplete({
          content: '/',
          onSelect,
        })
      );

      expect(result.current.showAutocomplete).toBe(true);

      act(() => {
        result.current.close();
      });

      expect(result.current.showAutocomplete).toBe(false);
    });
  });

  describe('setSelectedIndex', () => {
    it('should allow setting selectedIndex directly', () => {
      const onSelect = vi.fn(() => {});
      const { result } = renderHook(() =>
        useCommandAutocomplete({
          content: '/',
          onSelect,
        })
      );

      act(() => {
        result.current.setSelectedIndex(3);
      });

      expect(result.current.selectedIndex).toBe(3);
    });
  });

  describe('handleKeyDown', () => {
    it('should not handle keyboard events when autocomplete is hidden', () => {
      const onSelect = vi.fn(() => {});
      const { result } = renderHook(() =>
        useCommandAutocomplete({
          content: '',
          onSelect,
        })
      );

      const event = new KeyboardEvent('keydown', { key: 'ArrowDown' });

      let handled: boolean;
      act(() => {
        handled = result.current.handleKeyDown(event);
      });

      expect(handled!).toBe(false);
    });

    it('should handle ArrowDown to navigate', () => {
      const onSelect = vi.fn(() => {});
      const { result } = renderHook(() =>
        useCommandAutocomplete({
          content: '/',
          onSelect,
        })
      );

      expect(result.current.selectedIndex).toBe(0);

      const event = new KeyboardEvent('keydown', { key: 'ArrowDown' });
      const preventDefault = vi.fn(() => {});
      Object.defineProperty(event, 'preventDefault', { value: preventDefault });

      act(() => {
        const handled = result.current.handleKeyDown(event);
        expect(handled).toBe(true);
      });

      expect(result.current.selectedIndex).toBe(1);
      expect(preventDefault).toHaveBeenCalled();
    });

    it('should handle ArrowUp to navigate', () => {
      const onSelect = vi.fn(() => {});
      const { result } = renderHook(() =>
        useCommandAutocomplete({
          content: '/',
          onSelect,
        })
      );

      act(() => {
        result.current.setSelectedIndex(2);
      });

      const event = new KeyboardEvent('keydown', { key: 'ArrowUp' });
      const preventDefault = vi.fn(() => {});
      Object.defineProperty(event, 'preventDefault', { value: preventDefault });

      act(() => {
        result.current.handleKeyDown(event);
      });

      expect(result.current.selectedIndex).toBe(1);
    });

    it('should wrap around when navigating past end', () => {
      const onSelect = vi.fn(() => {});
      const { result } = renderHook(() =>
        useCommandAutocomplete({
          content: '/',
          onSelect,
        })
      );

      act(() => {
        result.current.setSelectedIndex(4);
      });

      const event = new KeyboardEvent('keydown', { key: 'ArrowDown' });
      Object.defineProperty(event, 'preventDefault', { value: () => {} });

      act(() => {
        result.current.handleKeyDown(event);
      });

      expect(result.current.selectedIndex).toBe(0);
    });

    it('should wrap around when navigating before start', () => {
      const onSelect = vi.fn(() => {});
      const { result } = renderHook(() =>
        useCommandAutocomplete({
          content: '/',
          onSelect,
        })
      );

      expect(result.current.selectedIndex).toBe(0);

      const event = new KeyboardEvent('keydown', { key: 'ArrowUp' });
      Object.defineProperty(event, 'preventDefault', { value: () => {} });

      act(() => {
        result.current.handleKeyDown(event);
      });

      expect(result.current.selectedIndex).toBe(4);
    });

    it('should select command with Enter', () => {
      const onSelect = vi.fn(() => {});
      const { result } = renderHook(() =>
        useCommandAutocomplete({
          content: '/',
          onSelect,
        })
      );

      const event = new KeyboardEvent('keydown', { key: 'Enter' });
      const preventDefault = vi.fn(() => {});
      Object.defineProperty(event, 'preventDefault', { value: preventDefault });

      act(() => {
        const handled = result.current.handleKeyDown(event);
        expect(handled).toBe(true);
      });

      expect(onSelect).toHaveBeenCalledWith('/help');
      expect(result.current.showAutocomplete).toBe(false);
    });

    it('should not handle Enter with metaKey', () => {
      const onSelect = vi.fn(() => {});
      const { result } = renderHook(() =>
        useCommandAutocomplete({
          content: '/',
          onSelect,
        })
      );

      const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        metaKey: true,
      });

      act(() => {
        const handled = result.current.handleKeyDown(event);
        expect(handled).toBe(false);
      });

      expect(onSelect).not.toHaveBeenCalled();
    });

    it('should not handle Enter with ctrlKey', () => {
      const onSelect = vi.fn(() => {});
      const { result } = renderHook(() =>
        useCommandAutocomplete({
          content: '/',
          onSelect,
        })
      );

      const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        ctrlKey: true,
      });

      act(() => {
        const handled = result.current.handleKeyDown(event);
        expect(handled).toBe(false);
      });

      expect(onSelect).not.toHaveBeenCalled();
    });

    it('should close autocomplete with Escape', () => {
      const onSelect = vi.fn(() => {});
      const { result } = renderHook(() =>
        useCommandAutocomplete({
          content: '/',
          onSelect,
        })
      );

      expect(result.current.showAutocomplete).toBe(true);

      const event = new KeyboardEvent('keydown', { key: 'Escape' });
      const preventDefault = vi.fn(() => {});
      Object.defineProperty(event, 'preventDefault', { value: preventDefault });

      act(() => {
        const handled = result.current.handleKeyDown(event);
        expect(handled).toBe(true);
      });

      expect(result.current.showAutocomplete).toBe(false);
    });
  });

  describe('empty commands list', () => {
    it('should not show autocomplete when commands list is empty', () => {
      mockCommandsData.value = [];

      const onSelect = vi.fn(() => {});
      const { result } = renderHook(() =>
        useCommandAutocomplete({
          content: '/',
          onSelect,
        })
      );

      expect(result.current.showAutocomplete).toBe(false);
    });
  });

  describe('content changes', () => {
    it('should update filtered commands when content changes', () => {
      const onSelect = vi.fn(() => {});
      const { result, rerender } = renderHook(
        ({ content }) =>
          useCommandAutocomplete({
            content,
            onSelect,
          }),
        { initialProps: { content: '/' } }
      );

      expect(result.current.filteredCommands.length).toBe(5);

      rerender({ content: '/he' });

      expect(result.current.filteredCommands).toEqual(['/help']);
    });

    it('should reset selectedIndex when content changes', () => {
      const onSelect = vi.fn(() => {});
      const { result, rerender } = renderHook(
        ({ content }) =>
          useCommandAutocomplete({
            content,
            onSelect,
          }),
        { initialProps: { content: '/' } }
      );

      act(() => {
        result.current.setSelectedIndex(2);
      });

      expect(result.current.selectedIndex).toBe(2);

      rerender({ content: '/h' });

      expect(result.current.selectedIndex).toBe(0);
    });
  });
});
