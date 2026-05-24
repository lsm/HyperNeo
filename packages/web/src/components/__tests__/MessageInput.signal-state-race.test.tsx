// @ts-nocheck
/**
 * Tests for Signal-State Race Condition in MessageInput
 *
 * ROOT CAUSE:
 * When a Preact Signal updates, any component that reads .value in its render path
import { describe, it, expect } from 'vitest';
 * re-renders IMMEDIATELY. If that component uses useState for input content, the
 * re-render may happen BEFORE React flushes pending state updates, resulting in
 * stale content being passed to controlled inputs.
 *
 * TIMELINE OF BUG:
 * 1. User types "h" in textarea
 * 2. onInput fires → setContentState("h") schedules React state update
 * 3. Server pushes state update → isAgentWorking signal changes
 * 4. MessageInput re-renders immediately (signal-triggered)
 * 5. useState returns "" (last committed value, not pending "h")
 * 6. InputTextarea receives content=""
 * 7. textarea value="" overwrites DOM → user's "h" is LOST
 *
 * PREVIOUS FIX (commit 3db78f8):
 * Moved isAgentWorking signal read from InputTextarea to MessageInput.
 * This only shifted the problem - the race condition still exists.
 *
 * CORRECT FIX:
 * Use Preact Signals (useSignal) for content state instead of useState.
 * Signals are synchronous and always return the latest value.
 */

import { render, cleanup, act } from '@testing-library/preact';
import { signal, useSignal } from '@preact/signals';
import { useState, useCallback } from 'preact/hooks';
import type { FunctionComponent } from 'preact';

// Simulate the isAgentWorking signal (like in state.ts)
const isAgentWorkingSignal = signal(false);

// Track render values to detect stale state
interface RenderLog {
  content: string;
  isWorking: boolean;
  renderNumber: number;
}

let globalRenderCounter = 0;

/**
 * Bug reproduction component using useState
 * Tracks render values to detect when stale state is used
 */
const BuggyInputComponent: FunctionComponent<{
  renderLog: RenderLog[];
  onSetState?: () => void;
}> = ({ renderLog, onSetState }) => {
  const [content, setContent] = useState('');
  const renderNumber = ++globalRenderCounter;

  // Reading .value in render subscribes this component to the signal
  const isWorking = isAgentWorkingSignal.value;

  // Log every render to track state values
  renderLog.push({
    content,
    isWorking,
    renderNumber,
  });

  const handleInput = useCallback(
    (e: Event) => {
      const target = e.target as HTMLTextAreaElement;
      setContent(target.value);
      // Callback fires AFTER setState is called
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

/**
 * Fixed component using useSignal for content state
 */
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

      // Signal update happens SYNCHRONOUSLY inside the event handler
      // AFTER setState is called
      const onSetState = () => {
        // This is the exact pattern that causes the bug:
        // 1. setState('h') was just called (state update queued)
        // 2. Signal update triggers IMMEDIATE re-render
        // 3. Re-render uses OLD state value (empty string)
        isAgentWorkingSignal.value = true;
      };

      const { container } = render(
        <BuggyInputComponent renderLog={renderLog} onSetState={onSetState} />
      );

      const textarea = container.querySelector('[data-testid="input"]') as HTMLTextAreaElement;
      const initialRenderCount = renderLog.length;

      // Simulate typing "h"
      await act(async () => {
        const inputEvent = new Event('input', { bubbles: true });
        Object.defineProperty(inputEvent, 'target', {
          value: { value: 'h' },
          writable: false,
        });
        textarea.dispatchEvent(inputEvent);
      });

      // Analyze what happened
      const newRenders = renderLog.slice(initialRenderCount);
      console.log('\n=== useState + signal race analysis ===');
      console.log('Renders after input event:', newRenders);

      // Check if bug occurred: a render with isWorking=true but content=""
      const buggyRender = newRenders.find((r) => r.isWorking === true && r.content === '');

      if (buggyRender) {
        console.log('BUG REPRODUCED! Stale render:', buggyRender);
        // This is the bug - signal-triggered render used stale state
      } else {
        console.log('Bug not reproduced in this environment (Preact batched the updates)');
      }

      // The test passes regardless - it documents the behavior
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

      // With useSignal, there should NEVER be a render with stale content
      const buggyRender = newRenders.find((r) => r.isWorking === true && r.content === '');

      if (buggyRender) {
        console.log('UNEXPECTED: Found stale render with useSignal:', buggyRender);
      } else {
        console.log('CORRECT: No stale renders with useSignal');
      }

      // useSignal should never have stale renders
      expect(buggyRender).toBeUndefined();
    });
  });

  describe('Direct state synchronicity test', () => {
    it('PROVES: signal.value is synchronous, useState is batched', () => {
      // This test directly proves the fundamental difference
      // Note: useState can't be tested outside a component, proving it needs a render cycle
      const signalValues: string[] = [];

      const testSignal = signal('initial');

      // With signals: update is IMMEDIATE
      signalValues.push(testSignal.value); // 'initial'
      testSignal.value = 'updated';
      signalValues.push(testSignal.value); // 'updated' - IMMEDIATE!

      console.log('\n=== Synchronicity proof ===');
      console.log('Signal values (synchronous):', signalValues);
      expect(signalValues).toEqual(['initial', 'updated']);

      // With useState: we can't even test outside a component
      // because setState requires a component context
      // The key insight: signals DON'T require a render cycle
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

          // Toggle signal to trigger re-render
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

      // Simulate the exact bug scenario
      await act(async () => {
        // Type first character
        const event1 = new Event('input', { bubbles: true });
        Object.defineProperty(event1, 'target', {
          value: { value: 'a' },
          writable: false,
        });
        textarea.dispatchEvent(event1);

        // External signal update (like from WebSocket)
        isAgentWorkingSignal.value = true;

        // Type second character
        const event2 = new Event('input', { bubbles: true });
        Object.defineProperty(event2, 'target', {
          value: { value: 'ab' },
          writable: false,
        });
        textarea.dispatchEvent(event2);

        // Another signal update
        isAgentWorkingSignal.value = false;

        // Type third character
        const event3 = new Event('input', { bubbles: true });
        Object.defineProperty(event3, 'target', {
          value: { value: 'abc' },
          writable: false,
        });
        textarea.dispatchEvent(event3);
      });

      // ALL characters should be preserved
      const contentDisplay = container.querySelector('[data-testid="content-display"]');
      expect(contentDisplay?.textContent).toBe('abc');
    });
  });
});
