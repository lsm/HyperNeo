// @ts-nocheck
/**
 * Tests for SessionStatusBar Component
 *
 * Tests the session status bar with connection status, model switcher,
 * thinking level, auto-scroll toggle, and context usage display.
 *
 * Note: Tests without mock.module to avoid polluting other tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, act } from '@testing-library/preact';
import type { ContextInfo, ModelInfo } from '@neokai/shared';
import SessionStatusBar from '../SessionStatusBar';
import { getProviderLabel } from '../../hooks';

// Configurable hub mock — defaults to null (no connection) so existing tests are unaffected.
// Individual tests can call mockGetHubIfConnected.mockReturnValue({ request: ... }) to
// simulate an authenticated connection.
const mockGetHubIfConnected = vi.fn(() => null);

vi.mock('../../lib/connection-manager', () => ({
  connectionManager: {
    getHubIfConnected: () => mockGetHubIfConnected(),
    onConnection: vi.fn(() => () => {}),
  },
}));

describe('SessionStatusBar', () => {
  const mockOnModelSwitch = vi.fn(() => Promise.resolve());
  const mockOnAutoScrollChange = vi.fn(() => {});
  const mockOnCoordinatorModeChange = vi.fn(() => {});
  const mockOnSandboxModeChange = vi.fn(() => {});

  const mockModelInfo: ModelInfo = {
    id: 'sonnet',
    name: 'Sonnet 4.5',
    family: 'sonnet',
    provider: 'anthropic',
    isDefault: true,
  };

  const mockAvailableModels: ModelInfo[] = [
    {
      id: 'opus',
      alias: 'opus',
      name: 'Opus 4.5',
      family: 'opus',
      provider: 'anthropic',
      isDefault: false,
    },
    {
      id: 'sonnet',
      alias: 'sonnet',
      name: 'Sonnet 4.5',
      family: 'sonnet',
      provider: 'anthropic',
      isDefault: true,
    },
    {
      id: 'haiku',
      alias: 'haiku',
      name: 'Haiku 4.5',
      family: 'haiku',
      provider: 'anthropic',
      isDefault: false,
    },
  ];

  const mockContextUsage: ContextInfo = {
    totalUsed: 50000,
    totalCapacity: 200000,
    percentUsed: 25,
    model: 'sonnet',
    breakdown: {
      'System Prompt': { tokens: 5000, percent: 2.5 },
      Messages: { tokens: 40000, percent: 20 },
      'Free Space': { tokens: 155000, percent: 77.5 },
    },
  };

  const defaultProps = {
    sessionId: 'session-1',
    isProcessing: false,
    currentModel: 'sonnet',
    currentModelInfo: mockModelInfo,
    availableModels: mockAvailableModels,
    modelSwitching: false,
    modelLoading: false,
    onModelSwitch: mockOnModelSwitch,
    autoScroll: true,
    onAutoScrollChange: mockOnAutoScrollChange,
    coordinatorMode: true,
    coordinatorSwitching: false,
    onCoordinatorModeChange: mockOnCoordinatorModeChange,
    sandboxEnabled: false,
    onSandboxModeChange: mockOnSandboxModeChange,
  };

  beforeEach(() => {
    cleanup();
    mockOnModelSwitch.mockClear();
    mockOnAutoScrollChange.mockClear();
    mockOnCoordinatorModeChange.mockClear();
    mockOnSandboxModeChange.mockClear();
    // Reset hub to null (no connection) between tests — individual tests can override
    mockGetHubIfConnected.mockReturnValue(null);
  });

  afterEach(() => {
    cleanup();
  });

  describe('Basic Rendering', () => {
    it('should render status bar container', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} />);

      // Should have the main container with flex layout
      const content = container.firstElementChild;
      expect(content?.className).toContain('flex');
    });

    it('should render model switcher button', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} />);

      // Should have the model icon button
      const modelButton = container.querySelector('.control-btn');
      expect(modelButton).toBeTruthy();
    });

    it('should render auto-scroll toggle', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} />);

      // Should have the auto-scroll button
      const buttons = container.querySelectorAll('.control-btn');
      expect(buttons.length).toBeGreaterThan(0);
    });

    it('should render context usage bar', () => {
      const { container } = render(
        <SessionStatusBar {...defaultProps} contextUsage={mockContextUsage} />
      );

      // Should show circle with percentage number
      const svgText = container.querySelector('svg text');
      expect(svgText?.textContent).toBe('25');
    });
  });

  describe('Connection Status Display', () => {
    it('should render connection status section', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} />);

      // Should have a connection status display somewhere in the container
      const text = container.textContent || '';
      // The component should render some status text
      expect(text.length).toBeGreaterThan(0);
    });

    it('should have status indicator styling', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} />);

      // Should have dot indicators for status
      const dots = container.querySelectorAll('.w-2.h-2.rounded-full');
      expect(dots.length).toBeGreaterThan(0);
    });
  });

  describe('Processing State Display', () => {
    it('should show current action when processing', () => {
      const { container } = render(
        <SessionStatusBar {...defaultProps} isProcessing={true} currentAction="Reading files..." />
      );

      expect(container.textContent).toContain('Reading files...');
    });

    it('should show initializing phase styling', () => {
      const { container } = render(
        <SessionStatusBar
          {...defaultProps}
          isProcessing={true}
          currentAction="Initializing..."
          streamingPhase="initializing"
        />
      );

      expect(container.textContent).toContain('Initializing...');
    });

    it('should show thinking phase styling', () => {
      const { container } = render(
        <SessionStatusBar
          {...defaultProps}
          isProcessing={true}
          currentAction="Thinking..."
          streamingPhase="thinking"
        />
      );

      expect(container.textContent).toContain('Thinking...');
    });

    it('should show streaming phase styling', () => {
      const { container } = render(
        <SessionStatusBar
          {...defaultProps}
          isProcessing={true}
          currentAction="Streaming..."
          streamingPhase="streaming"
        />
      );

      expect(container.textContent).toContain('Streaming...');
    });

    it('should show finalizing phase styling', () => {
      const { container } = render(
        <SessionStatusBar
          {...defaultProps}
          isProcessing={true}
          currentAction="Finalizing..."
          streamingPhase="finalizing"
        />
      );

      expect(container.textContent).toContain('Finalizing...');
    });
  });

  describe('Model Switcher', () => {
    it('should show current model icon', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} />);

      // Sonnet icon should be visible
      expect(container.textContent).toContain('💎');
    });

    it('should disable model button when loading', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} modelLoading={true} />);

      const modelButton = container.querySelector(
        '.control-btn[title*="Switch Model"]'
      ) as HTMLButtonElement;
      expect(modelButton?.disabled).toBe(true);
    });

    it('should disable model button when switching', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} modelSwitching={true} />);

      const modelButton = container.querySelector(
        '.control-btn[title*="Switch Model"]'
      ) as HTMLButtonElement;
      expect(modelButton?.disabled).toBe(true);
    });

    it('should show spinner when switching models', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} modelSwitching={true} />);

      // Should have a spinner component
      const spinner = container.querySelector('[class*="animate-spin"]');
      expect(spinner).toBeTruthy();
    });
  });

  describe('Auto-Scroll Toggle', () => {
    it('should show enabled state when autoScroll is true', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} autoScroll={true} />);

      // Should have emerald border when enabled
      const buttons = Array.from(container.querySelectorAll('.control-btn'));
      const autoScrollButton = buttons.find(
        (btn) => btn.getAttribute('title')?.includes('Auto-scroll') || false
      );
      expect(autoScrollButton?.className).toContain('border-emerald-500');
    });

    it('should show disabled state when autoScroll is false', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} autoScroll={false} />);

      // Should have neutral border when disabled
      const buttons = Array.from(container.querySelectorAll('.control-btn'));
      const autoScrollButton = buttons.find(
        (btn) => btn.getAttribute('title')?.includes('Auto-scroll') || false
      );
      expect(autoScrollButton?.className).toContain('border-dark-600/80');
    });

    it('should call onAutoScrollChange when clicked', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} autoScroll={true} />);

      const buttons = Array.from(container.querySelectorAll('.control-btn'));
      const autoScrollButton = buttons.find(
        (btn) => btn.getAttribute('title')?.includes('Auto-scroll') || false
      )!;
      fireEvent.click(autoScrollButton);

      expect(mockOnAutoScrollChange).toHaveBeenCalledWith(false);
    });

    it('should toggle autoScroll value', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} autoScroll={false} />);

      const buttons = Array.from(container.querySelectorAll('.control-btn'));
      const autoScrollButton = buttons.find(
        (btn) => btn.getAttribute('title')?.includes('Auto-scroll') || false
      )!;
      fireEvent.click(autoScrollButton);

      expect(mockOnAutoScrollChange).toHaveBeenCalledWith(true);
    });
  });

  describe('Thinking Level', () => {
    it('should show off thinking level by default', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} />);

      // Should have thinking level button with title
      const buttons = Array.from(container.querySelectorAll('.control-btn'));
      const thinkingButton = buttons.find(
        (btn) => btn.getAttribute('title')?.includes('Thinking:') || false
      );
      expect(thinkingButton?.getAttribute('title')).toContain('Off');
    });

    it('should show provided thinking level', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} thinkingLevel="think16k" />);

      const buttons = Array.from(container.querySelectorAll('.control-btn'));
      const thinkingButton = buttons.find(
        (btn) => btn.getAttribute('title')?.includes('Thinking:') || false
      );
      expect(thinkingButton?.getAttribute('title')).toContain('Think 16k');
    });
  });

  describe('Context Usage Display', () => {
    it('should display context percentage in circle', () => {
      const { container } = render(
        <SessionStatusBar {...defaultProps} contextUsage={mockContextUsage} />
      );

      const svgText = container.querySelector('svg text');
      expect(svgText?.textContent).toBe('25');
    });

    it('should display circle indicator', () => {
      const { container } = render(
        <SessionStatusBar {...defaultProps} contextUsage={mockContextUsage} />
      );

      // Should have an SVG circle indicator
      const svg = container.querySelector('svg circle');
      expect(svg).toBeTruthy();
    });

    it('should use default max context when not provided', () => {
      const { container } = render(
        <SessionStatusBar {...defaultProps} contextUsage={mockContextUsage} />
      );

      // Should render without error
      const svgText = container.querySelector('svg text');
      expect(svgText?.textContent).toBe('25');
    });

    it('should use custom max context when provided', () => {
      const { container } = render(
        <SessionStatusBar
          {...defaultProps}
          contextUsage={mockContextUsage}
          maxContextTokens={100000}
        />
      );

      // Should render with the context percentage
      const svgText = container.querySelector('svg text');
      expect(svgText?.textContent).toBe('25');
    });
  });

  describe('Layout', () => {
    it('should have separator between controls and context', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} />);

      // Should have a vertical separator
      const separator = container.querySelector('.bg-gray-600');
      expect(separator).toBeTruthy();
    });

    it('should have proper flex layout', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} />);

      // Container should have flex layout
      const content = container.firstElementChild;
      expect(content?.className).toContain('flex');
      expect(content?.className).toContain('items-center');
    });
  });

  describe('Model Dropdown', () => {
    it('should open model dropdown when clicked', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} />);

      const modelButton = container.querySelector(
        '.control-btn[title*="Switch Model"]'
      ) as HTMLButtonElement;
      fireEvent.click(modelButton);

      // Should show the dropdown with model options
      expect(container.textContent).toContain('Select Model');
    });

    it('should show all available models in dropdown', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} />);

      const modelButton = container.querySelector(
        '.control-btn[title*="Switch Model"]'
      ) as HTMLButtonElement;
      fireEvent.click(modelButton);

      expect(container.textContent).toContain('Opus 4.5');
      expect(container.textContent).toContain('Sonnet 4.5');
      expect(container.textContent).toContain('Haiku 4.5');
    });

    it('should filter model dropdown options by search query', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} />);

      const modelButton = container.querySelector(
        '.control-btn[title*="Switch Model"]'
      ) as HTMLButtonElement;
      fireEvent.click(modelButton);

      const searchInput = container.querySelector('input[aria-label="Search models"]')!;
      fireEvent.input(searchInput, { target: { value: 'opus' } });

      expect(container.textContent).toContain('Opus 4.5');
      expect(container.textContent).not.toContain('Sonnet 4.5');
      expect(container.textContent).not.toContain('Haiku 4.5');
    });

    it('should show current model indicator', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} />);

      const modelButton = container.querySelector(
        '.control-btn[title*="Switch Model"]'
      ) as HTMLButtonElement;
      fireEvent.click(modelButton);

      expect(container.textContent).toContain('✓');
    });

    it('should call onModelSwitch when a model is selected', async () => {
      const { container } = render(<SessionStatusBar {...defaultProps} />);

      const modelButton = container.querySelector(
        '.control-btn[title*="Switch Model"]'
      ) as HTMLButtonElement;
      fireEvent.click(modelButton);

      // Find and click the Opus model button
      const buttons = Array.from(container.querySelectorAll('button'));
      const opusButton = buttons.find((btn) => btn.textContent?.includes('Opus 4.5'));
      fireEvent.click(opusButton!);

      expect(mockOnModelSwitch).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'opus', family: 'opus' })
      );
    });

    it('should close model dropdown when clicking it again', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} />);

      const modelButton = container.querySelector(
        '.control-btn[title*="Switch Model"]'
      ) as HTMLButtonElement;

      // Open
      fireEvent.click(modelButton);
      expect(container.textContent).toContain('Select Model');

      // Close
      fireEvent.click(modelButton);
      expect(container.textContent).not.toContain('Select Model');
    });

    it('should close thinking dropdown when opening model dropdown', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} />);

      // Open thinking dropdown first
      const buttons = Array.from(container.querySelectorAll('.control-btn'));
      const thinkingButton = buttons.find(
        (btn) => btn.getAttribute('title')?.includes('Thinking:') || false
      )!;
      fireEvent.click(thinkingButton);
      expect(container.textContent).toContain('Thinking Level');

      // Open model dropdown
      const modelButton = container.querySelector(
        '.control-btn[title*="Switch Model"]'
      ) as HTMLButtonElement;
      fireEvent.click(modelButton);

      // Model dropdown should be open, thinking dropdown should be closed
      expect(container.textContent).toContain('Select Model');
      expect(container.textContent).not.toContain('Thinking Level');
    });
  });

  describe('Thinking Dropdown', () => {
    it('should hide thinking button when model thinkingModes is off', () => {
      const codexModelInfo: ModelInfo = {
        ...mockModelInfo,
        provider: 'anthropic-codex',
        thinkingModes: 'off',
      };
      const { container } = render(
        <SessionStatusBar {...defaultProps} currentModelInfo={codexModelInfo} />
      );

      const buttons = Array.from(container.querySelectorAll('.control-btn'));
      const thinkingButton = buttons.find(
        (btn) => btn.getAttribute('title')?.includes('Thinking:') || false
      );
      expect(thinkingButton).toBeUndefined();
    });

    it('should show thinking button when model thinkingModes is granular', () => {
      const codexModelInfo: ModelInfo = {
        ...mockModelInfo,
        provider: 'anthropic-codex',
        thinkingModes: 'granular',
      };
      const { container } = render(
        <SessionStatusBar {...defaultProps} currentModelInfo={codexModelInfo} />
      );

      const buttons = Array.from(container.querySelectorAll('.control-btn'));
      const thinkingButton = buttons.find(
        (btn) => btn.getAttribute('title')?.includes('Thinking:') || false
      );
      expect(thinkingButton).toBeTruthy();
    });

    it('should open thinking dropdown when clicked', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} />);

      const buttons = Array.from(container.querySelectorAll('.control-btn'));
      const thinkingButton = buttons.find(
        (btn) => btn.getAttribute('title')?.includes('Thinking:') || false
      )!;
      fireEvent.click(thinkingButton);

      expect(container.textContent).toContain('Thinking Level');
    });

    it('should show all thinking levels in dropdown', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} />);

      const buttons = Array.from(container.querySelectorAll('.control-btn'));
      const thinkingButton = buttons.find(
        (btn) => btn.getAttribute('title')?.includes('Thinking:') || false
      )!;
      fireEvent.click(thinkingButton);

      expect(container.textContent).toContain('Off');
      expect(container.textContent).toContain('Think 8k');
      expect(container.textContent).toContain('Think 16k');
      expect(container.textContent).toContain('Think 24k');
      expect(container.textContent).toContain('Think 32k');
    });

    it('should close thinking dropdown when clicking it again', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} />);

      const buttons = Array.from(container.querySelectorAll('.control-btn'));
      const thinkingButton = buttons.find(
        (btn) => btn.getAttribute('title')?.includes('Thinking:') || false
      )!;

      // Open
      fireEvent.click(thinkingButton);
      expect(container.textContent).toContain('Thinking Level');

      // Close
      fireEvent.click(thinkingButton);
      expect(container.textContent).not.toContain('Thinking Level');
    });

    it('should close model dropdown when opening thinking dropdown', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} />);

      // Open model dropdown first
      const modelButton = container.querySelector(
        '.control-btn[title*="Switch Model"]'
      ) as HTMLButtonElement;
      fireEvent.click(modelButton);
      expect(container.textContent).toContain('Select Model');

      // Open thinking dropdown
      const buttons = Array.from(container.querySelectorAll('.control-btn'));
      const thinkingButton = buttons.find(
        (btn) => btn.getAttribute('title')?.includes('Thinking:') || false
      )!;
      fireEvent.click(thinkingButton);

      // Thinking dropdown should be open, model dropdown should be closed
      expect(container.textContent).toContain('Thinking Level');
      expect(container.textContent).not.toContain('Select Model');
    });

    it('should change thinking level when option is selected', () => {
      const { container, rerender } = render(<SessionStatusBar {...defaultProps} />);

      const buttons = Array.from(container.querySelectorAll('.control-btn'));
      const thinkingButton = buttons.find(
        (btn) => btn.getAttribute('title')?.includes('Thinking:') || false
      )!;
      fireEvent.click(thinkingButton);

      // Find and click Think 16k option
      const allButtons = Array.from(container.querySelectorAll('button'));
      const think16kButton = allButtons.find((btn) => btn.textContent?.includes('Think 16k'));
      fireEvent.click(think16kButton!);

      // Re-render with new thinking level
      rerender(<SessionStatusBar {...defaultProps} thinkingLevel="think16k" />);

      // Check title updated
      const updatedButtons = Array.from(container.querySelectorAll('.control-btn'));
      const updatedThinkingButton = updatedButtons.find(
        (btn) => btn.getAttribute('title')?.includes('Thinking:') || false
      );
      expect(updatedThinkingButton?.getAttribute('title')).toContain('Think 16k');
    });
  });

  describe('ThinkingLevelIcon Brightness', () => {
    // Helper to get the icon SVG (not the border ring which has class "absolute")
    const getThinkingIcon = (container: Element) => {
      const buttons = Array.from(container.querySelectorAll('.control-btn'));
      const thinkingButton = buttons.find(
        (btn) => btn.getAttribute('title')?.includes('Thinking:') || false
      );
      // Get all SVGs and find the one that's not the absolute positioned border ring
      const svgs = thinkingButton?.querySelectorAll('svg');
      if (!svgs) return null;
      for (const svg of Array.from(svgs)) {
        const classes = svg.className.baseVal || svg.getAttribute('class') || '';
        if (!classes.includes('absolute')) {
          return svg;
        }
      }
      return null;
    };

    it('should show gray icon for off level', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} thinkingLevel="off" />);

      const svg = getThinkingIcon(container);
      expect(svg?.className.baseVal || svg?.getAttribute('class')).toContain('text-gray-400');
    });

    it('should show amber-600 icon for think8k level', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} thinkingLevel="think8k" />);

      const svg = getThinkingIcon(container);
      expect(svg?.className.baseVal || svg?.getAttribute('class')).toContain('text-amber-600');
    });

    it('should show amber-500 icon for think16k level', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} thinkingLevel="think16k" />);

      const svg = getThinkingIcon(container);
      expect(svg?.className.baseVal || svg?.getAttribute('class')).toContain('text-amber-500');
    });

    it('should show amber-300 icon for think32k level', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} thinkingLevel="think32k" />);

      const svg = getThinkingIcon(container);
      expect(svg?.className.baseVal || svg?.getAttribute('class')).toContain('text-amber-300');
    });
  });

  describe('ThinkingBorderRing', () => {
    it('should not show border ring for off level', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} thinkingLevel="off" />);

      const buttons = Array.from(container.querySelectorAll('.control-btn'));
      const thinkingButton = buttons.find(
        (btn) => btn.getAttribute('title')?.includes('Thinking:') || false
      );
      // Off level should have neutral border, not amber ring
      expect(thinkingButton?.className).toContain('border-dark-600/80');
    });

    it('should show border ring for think8k level', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} thinkingLevel="think8k" />);

      const buttons = Array.from(container.querySelectorAll('.control-btn'));
      const thinkingButton = buttons.find(
        (btn) => btn.getAttribute('title')?.includes('Thinking:') || false
      );
      // Should have the SVG ring
      const ring = thinkingButton?.querySelector('svg.absolute');
      expect(ring).toBeTruthy();
    });

    it('should show border ring for think16k level', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} thinkingLevel="think16k" />);

      const buttons = Array.from(container.querySelectorAll('.control-btn'));
      const thinkingButton = buttons.find(
        (btn) => btn.getAttribute('title')?.includes('Thinking:') || false
      );
      const ring = thinkingButton?.querySelector('svg.absolute');
      expect(ring).toBeTruthy();
    });

    it('should show border ring for think32k level', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} thinkingLevel="think32k" />);

      const buttons = Array.from(container.querySelectorAll('.control-btn'));
      const thinkingButton = buttons.find(
        (btn) => btn.getAttribute('title')?.includes('Thinking:') || false
      );
      const ring = thinkingButton?.querySelector('svg.absolute');
      expect(ring).toBeTruthy();
    });
  });

  describe('Model Family Icons', () => {
    it('should show opus icon for opus model', () => {
      const opusModelInfo: ModelInfo = {
        id: 'opus',
        name: 'Claude Opus 4',
        family: 'opus',
        isDefault: false,
        provider: 'anthropic',
      };
      const { container } = render(
        <SessionStatusBar {...defaultProps} currentModelInfo={opusModelInfo} />
      );

      // Opus icon should be visible
      expect(container.textContent).toContain('🧠');
    });

    it('should show haiku icon for haiku model', () => {
      const haikuModelInfo: ModelInfo = {
        id: 'haiku',
        name: 'Claude Haiku 3',
        family: 'haiku',
        isDefault: false,
        provider: 'anthropic',
      };
      const { container } = render(
        <SessionStatusBar {...defaultProps} currentModelInfo={haikuModelInfo} />
      );

      // Haiku icon should be visible
      expect(container.textContent).toContain('⚡');
    });

    it('should show default icon when no model info', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} currentModelInfo={null} />);

      // Default gem icon should be visible
      expect(container.textContent).toContain('💎');
    });
  });

  describe('Coordinator Mode Toggle', () => {
    it('should show spinner when coordinator is switching', () => {
      const { container } = render(
        <SessionStatusBar {...defaultProps} coordinatorSwitching={true} />
      );
      const buttons = Array.from(container.querySelectorAll('.control-btn'));
      const coordinatorButton = buttons.find(
        (btn) => btn.getAttribute('title')?.includes('Coordinator Mode') || false
      );
      const spinner = coordinatorButton?.querySelector('[class*="animate-spin"]');
      expect(spinner).toBeTruthy();
    });

    it('should disable coordinator button when coordinator is switching', () => {
      const { container } = render(
        <SessionStatusBar {...defaultProps} coordinatorSwitching={true} />
      );
      const buttons = Array.from(container.querySelectorAll('.control-btn'));
      const coordinatorButton = buttons.find(
        (btn) => btn.getAttribute('title')?.includes('Coordinator Mode') || false
      ) as HTMLButtonElement;
      expect(coordinatorButton?.disabled).toBe(true);
    });

    it('should disable coordinator button when model is switching', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} modelSwitching={true} />);
      const buttons = Array.from(container.querySelectorAll('.control-btn'));
      const coordinatorButton = buttons.find(
        (btn) => btn.getAttribute('title')?.includes('Coordinator Mode') || false
      ) as HTMLButtonElement;
      expect(coordinatorButton?.disabled).toBe(true);
    });

    it('should disable model button when coordinator is switching', () => {
      const { container } = render(
        <SessionStatusBar {...defaultProps} coordinatorSwitching={true} />
      );
      const modelButton = container.querySelector(
        '.control-btn[title*="Switch Model"]'
      ) as HTMLButtonElement;
      expect(modelButton?.disabled).toBe(true);
    });

    it('should call onCoordinatorModeChange when clicked', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} coordinatorMode={true} />);
      const buttons = Array.from(container.querySelectorAll('.control-btn'));
      const coordinatorButton = buttons.find(
        (btn) => btn.getAttribute('title')?.includes('Coordinator Mode') || false
      )!;
      fireEvent.click(coordinatorButton);
      expect(mockOnCoordinatorModeChange).toHaveBeenCalledWith(false);
    });

    it('should show purple border when coordinator mode is enabled', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} coordinatorMode={true} />);
      const buttons = Array.from(container.querySelectorAll('.control-btn'));
      const coordinatorButton = buttons.find(
        (btn) => btn.getAttribute('title')?.includes('Coordinator Mode') || false
      );
      expect(coordinatorButton?.className).toContain('border-purple-500');
    });

    it('should show neutral border when coordinator mode is disabled', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} coordinatorMode={false} />);
      const buttons = Array.from(container.querySelectorAll('.control-btn'));
      const coordinatorButton = buttons.find(
        (btn) => btn.getAttribute('title')?.includes('Coordinator Mode') || false
      );
      expect(coordinatorButton?.className).toContain('border-dark-600/80');
    });
  });

  describe('Provider Badge (colored dot)', () => {
    it('should show orange dot for Anthropic provider', () => {
      const anthropicModelInfo: ModelInfo = {
        ...mockModelInfo,
        provider: 'anthropic',
      };
      const { container } = render(
        <SessionStatusBar {...defaultProps} currentModelInfo={anthropicModelInfo} />
      );
      const badge = container.querySelector('[data-testid="provider-badge"]');
      expect(badge).toBeTruthy();
      expect(badge?.getAttribute('title')).toBe('Anthropic');
      expect(badge?.getAttribute('aria-label')).toBe('Anthropic');
      expect((badge as HTMLElement)?.style.backgroundColor).toBe('#D97757');
    });

    it('should not show provider badge when provider is undefined', () => {
      const noProviderModelInfo: ModelInfo = {
        ...mockModelInfo,
        provider: undefined,
      };
      const { container } = render(
        <SessionStatusBar {...defaultProps} currentModelInfo={noProviderModelInfo} />
      );
      const badge = container.querySelector('[data-testid="provider-badge"]');
      expect(badge).toBeNull();
    });

    it('should show purple dot for anthropic-copilot provider', () => {
      const copilotModelInfo: ModelInfo = {
        ...mockModelInfo,
        provider: 'anthropic-copilot',
      };
      const { container } = render(
        <SessionStatusBar {...defaultProps} currentModelInfo={copilotModelInfo} />
      );
      const badge = container.querySelector('[data-testid="provider-badge"]');
      expect(badge).toBeTruthy();
      expect(badge?.getAttribute('title')).toBe('Copilot');
      expect(badge?.getAttribute('aria-label')).toBe('Copilot');
      expect((badge as HTMLElement)?.style.backgroundColor).toBe('#8957E5');
    });

    it('should show white dot with ring for anthropic-codex provider', () => {
      const codexModelInfo: ModelInfo = {
        ...mockModelInfo,
        provider: 'anthropic-codex',
      };
      const { container } = render(
        <SessionStatusBar {...defaultProps} currentModelInfo={codexModelInfo} />
      );
      const badge = container.querySelector('[data-testid="provider-badge"]');
      expect(badge).toBeTruthy();
      expect(badge?.getAttribute('title')).toBe('Codex');
      expect(badge?.getAttribute('aria-label')).toBe('Codex');
      expect((badge as HTMLElement)?.style.backgroundColor).toBe('#FFFFFF');
      expect(badge?.className).toContain('ring-1');
    });

    it('should show light blue dot for glm provider', () => {
      const glmModelInfo: ModelInfo = {
        ...mockModelInfo,
        provider: 'glm',
      };
      const { container } = render(
        <SessionStatusBar {...defaultProps} currentModelInfo={glmModelInfo} />
      );
      const badge = container.querySelector('[data-testid="provider-badge"]');
      expect(badge).toBeTruthy();
      expect(badge?.getAttribute('title')).toBe('GLM');
      expect(badge?.getAttribute('aria-label')).toBe('GLM');
      expect((badge as HTMLElement)?.style.backgroundColor).toBe('#7DD3FC');
    });

    it('should show light red dot for minimax provider', () => {
      const minimaxModelInfo: ModelInfo = {
        ...mockModelInfo,
        provider: 'minimax',
      };
      const { container } = render(
        <SessionStatusBar {...defaultProps} currentModelInfo={minimaxModelInfo} />
      );
      const badge = container.querySelector('[data-testid="provider-badge"]');
      expect(badge).toBeTruthy();
      expect(badge?.getAttribute('title')).toBe('MiniMax');
      expect(badge?.getAttribute('aria-label')).toBe('MiniMax');
      expect((badge as HTMLElement)?.style.backgroundColor).toBe('#FCA5A5');
    });

    it('should show lavender dot for kimi provider', () => {
      const kimiModelInfo: ModelInfo = {
        ...mockModelInfo,
        provider: 'kimi',
      };
      const { container } = render(
        <SessionStatusBar {...defaultProps} currentModelInfo={kimiModelInfo} />
      );
      const badge = container.querySelector('[data-testid="provider-badge"]');
      expect(badge).toBeTruthy();
      expect(badge?.getAttribute('title')).toBe('Kimi');
      expect(badge?.getAttribute('aria-label')).toBe('Kimi');
      expect((badge as HTMLElement)?.style.backgroundColor).toBe('#B197FC');
    });

    it('should show gray dot for unknown provider using getProviderLabel fallback', () => {
      const unknownProvider = 'some-unknown-provider';
      const unknownModelInfo: ModelInfo = {
        ...mockModelInfo,
        provider: unknownProvider,
      };
      const { container } = render(
        <SessionStatusBar {...defaultProps} currentModelInfo={unknownModelInfo} />
      );
      const badge = container.querySelector('[data-testid="provider-badge"]');
      const expectedLabel = getProviderLabel(unknownProvider);
      expect(badge).toBeTruthy();
      expect(badge?.getAttribute('title')).toBe(expectedLabel);
      expect(badge?.getAttribute('aria-label')).toBe(expectedLabel);
      expect((badge as HTMLElement)?.style.backgroundColor).toBe('#9CA3AF');
    });

    it('should have explicit dot color for every known provider', () => {
      const knownProviders = [
        'anthropic',
        'anthropic-copilot',
        'anthropic-codex',
        'glm',
        'kimi',
        'minimax',
      ];
      for (const provider of knownProviders) {
        const modelInfo: ModelInfo = { ...mockModelInfo, provider };
        const { container, unmount } = render(
          <SessionStatusBar {...defaultProps} currentModelInfo={modelInfo} />
        );
        const badge = container.querySelector('[data-testid="provider-badge"]');
        expect(
          (badge as HTMLElement)?.style.backgroundColor,
          `${provider} should have explicit brand color, not fallback gray`
        ).not.toBe('#9CA3AF');
        unmount();
      }
    });

    it('should render as a dot with no text content', () => {
      const copilotModelInfo: ModelInfo = {
        ...mockModelInfo,
        provider: 'anthropic-copilot',
      };
      const { container } = render(
        <SessionStatusBar {...defaultProps} currentModelInfo={copilotModelInfo} />
      );
      const badge = container.querySelector('[data-testid="provider-badge"]');
      expect(badge?.textContent).toBe('');
      expect(badge?.className).toContain('rounded-full');
    });
  });

  describe('Model Dropdown — provider group headers', () => {
    it('should render provider group header label when dropdown is open', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} />);

      const modelButton = container.querySelector(
        '.control-btn[title*="Switch Model"]'
      ) as HTMLButtonElement;
      fireEvent.click(modelButton);

      // All mock models belong to 'anthropic' → label "Anthropic" should appear
      expect(container.textContent).toContain('Anthropic');
    });

    it('should render one provider group header per distinct provider', () => {
      const multiProviderModels: ModelInfo[] = [
        { id: 'opus', alias: 'opus', name: 'Opus 4.5', family: 'opus', provider: 'anthropic' },
        {
          id: 'copilot-sonnet',
          alias: 'copilot-sonnet',
          name: 'Sonnet (Copilot)',
          family: 'sonnet',
          provider: 'anthropic-copilot',
        },
      ];

      const { container } = render(
        <SessionStatusBar {...defaultProps} availableModels={multiProviderModels} />
      );

      const modelButton = container.querySelector(
        '.control-btn[title*="Switch Model"]'
      ) as HTMLButtonElement;
      fireEvent.click(modelButton);

      expect(container.textContent).toContain('Anthropic');
      expect(container.textContent).toContain('Copilot');
    });

    it('should render an availability dot for each provider group', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} />);

      const modelButton = container.querySelector(
        '.control-btn[title*="Switch Model"]'
      ) as HTMLButtonElement;
      fireEvent.click(modelButton);

      // Provider availability dots have flex-shrink-0 to distinguish them from
      // the connection status dot (which does not have that class)
      const providerDots = Array.from(
        container.querySelectorAll('.w-2.h-2.rounded-full.flex-shrink-0')
      );
      expect(providerDots.length).toBeGreaterThan(0);
    });

    it('should show gray availability dot when provider is not authenticated', () => {
      // No hub → auth.providers returns null → isAuthenticated defaults to false → gray dot
      const { container } = render(<SessionStatusBar {...defaultProps} />);

      const modelButton = container.querySelector(
        '.control-btn[title*="Switch Model"]'
      ) as HTMLButtonElement;
      fireEvent.click(modelButton);

      const providerDots = Array.from(
        container.querySelectorAll('.w-2.h-2.rounded-full.flex-shrink-0')
      );
      expect(providerDots.length).toBeGreaterThan(0);
      expect(providerDots[0].className).toContain('bg-gray-500');
    });

    it('should show green availability dot when provider is authenticated', async () => {
      // Configure hub to return authenticated status for 'anthropic'
      mockGetHubIfConnected.mockReturnValue({
        request: vi.fn().mockImplementation((method: string) => {
          if (method === 'auth.providers') {
            return Promise.resolve({
              providers: [{ id: 'anthropic', displayName: 'Anthropic', isAuthenticated: true }],
            });
          }
          return Promise.resolve(null);
        }),
        onEvent: vi.fn(() => () => {}),
        onConnection: vi.fn(() => () => {}),
        isConnected: vi.fn(() => true),
      });

      const { container } = render(<SessionStatusBar {...defaultProps} />);

      // Wait for the auth.providers effect to resolve
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const modelButton = container.querySelector(
        '.control-btn[title*="Switch Model"]'
      ) as HTMLButtonElement;
      fireEvent.click(modelButton);

      const providerDots = Array.from(
        container.querySelectorAll('.w-2.h-2.rounded-full.flex-shrink-0')
      );
      expect(providerDots.length).toBeGreaterThan(0);
      expect(providerDots[0].className).toContain('bg-green-500');
    });
  });
});
