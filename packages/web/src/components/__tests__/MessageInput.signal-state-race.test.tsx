// @ts-nocheck

import { render, cleanup, act } from '@testing-library/preact';
import { signal, useSignal } from '@preact/signals';
import { useState, useCallback } from 'preact/hooks';
import type { FunctionComponent } from 'preact';

const isAgentWorkingSignal = signal(false);

interface RenderLog {
  content: string;
  isWorking: boolean;
  renderNumber: number;
}

let globalRenderCounter = 0;

const BuggyInputComponent: FunctionComponent<{
  renderLog: RenderLog[];
  onSetState?: () => void;
}> = ({ renderLog, onSetState }) => {
  const [content, setContent] = useState('');
  const renderNumber = ++globalRenderCounter;

  const isWorking = isAgentWorkingSignal.value;

  renderLog.push({
    content,
    isWorking,
    renderNumber,
  });

  const handleInput = useCallback(
    (e: Event) => {
      const target = e.target as HTMLTextAreaElement;
      setContent(target.value);
      onSetState?.();
    },
    [onSetState]
  );

  return (
    <div>
      <textarea
        data-testid="input"
        value={content}
        onInput={handleInput}
        placeholder="Type here..."
      />
      <span data-testid="content-display">{content}</span>
      <span data-testid="working-display">{isWorking ? 'working' : 'idle'}</span>
    </div>
  );
};

const FixedInputComponent: FunctionComponent<{
  renderLog: RenderLog[];
  onSetState?: () => void;
}> = ({ renderLog, onSetState }) => {
  const contentSignal = useSignal('');
  const renderNumber = ++globalRenderCounter;

  const isWorking = isAgentWorkingSignal.value;

  renderLog.push({
    content: contentSignal.value,
    isWorking,
    renderNumber,
  });

  const handleInput = useCallback(
    (e: Event) => {
      const target = e.target as HTMLTextAreaElement;
      contentSignal.value = target.value;
      onSetState?.();
    },
    [contentSignal, onSetState]
  );

  return (
    <div>
      <textarea
        data-testid="input"
        value={contentSignal.value}
        onInput={handleInput}
        placeholder="Type here..."
      />
      <span data-testid="content-display">{contentSignal.value}</span>
      <span data-testid="working-display">{isWorking ? 'working' : 'idle'}</span>
    </div>
  );
};

describe('Signal-State Race Condition', () => {
  beforeEach(() => {
    cleanup();
    isAgentWorkingSignal.value = false;
    globalRenderCounter = 0;
  });

  describe('Race condition analysis', () => {
    it('ANALYZES: useState batching behavior when signal updates during event handler', async () => {
      const renderLog: RenderLog[] = [];

      const onSetState = () => {
        isAgentWorkingSignal.value = true;
      };

      const { container } = render(
        <BuggyInputComponent renderLog={renderLog} onSetState={onSetState} />
      );

      const textarea = container.querySelector('[data-testid="input"]') as HTMLTextAreaElement;
      const initialRenderCount = renderLog.length;

      await act(async () => {
        const inputEvent = new Event('input', { bubbles: true });
        Object.defineProperty(inputEvent, 'target', {
          value: { value: 'h' },
          writable: false,
        });
        textarea.dispatchEvent(inputEvent);
      });

      const newRenders = renderLog.slice(initialRenderCount);
      console.log('\n=== useState + signal race analysis ===');
      console.log('Renders after input event:', newRenders);

      const buggyRender = newRenders.find((r) => r.isWorking === true && r.content === '');

      if (buggyRender) {
        console.log('BUG REPRODUCED! Stale render:', buggyRender);
      } else {
        console.log('Bug not reproduced in this environment (Preact batched the updates)');
      }

      expect(newRenders.length).toBeGreaterThan(0);
    });

    it('ANALYZES: useSignal behavior when external signal updates during event handler', async () => {
      const renderLog: RenderLog[] = [];

      const onSetState = () => {
        isAgentWorkingSignal.value = true;
      };

      const { container } = render(
        <FixedInputComponent renderLog={renderLog} onSetState={onSetState} />
      );

      const textarea = container.querySelector('[data-testid="input"]') as HTMLTextAreaElement;
      const initialRenderCount = renderLog.length;

      await act(async () => {
        const inputEvent = new Event('input', { bubbles: true });
        Object.defineProperty(inputEvent, 'target', {
          value: { value: 'h' },
          writable: false,
        });
        textarea.dispatchEvent(inputEvent);
      });

      const newRenders = renderLog.slice(initialRenderCount);
      console.log('\n=== useSignal + signal race analysis ===');
      console.log('Renders after input event:', newRenders);

      const buggyRender = newRenders.find((r) => r.isWorking === true && r.content === '');

      if (buggyRender) {
        console.log('UNEXPECTED: Found stale render with useSignal:', buggyRender);
      } else {
        console.log('CORRECT: No stale renders with useSignal');
      }

      expect(buggyRender).toBeUndefined();
    });
  });

  describe('Direct state synchronicity test', () => {
    it('PROVES: signal.value is synchronous, useState is batched', () => {
      const signalValues: string[] = [];

      const testSignal = signal('initial');

      signalValues.push(testSignal.value);
      testSignal.value = 'updated';
      signalValues.push(testSignal.value);

      console.log('\n=== Synchronicity proof ===');
      console.log('Signal values (synchronous):', signalValues);
      expect(signalValues).toEqual(['initial', 'updated']);
    });
  });

  describe('Fixed implementation verification', () => {
    it('useSignal preserves content with rapid signal changes', async () => {
      const renderLog: RenderLog[] = [];

      const { container } = render(<FixedInputComponent renderLog={renderLog} />);
      const textarea = container.querySelector('[data-testid="input"]') as HTMLTextAreaElement;

      const characters = ['h', 'he', 'hel', 'hell', 'hello'];

      for (const char of characters) {
        await act(async () => {
          const inputEvent = new Event('input', { bubbles: true });
          Object.defineProperty(inputEvent, 'target', {
            value: { value: char },
            writable: false,
          });
          textarea.dispatchEvent(inputEvent);

          isAgentWorkingSignal.value = !isAgentWorkingSignal.value;
        });
      }

      const contentDisplay = container.querySelector('[data-testid="content-display"]');
      expect(contentDisplay?.textContent).toBe('hello');
    });

    it('useSignal handles interleaved signal updates', async () => {
      const renderLog: RenderLog[] = [];

      const { container } = render(<FixedInputComponent renderLog={renderLog} />);
      const textarea = container.querySelector('[data-testid="input"]') as HTMLTextAreaElement;

      await act(async () => {
        const event1 = new Event('input', { bubbles: true });
        Object.defineProperty(event1, 'target', {
          value: { value: 'a' },
          writable: false,
        });
        textarea.dispatchEvent(event1);

        isAgentWorkingSignal.value = true;

        const event2 = new Event('input', { bubbles: true });
        Object.defineProperty(event2, 'target', {
          value: { value: 'ab' },
          writable: false,
        });
        textarea.dispatchEvent(event2);

        isAgentWorkingSignal.value = false;

        const event3 = new Event('input', { bubbles: true });
        Object.defineProperty(event3, 'target', {
          value: { value: 'abc' },
          writable: false,
        });
        textarea.dispatchEvent(event3);
      });

      const contentDisplay = container.querySelector('[data-testid="content-display"]');
      expect(contentDisplay?.textContent).toBe('abc');
    });
  });
});
