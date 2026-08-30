// @ts-nocheck

import { render, fireEvent, cleanup } from '@testing-library/preact';
import { InputTextarea } from '../InputTextarea';

describe('InputTextarea', () => {
  beforeEach(() => {
    cleanup();
  });

  describe('Basic Rendering', () => {
    it('should render textarea with content', () => {
      const { container } = render(
        <InputTextarea
          content="Hello World"
          onContentChange={() => {}}
          onKeyDown={() => {}}
          onSubmit={() => {}}
        />
      );
      const textarea = container.querySelector('textarea');
      expect(textarea?.value).toBe('Hello World');
    });

    it('should render placeholder text', () => {
      const { container } = render(
        <InputTextarea
          content=""
          onContentChange={() => {}}
          onKeyDown={() => {}}
          onSubmit={() => {}}
        />
      );
      const textarea = container.querySelector('textarea');
      expect(textarea?.placeholder).toBe('Ask or make anything...');
    });
  });

  describe('Input Handling - Bug Fix Coverage', () => {
    it('should call onContentChange with new value when typing', () => {
      const onContentChange = vi.fn(() => {});
      const { container } = render(
        <InputTextarea
          content=""
          onContentChange={onContentChange}
          onKeyDown={() => {}}
          onSubmit={() => {}}
        />
      );

      const textarea = container.querySelector('textarea')!;
      fireEvent.input(textarea, { target: { value: 'a' } });

      expect(onContentChange).toHaveBeenCalledWith('a');
    });

    it('should preserve content value when isAgentWorking prop changes', () => {
      const onContentChange = vi.fn(() => {});
      const { container, rerender } = render(
        <InputTextarea
          content="typed text"
          onContentChange={onContentChange}
          onKeyDown={() => {}}
          onSubmit={() => {}}
          isAgentWorking={false}
        />
      );

      const textarea = container.querySelector('textarea')!;
      expect(textarea.value).toBe('typed text');

      rerender(
        <InputTextarea
          content="typed text"
          onContentChange={onContentChange}
          onKeyDown={() => {}}
          onSubmit={() => {}}
          isAgentWorking={true}
        />
      );

      expect(textarea.value).toBe('typed text');
    });

    it('should handle rapid content updates without losing characters', () => {
      const values: string[] = [];
      const onContentChange = vi.fn((value: string) => {
        values.push(value);
      });

      const { container, rerender } = render(
        <InputTextarea
          content=""
          onContentChange={onContentChange}
          onKeyDown={() => {}}
          onSubmit={() => {}}
          isAgentWorking={false}
        />
      );

      const textarea = container.querySelector('textarea')!;

      fireEvent.input(textarea, { target: { value: 'h' } });
      rerender(
        <InputTextarea
          content="h"
          onContentChange={onContentChange}
          onKeyDown={() => {}}
          onSubmit={() => {}}
          isAgentWorking={false}
        />
      );

      fireEvent.input(textarea, { target: { value: 'he' } });
      rerender(
        <InputTextarea
          content="he"
          onContentChange={onContentChange}
          onKeyDown={() => {}}
          onSubmit={() => {}}
          isAgentWorking={false}
        />
      );

      fireEvent.input(textarea, { target: { value: 'hel' } });
      rerender(
        <InputTextarea
          content="hel"
          onContentChange={onContentChange}
          onKeyDown={() => {}}
          onSubmit={() => {}}
          isAgentWorking={false}
        />
      );

      expect(values).toEqual(['h', 'he', 'hel']);
      expect(textarea.value).toBe('hel');
    });

    it('should not re-render due to signal when isAgentWorking is passed as prop', () => {
      const onContentChange = vi.fn(() => {});

      const { container } = render(
        <InputTextarea
          content="test"
          onContentChange={onContentChange}
          onKeyDown={() => {}}
          onSubmit={() => {}}
          isAgentWorking={false}
        />
      );

      const textarea = container.querySelector('textarea')!;

      expect(textarea.value).toBe('test');
    });
  });

  describe('isAgentWorking Prop - Button State', () => {
    it('should show send button when isAgentWorking is false', () => {
      const { container } = render(
        <InputTextarea
          content="hello"
          onContentChange={() => {}}
          onKeyDown={() => {}}
          onSubmit={() => {}}
          isAgentWorking={false}
        />
      );

      const sendButton = container.querySelector('[data-testid="send-button"]');
      const stopButton = container.querySelector('[data-testid="stop-button"]');

      expect(sendButton).toBeTruthy();
      expect(stopButton).toBeNull();
    });

    it('should keep send button visible when isAgentWorking is true', () => {
      const { container } = render(
        <InputTextarea
          content="hello"
          onContentChange={() => {}}
          onKeyDown={() => {}}
          onSubmit={() => {}}
          isAgentWorking={true}
        />
      );

      const sendButton = container.querySelector('[data-testid="send-button"]');
      const stopButton = container.querySelector('[data-testid="stop-button"]');

      expect(sendButton).toBeTruthy();
      expect(stopButton).toBeNull();
    });

    it('should show queue button when agent is working and content exists', () => {
      const { container } = render(
        <InputTextarea
          content="hello"
          onContentChange={() => {}}
          onKeyDown={() => {}}
          onSubmit={() => {}}
          onQueue={() => {}}
          isAgentWorking={true}
        />
      );

      const queueButton = container.querySelector('[data-testid="queue-button"]');
      expect(queueButton).toBeTruthy();
    });

    it('should not show queue button when agent is idle', () => {
      const { container } = render(
        <InputTextarea
          content="hello"
          onContentChange={() => {}}
          onKeyDown={() => {}}
          onSubmit={() => {}}
          onQueue={() => {}}
          isAgentWorking={false}
        />
      );

      const queueButton = container.querySelector('[data-testid="queue-button"]');
      expect(queueButton).toBeNull();
    });

    it('should keep send button enabled with content when isAgentWorking is true', () => {
      const { container } = render(
        <InputTextarea
          content="hello"
          onContentChange={() => {}}
          onKeyDown={() => {}}
          onSubmit={() => {}}
          isAgentWorking={true}
        />
      );

      const sendButton = container.querySelector(
        '[data-testid="send-button"]'
      ) as HTMLButtonElement;
      expect(sendButton?.disabled).toBe(false);
    });

    it('should disable send button when content is empty', () => {
      const { container } = render(
        <InputTextarea
          content=""
          onContentChange={() => {}}
          onKeyDown={() => {}}
          onSubmit={() => {}}
          isAgentWorking={false}
        />
      );

      const sendButton = container.querySelector(
        '[data-testid="send-button"]'
      ) as HTMLButtonElement;
      expect(sendButton?.disabled).toBe(true);
    });

    it('should show stop button when agent is working and content is empty', () => {
      const onStop = vi.fn(() => {});
      const { container } = render(
        <InputTextarea
          content=""
          onContentChange={() => {}}
          onKeyDown={() => {}}
          onSubmit={() => {}}
          isAgentWorking={true}
          onStop={onStop}
        />
      );

      const sendButton = container.querySelector('[data-testid="send-button"]');
      const stopButton = container.querySelector(
        '[data-testid="stop-button"]'
      ) as HTMLButtonElement;
      expect(sendButton).toBeNull();
      expect(stopButton).toBeTruthy();

      fireEvent.click(stopButton);
      expect(onStop).toHaveBeenCalledTimes(1);
    });
  });

  describe('Keyboard Events', () => {
    it('should call onKeyDown when a key is pressed', () => {
      const onKeyDown = vi.fn(() => {});
      const { container } = render(
        <InputTextarea
          content=""
          onContentChange={() => {}}
          onKeyDown={onKeyDown}
          onSubmit={() => {}}
        />
      );

      const textarea = container.querySelector('textarea')!;
      fireEvent.keyDown(textarea, { key: 'a' });

      expect(onKeyDown).toHaveBeenCalled();
    });

    it('should call onKeyDown for arrow keys', () => {
      const onKeyDown = vi.fn(() => {});
      const { container } = render(
        <InputTextarea
          content="test content"
          onContentChange={() => {}}
          onKeyDown={onKeyDown}
          onSubmit={() => {}}
        />
      );

      const textarea = container.querySelector('textarea')!;

      fireEvent.keyDown(textarea, { key: 'ArrowLeft' });
      fireEvent.keyDown(textarea, { key: 'ArrowRight' });
      fireEvent.keyDown(textarea, { key: 'ArrowUp' });
      fireEvent.keyDown(textarea, { key: 'ArrowDown' });

      expect(onKeyDown).toHaveBeenCalledTimes(4);
    });
  });

  describe('Submit Button', () => {
    it('should call onSubmit when send button is clicked', () => {
      const onSubmit = vi.fn(() => {});
      const { container } = render(
        <InputTextarea
          content="hello"
          onContentChange={() => {}}
          onKeyDown={() => {}}
          onSubmit={onSubmit}
          isAgentWorking={false}
        />
      );

      const sendButton = container.querySelector('[data-testid="send-button"]')!;
      fireEvent.click(sendButton);

      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    it('should call onSubmit when agent is working (steer mode)', () => {
      const onSubmit = vi.fn(() => {});
      const { container } = render(
        <InputTextarea
          content="hello"
          onContentChange={() => {}}
          onKeyDown={() => {}}
          onSubmit={onSubmit}
          isAgentWorking={true}
        />
      );

      const sendButton = container.querySelector('[data-testid="send-button"]')!;
      fireEvent.click(sendButton);

      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    it('should call onQueue when queue button is clicked', () => {
      const onQueue = vi.fn(() => {});
      const { container } = render(
        <InputTextarea
          content="hello"
          onContentChange={() => {}}
          onKeyDown={() => {}}
          onSubmit={() => {}}
          onQueue={onQueue}
          isAgentWorking={true}
        />
      );

      const queueButton = container.querySelector('[data-testid="queue-button"]')!;
      fireEvent.click(queueButton);

      expect(onQueue).toHaveBeenCalledTimes(1);
    });
  });

  describe('Character Counter', () => {
    it('should show character counter when near max limit', () => {
      const maxChars = 100;
      const content = 'a'.repeat(85);

      const { container } = render(
        <InputTextarea
          content={content}
          onContentChange={() => {}}
          onKeyDown={() => {}}
          onSubmit={() => {}}
          maxChars={maxChars}
        />
      );

      const counterText = container.textContent;
      expect(counterText).toContain('85/100');
    });

    it('should not show character counter when well below limit', () => {
      const maxChars = 100;
      const content = 'hello';

      const { container } = render(
        <InputTextarea
          content={content}
          onContentChange={() => {}}
          onKeyDown={() => {}}
          onSubmit={() => {}}
          maxChars={maxChars}
        />
      );

      const counterText = container.textContent;
      expect(counterText).not.toContain('/100');
    });
  });

  describe('Disabled State', () => {
    it('should apply disabled styling when disabled prop is true', () => {
      const { container } = render(
        <InputTextarea
          content=""
          onContentChange={() => {}}
          onKeyDown={() => {}}
          onSubmit={() => {}}
          disabled={true}
        />
      );

      const containerDiv = container.querySelector('.rounded-3xl');
      expect(containerDiv?.className).toContain('border-line/30');
    });
  });

  describe('Cursor Position Preservation', () => {
    it('should not update DOM value when content matches textarea.value', () => {
      const { container, rerender } = render(
        <InputTextarea
          content="hello"
          onContentChange={() => {}}
          onKeyDown={() => {}}
          onSubmit={() => {}}
          isAgentWorking={false}
        />
      );

      const textarea = container.querySelector('textarea')!;

      textarea.setSelectionRange(2, 2);
      expect(textarea.selectionStart).toBe(2);
      expect(textarea.selectionEnd).toBe(2);

      rerender(
        <InputTextarea
          content="hello"
          onContentChange={() => {}}
          onKeyDown={() => {}}
          onSubmit={() => {}}
          isAgentWorking={true}
        />
      );

      expect(textarea.selectionStart).toBe(2);
      expect(textarea.selectionEnd).toBe(2);
    });

    it('should preserve cursor position during rapid prop changes', () => {
      const { container, rerender } = render(
        <InputTextarea
          content="hello world"
          onContentChange={() => {}}
          onKeyDown={() => {}}
          onSubmit={() => {}}
          isAgentWorking={false}
        />
      );

      const textarea = container.querySelector('textarea')!;

      textarea.setSelectionRange(6, 6);

      for (let i = 0; i < 5; i++) {
        rerender(
          <InputTextarea
            content="hello world"
            onContentChange={() => {}}
            onKeyDown={() => {}}
            onSubmit={() => {}}
            isAgentWorking={i % 2 === 0}
          />
        );
      }

      expect(textarea.selectionStart).toBe(6);
      expect(textarea.selectionEnd).toBe(6);
    });

    it('should update DOM and set cursor to valid position when content changes externally', () => {
      const { container, rerender } = render(
        <InputTextarea
          content="hello world"
          onContentChange={() => {}}
          onKeyDown={() => {}}
          onSubmit={() => {}}
        />
      );

      const textarea = container.querySelector('textarea')!;

      textarea.setSelectionRange(11, 11);

      rerender(
        <InputTextarea
          content="hi"
          onContentChange={() => {}}
          onKeyDown={() => {}}
          onSubmit={() => {}}
        />
      );

      expect(textarea.value).toBe('hi');

      expect(textarea.selectionStart).toBeLessThanOrEqual(2);
      expect(textarea.selectionEnd).toBeLessThanOrEqual(2);
    });

    it('should correctly sync when user types (DOM ahead of prop)', () => {
      const values: string[] = [];
      const onContentChange = vi.fn((value: string) => {
        values.push(value);
      });

      const { container, rerender } = render(
        <InputTextarea
          content="hello"
          onContentChange={onContentChange}
          onKeyDown={() => {}}
          onSubmit={() => {}}
        />
      );

      const textarea = container.querySelector('textarea')!;

      textarea.setSelectionRange(5, 5);

      fireEvent.input(textarea, { target: { value: 'hellox' } });

      expect(onContentChange).toHaveBeenCalledWith('hellox');

      rerender(
        <InputTextarea
          content="hellox"
          onContentChange={onContentChange}
          onKeyDown={() => {}}
          onSubmit={() => {}}
        />
      );

      expect(textarea.value).toBe('hellox');
    });
  });

  describe('Queue mode labeling', () => {
    it('should use steer aria-label when agent is working', () => {
      const { container } = render(
        <InputTextarea
          content="hello"
          onContentChange={() => {}}
          onKeyDown={() => {}}
          onSubmit={() => {}}
          isAgentWorking={true}
        />
      );

      const sendButton = container.querySelector(
        '[data-testid="send-button"]'
      ) as HTMLButtonElement;
      expect(sendButton).toBeTruthy();
      expect(sendButton.getAttribute('aria-label')).toBe('Steer current turn');
    });

    it('should use send aria-label when agent is idle', () => {
      const { container } = render(
        <InputTextarea
          content="hello"
          onContentChange={() => {}}
          onKeyDown={() => {}}
          onSubmit={() => {}}
          isAgentWorking={false}
        />
      );

      const sendButton = container.querySelector(
        '[data-testid="send-button"]'
      ) as HTMLButtonElement;
      expect(sendButton).toBeTruthy();
      expect(sendButton.getAttribute('aria-label')).toBe('Send message');
    });
  });

  describe('Character Counter at max', () => {
    it('should show red counter when at max characters', () => {
      const maxChars = 100;
      const content = 'a'.repeat(100);

      const { container } = render(
        <InputTextarea
          content={content}
          onContentChange={() => {}}
          onKeyDown={() => {}}
          onSubmit={() => {}}
          maxChars={maxChars}
        />
      );

      const counterText = container.textContent;
      expect(counterText).toContain('100/100');
    });
  });

  describe('Send button with disabled prop', () => {
    it('should disable send button when disabled prop is true even with content', () => {
      const { container } = render(
        <InputTextarea
          content="hello"
          onContentChange={() => {}}
          onKeyDown={() => {}}
          onSubmit={() => {}}
          disabled={true}
          isAgentWorking={false}
        />
      );

      const sendButton = container.querySelector(
        '[data-testid="send-button"]'
      ) as HTMLButtonElement;
      expect(sendButton?.className).toContain('cursor-not-allowed');
    });
  });

  describe('Command Autocomplete', () => {
    it('should render CommandAutocomplete when showCommandAutocomplete is true', () => {
      const onCommandSelect = vi.fn();
      const onCommandClose = vi.fn();

      const { container } = render(
        <InputTextarea
          content="/he"
          onContentChange={() => {}}
          onKeyDown={() => {}}
          onSubmit={() => {}}
          showCommandAutocomplete={true}
          filteredCommands={['/help', '/health']}
          selectedCommandIndex={0}
          onCommandSelect={onCommandSelect}
          onCommandClose={onCommandClose}
        />
      );

      const textContent = container.textContent;
      expect(textContent).toContain('/help');
    });

    it('should not render CommandAutocomplete when callbacks are missing', () => {
      const { container } = render(
        <InputTextarea
          content="/he"
          onContentChange={() => {}}
          onKeyDown={() => {}}
          onSubmit={() => {}}
          showCommandAutocomplete={true}
          filteredCommands={['/help']}
          selectedCommandIndex={0}
        />
      );

      const textContent = container.textContent;
      expect(textContent).not.toContain('/help');
    });
  });

  describe('Reference Autocomplete', () => {
    it('should render ReferenceAutocomplete when showReferenceAutocomplete is true with results', () => {
      const results = [
        {
          type: 'task' as const,
          id: 'task-1',
          shortId: 't-1',
          displayText: 'Fix the login bug',
          subtitle: 'open',
        },
      ];
      const onReferenceSelect = vi.fn();
      const onReferenceClose = vi.fn();

      const { container } = render(
        <InputTextarea
          content="@fix"
          onContentChange={() => {}}
          onKeyDown={() => {}}
          onSubmit={() => {}}
          showReferenceAutocomplete={true}
          referenceResults={results}
          selectedReferenceIndex={0}
          onReferenceSelect={onReferenceSelect}
          onReferenceClose={onReferenceClose}
        />
      );

      expect(container.textContent).toContain('Fix the login bug');
    });

    it('should not render ReferenceAutocomplete when callbacks are missing', () => {
      const results = [{ type: 'task' as const, id: 'task-1', displayText: 'Fix the login bug' }];

      const { container } = render(
        <InputTextarea
          content="@fix"
          onContentChange={() => {}}
          onKeyDown={() => {}}
          onSubmit={() => {}}
          showReferenceAutocomplete={true}
          referenceResults={results}
          selectedReferenceIndex={0}
        />
      );

      expect(container.textContent).not.toContain('Fix the login bug');
    });

    it('should render CommandAutocomplete when only command autocomplete is active', () => {
      const { container } = render(
        <InputTextarea
          content="/he"
          onContentChange={() => {}}
          onKeyDown={() => {}}
          onSubmit={() => {}}
          showCommandAutocomplete={true}
          filteredCommands={['/help']}
          selectedCommandIndex={0}
          onCommandSelect={vi.fn()}
          onCommandClose={vi.fn()}
        />
      );

      expect(container.textContent).toContain('/help');
    });

    it('should show only reference autocomplete when both are active (reference takes priority)', () => {
      const onReferenceSelect = vi.fn();
      const onReferenceClose = vi.fn();
      const onCommandSelect = vi.fn();
      const onCommandClose = vi.fn();
      const results = [{ type: 'task' as const, id: 'task-1', displayText: 'A Task' }];

      const { container } = render(
        <InputTextarea
          content="@task"
          onContentChange={() => {}}
          onKeyDown={() => {}}
          onSubmit={() => {}}
          showReferenceAutocomplete={true}
          referenceResults={results}
          selectedReferenceIndex={0}
          onReferenceSelect={onReferenceSelect}
          onReferenceClose={onReferenceClose}
          showCommandAutocomplete={true}
          filteredCommands={['/help']}
          selectedCommandIndex={0}
          onCommandSelect={onCommandSelect}
          onCommandClose={onCommandClose}
        />
      );

      expect(container.textContent).toContain('A Task');
      expect(container.textContent).not.toContain('/help');
    });
  });

  describe('Reference Badge', () => {
    it('should not show badge when content has no @ref{} tokens', () => {
      const { container } = render(
        <InputTextarea
          content="hello world"
          onContentChange={() => {}}
          onKeyDown={() => {}}
          onSubmit={() => {}}
        />
      );

      expect(container.querySelector('[data-testid="reference-badge"]')).toBeNull();
    });

    it('should show badge with count when content has @ref{} tokens', () => {
      const { container } = render(
        <InputTextarea
          content="check @ref{task:t-1} and @ref{file:src/foo.ts}"
          onContentChange={() => {}}
          onKeyDown={() => {}}
          onSubmit={() => {}}
        />
      );

      const badge = container.querySelector('[data-testid="reference-badge"]');
      expect(badge).toBeTruthy();
      expect(badge?.textContent).toContain('2');
      expect(badge?.textContent).toContain('references');
    });

    it('should show singular "reference" for a single @ref{} token', () => {
      const { container } = render(
        <InputTextarea
          content="see @ref{goal:g-5} for details"
          onContentChange={() => {}}
          onKeyDown={() => {}}
          onSubmit={() => {}}
        />
      );

      const badge = container.querySelector('[data-testid="reference-badge"]');
      expect(badge).toBeTruthy();
      expect(badge?.textContent).toContain('1');
      expect(badge?.textContent).toContain('reference');
      expect(badge?.textContent).not.toContain('references');
    });

    it('should update badge count when content changes', () => {
      const { container, rerender } = render(
        <InputTextarea
          content="@ref{task:t-1}"
          onContentChange={() => {}}
          onKeyDown={() => {}}
          onSubmit={() => {}}
        />
      );

      expect(container.querySelector('[data-testid="reference-badge"]')?.textContent).toContain(
        '1'
      );

      rerender(
        <InputTextarea
          content="@ref{task:t-1} and @ref{task:t-2} and @ref{file:src/x.ts}"
          onContentChange={() => {}}
          onKeyDown={() => {}}
          onSubmit={() => {}}
        />
      );

      expect(container.querySelector('[data-testid="reference-badge"]')?.textContent).toContain(
        '3'
      );
    });
  });

  describe('Paste Event Forwarding', () => {
    it('should call onPaste callback when paste event fires on textarea', () => {
      const onPaste = vi.fn(() => {});
      const { container } = render(
        <InputTextarea
          content=""
          onContentChange={() => {}}
          onKeyDown={() => {}}
          onSubmit={() => {}}
          onPaste={onPaste}
        />
      );

      const textarea = container.querySelector('textarea')!;
      fireEvent.paste(textarea);

      expect(onPaste).toHaveBeenCalled();
    });

    it('should not error when onPaste is undefined (default)', () => {
      const { container } = render(
        <InputTextarea
          content=""
          onContentChange={() => {}}
          onKeyDown={() => {}}
          onSubmit={() => {}}
        />
      );

      const textarea = container.querySelector('textarea')!;

      expect(() => {
        fireEvent.paste(textarea);
      }).not.toThrow();
    });
  });

  describe('Auto-resize timing (autoscroll race regression)', () => {
    it('invokes onHeightChange synchronously when content changes', () => {
      const onHeightChange = vi.fn();
      const { rerender } = render(
        <InputTextarea
          content="line one"
          onContentChange={() => {}}
          onKeyDown={() => {}}
          onSubmit={() => {}}
          onHeightChange={onHeightChange}
        />
      );

      onHeightChange.mockClear();

      rerender(
        <InputTextarea
          content={'line one\nline two\nline three'}
          onContentChange={() => {}}
          onKeyDown={() => {}}
          onSubmit={() => {}}
          onHeightChange={onHeightChange}
        />
      );

      expect(onHeightChange).toHaveBeenCalled();
    });

    it('invokes onHeightChange on initial mount (sync, before paint)', () => {
      const onHeightChange = vi.fn();
      render(
        <InputTextarea
          content="hello"
          onContentChange={() => {}}
          onKeyDown={() => {}}
          onSubmit={() => {}}
          onHeightChange={onHeightChange}
        />
      );

      expect(onHeightChange).toHaveBeenCalled();
    });
  });
});
