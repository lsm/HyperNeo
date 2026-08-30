// @ts-nocheck

import { cleanup, render } from '@testing-library/preact';
import ConnectionStatus from '../ConnectionStatus';

describe('ConnectionStatus', () => {
  beforeEach(() => {
    cleanup();
  });

  afterEach(() => {
    cleanup();
  });

  describe('Connection States', () => {
    it('should show "Ready" when connected and idle', () => {
      const { container } = render(
        <ConnectionStatus connectionState="connected" isProcessing={false} />
      );

      expect(container.textContent).toContain('Ready');
    });

    it('should show green dot when connected', () => {
      const { container } = render(
        <ConnectionStatus connectionState="connected" isProcessing={false} />
      );

      const dot = container.querySelector('.bg-success');
      expect(dot).toBeTruthy();
    });

    it('should show "Connecting..." when connecting', () => {
      const { container } = render(
        <ConnectionStatus connectionState="connecting" isProcessing={false} />
      );

      expect(container.textContent).toContain('Connecting...');
    });

    it('should show yellow pulsing dot when connecting', () => {
      const { container } = render(
        <ConnectionStatus connectionState="connecting" isProcessing={false} />
      );

      const dot = container.querySelector('.bg-warning');
      expect(dot).toBeTruthy();
      expect(dot?.className).toContain('animate-pulse');
    });

    it('should show "Offline" when disconnected', () => {
      const { container } = render(
        <ConnectionStatus connectionState="disconnected" isProcessing={false} />
      );

      expect(container.textContent).toContain('Offline');
    });

    it('should show gray dot when disconnected', () => {
      const { container } = render(
        <ConnectionStatus connectionState="disconnected" isProcessing={false} />
      );

      const dot = container.querySelector('.bg-fg-faint');
      expect(dot).toBeTruthy();
    });

    it('should show "Reconnecting..." when reconnecting', () => {
      const { container } = render(
        <ConnectionStatus connectionState="reconnecting" isProcessing={false} />
      );

      expect(container.textContent).toContain('Reconnecting...');
    });

    it('should show yellow pulsing dot when reconnecting', () => {
      const { container } = render(
        <ConnectionStatus connectionState="reconnecting" isProcessing={false} />
      );

      const dot = container.querySelector('.bg-warning');
      expect(dot).toBeTruthy();
      expect(dot?.className).toContain('animate-pulse');
    });

    it('should show "Connection Failed" when failed', () => {
      const { container } = render(
        <ConnectionStatus connectionState="failed" isProcessing={false} />
      );

      expect(container.textContent).toContain('Connection Failed');
    });

    it('should show red dot when failed', () => {
      const { container } = render(
        <ConnectionStatus connectionState="failed" isProcessing={false} />
      );

      const dot = container.querySelector('.bg-danger');
      expect(dot).toBeTruthy();
    });

    it('should show "Connection Failed" when error', () => {
      const { container } = render(
        <ConnectionStatus connectionState="error" isProcessing={false} />
      );

      expect(container.textContent).toContain('Connection Failed');
    });

    it('should show red dot when error', () => {
      const { container } = render(
        <ConnectionStatus connectionState="error" isProcessing={false} />
      );

      const dot = container.querySelector('.bg-danger');
      expect(dot).toBeTruthy();
    });
  });

  describe('Processing States', () => {
    it('should show current action when processing', () => {
      const { container } = render(
        <ConnectionStatus
          connectionState="connected"
          isProcessing={true}
          currentAction="Reading files..."
        />
      );

      expect(container.textContent).toContain('Reading files...');
    });

    it('should show blue pulsing dot for default processing', () => {
      const { container } = render(
        <ConnectionStatus
          connectionState="connected"
          isProcessing={true}
          currentAction="Processing..."
        />
      );

      const dot = container.querySelector('.bg-accent');
      expect(dot).toBeTruthy();
      expect(dot?.className).toContain('animate-pulse');
    });

    it('should prioritize processing state over connection state', () => {
      const { container } = render(
        <ConnectionStatus
          connectionState="connected"
          isProcessing={true}
          currentAction="Thinking..."
        />
      );

      expect(container.textContent).toContain('Thinking...');
      expect(container.textContent).not.toContain('Online');
    });
  });

  describe('Processing Phases', () => {
    it('should show yellow styling for initializing phase', () => {
      const { container } = render(
        <ConnectionStatus
          connectionState="connected"
          isProcessing={true}
          currentAction="Initializing..."
          streamingPhase="initializing"
        />
      );

      const dot = container.querySelector('.bg-warning');
      expect(dot).toBeTruthy();

      const text = container.querySelector('.text-warning');
      expect(text).toBeTruthy();
    });

    it('should show blue styling for thinking phase', () => {
      const { container } = render(
        <ConnectionStatus
          connectionState="connected"
          isProcessing={true}
          currentAction="Thinking..."
          streamingPhase="thinking"
        />
      );

      const dot = container.querySelector('.bg-accent');
      expect(dot).toBeTruthy();

      const text = container.querySelector('.text-accent');
      expect(text).toBeTruthy();
    });

    it('should show green styling for streaming phase', () => {
      const { container } = render(
        <ConnectionStatus
          connectionState="connected"
          isProcessing={true}
          currentAction="Streaming..."
          streamingPhase="streaming"
        />
      );

      const dot = container.querySelector('.bg-success');
      expect(dot).toBeTruthy();

      const text = container.querySelector('.text-success');
      expect(text).toBeTruthy();
    });

    it('should show purple styling for finalizing phase', () => {
      const { container } = render(
        <ConnectionStatus
          connectionState="connected"
          isProcessing={true}
          currentAction="Finalizing..."
          streamingPhase="finalizing"
        />
      );

      const dot = container.querySelector('.bg-cat-purple');
      expect(dot).toBeTruthy();

      const text = container.querySelector('.text-cat-purple');
      expect(text).toBeTruthy();
    });
  });

  describe('Text Colors', () => {
    it('should render green "Ready" text when connected and idle', () => {
      const { container } = render(
        <ConnectionStatus connectionState="connected" isProcessing={false} />
      );

      const text = container.querySelector('.text-success');
      expect(text).toBeTruthy();
      expect(text?.textContent).toBe('Ready');
    });

    it('should have yellow text when connecting', () => {
      const { container } = render(
        <ConnectionStatus connectionState="connecting" isProcessing={false} />
      );

      const text = container.querySelector('.text-warning');
      expect(text).toBeTruthy();
    });

    it('should have gray text when disconnected', () => {
      const { container } = render(
        <ConnectionStatus connectionState="disconnected" isProcessing={false} />
      );

      const text = container.querySelector('.text-fg-muted');
      expect(text).toBeTruthy();
    });

    it('should have red text when failed', () => {
      const { container } = render(
        <ConnectionStatus connectionState="failed" isProcessing={false} />
      );

      const text = container.querySelector('.text-danger');
      expect(text).toBeTruthy();
    });
  });

  describe('Layout', () => {
    it('should have flex layout with gap', () => {
      const { container } = render(
        <ConnectionStatus connectionState="connected" isProcessing={false} />
      );

      const wrapper = container.firstElementChild;
      expect(wrapper?.className).toContain('flex');
      expect(wrapper?.className).toContain('items-center');
      expect(wrapper?.className).toContain('gap-2');
    });

    it('should have properly sized status dot', () => {
      const { container } = render(
        <ConnectionStatus connectionState="connected" isProcessing={false} />
      );

      const dot = container.querySelector('.w-2.h-2');
      expect(dot).toBeTruthy();
    });

    it('should have properly styled text when not connected', () => {
      const { container } = render(
        <ConnectionStatus connectionState="disconnected" isProcessing={false} />
      );

      const text = container.querySelector('.text-xs.font-medium');
      expect(text).toBeTruthy();
    });
  });

  describe('Edge Cases', () => {
    it('should not show action when isProcessing is false', () => {
      const { container } = render(
        <ConnectionStatus
          connectionState="connected"
          isProcessing={false}
          currentAction="Some action"
        />
      );

      expect(container.textContent).toContain('Ready');
      expect(container.textContent).not.toContain('Some action');
    });

    it('should not show action when currentAction is undefined', () => {
      const { container } = render(
        <ConnectionStatus connectionState="connected" isProcessing={true} />
      );

      expect(container.textContent).toContain('Ready');
    });

    it('should handle phase without processing state', () => {
      const { container } = render(
        <ConnectionStatus
          connectionState="connected"
          isProcessing={false}
          streamingPhase="thinking"
        />
      );

      expect(container.textContent).toContain('Ready');
    });

    it('should handle null streamingPhase', () => {
      const { container } = render(
        <ConnectionStatus
          connectionState="connected"
          isProcessing={true}
          currentAction="Processing..."
          streamingPhase={null}
        />
      );

      const dot = container.querySelector('.bg-accent');
      expect(dot).toBeTruthy();
    });

    it('should fall back to the processing tone for an unrecognized streaming phase', () => {
      const { container } = render(
        <ConnectionStatus
          connectionState="connected"
          isProcessing={true}
          currentAction="Working..."
          streamingPhase={'compacting-legacy' as unknown as 'thinking'}
        />
      );

      const dot = container.querySelector('.bg-accent');
      expect(dot).toBeTruthy();
      expect(container.textContent).toContain('Working...');
    });
  });
});
