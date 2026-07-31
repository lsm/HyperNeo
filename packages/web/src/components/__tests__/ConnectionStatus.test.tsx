// @ts-nocheck
/**
 * Tests for ConnectionStatus Component
 *
 * Tests the connection status indicator with various connection states
 * and processing states with phase-specific colors.
import { describe, it, expect } from 'vitest';
 */

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

      const dot = container.querySelector('.bg-green-500');
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

      const dot = container.querySelector('.bg-yellow-500');
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

      const dot = container.querySelector('.bg-gray-500');
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

      const dot = container.querySelector('.bg-yellow-500');
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

      const dot = container.querySelector('.bg-red-500');
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

      const dot = container.querySelector('.bg-red-500');
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

      // No streaming phase -> falls back to the generic 'processing' tone (info/blue).
      const dot = container.querySelector('.bg-blue-500');
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

      // Should show action, not "Online"
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

      const dot = container.querySelector('.bg-yellow-500');
      expect(dot).toBeTruthy();

      const text = container.querySelector('.text-yellow-400');
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

      const dot = container.querySelector('.bg-blue-500');
      expect(dot).toBeTruthy();

      const text = container.querySelector('.text-blue-400');
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

      const dot = container.querySelector('.bg-green-500');
      expect(dot).toBeTruthy();

      const text = container.querySelector('.text-green-400');
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

      const dot = container.querySelector('.bg-purple-500');
      expect(dot).toBeTruthy();

      const text = container.querySelector('.text-purple-400');
      expect(text).toBeTruthy();
    });
  });

  describe('Text Colors', () => {
    it('should render green "Ready" text when connected and idle', () => {
      const { container } = render(
        <ConnectionStatus connectionState="connected" isProcessing={false} />
      );

      const text = container.querySelector('.text-green-400');
      expect(text).toBeTruthy();
      expect(text?.textContent).toBe('Ready');
    });

    it('should have yellow text when connecting', () => {
      const { container } = render(
        <ConnectionStatus connectionState="connecting" isProcessing={false} />
      );

      const text = container.querySelector('.text-yellow-400');
      expect(text).toBeTruthy();
    });

    it('should have gray text when disconnected', () => {
      const { container } = render(
        <ConnectionStatus connectionState="disconnected" isProcessing={false} />
      );

      // neutral tone text -> text-gray-400
      const text = container.querySelector('.text-gray-400');
      expect(text).toBeTruthy();
    });

    it('should have red text when failed', () => {
      const { container } = render(
        <ConnectionStatus connectionState="failed" isProcessing={false} />
      );

      const text = container.querySelector('.text-red-400');
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

      // Should fall back to ready text and never show currentAction
      expect(container.textContent).toContain('Ready');
      expect(container.textContent).not.toContain('Some action');
    });

    it('should not show action when currentAction is undefined', () => {
      const { container } = render(
        <ConnectionStatus connectionState="connected" isProcessing={true} />
      );

      // Should fall back to connected ready state
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

      // Should show connection state, not processing phase
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

      // Null phase -> falls back to the generic 'processing' tone (info/blue).
      const dot = container.querySelector('.bg-blue-500');
      expect(dot).toBeTruthy();
    });
  });
});
