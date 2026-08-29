// @ts-nocheck

import type { ContextInfo, ModelInfo } from '@hyperneo/shared';
import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SessionStatusBar from '../SessionStatusBar';

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
  };

  beforeEach(() => {
    cleanup();
    mockOnModelSwitch.mockClear();
    mockOnAutoScrollChange.mockClear();
    mockGetHubIfConnected.mockReturnValue(null);
  });

  afterEach(() => {
    cleanup();
  });

  describe('Basic Rendering', () => {
    it('should render status bar container', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} />);

      const content = container.firstElementChild;
      expect(content?.className).toContain('flex');
    });

    it('should render model switcher button', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} />);

      const modelButton = container.querySelector('.control-btn');
      expect(modelButton).toBeTruthy();
    });

    it('should render auto-scroll toggle', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} />);

      const buttons = container.querySelectorAll('.control-btn');
      expect(buttons.length).toBeGreaterThan(0);
    });

    it('should render context usage bar', () => {
      const { container } = render(
        <SessionStatusBar {...defaultProps} contextUsage={mockContextUsage} />
      );

      const svgText = container.querySelector('svg text');
      expect(svgText?.textContent).toBe('25');
    });
  });

  describe('Connection Status Display', () => {
    it('should render connection status section', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} />);

      const text = container.textContent || '';
      expect(text.length).toBeGreaterThan(0);
    });

    it('should have status indicator styling', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} />);

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
    it('should render the brand-tinted model pill with logo + tier label', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} />);

      const pill = container.querySelector('[data-testid="model-pill"]');
      expect(pill).toBeTruthy();
      expect(pill?.querySelector('svg')).toBeTruthy();
      expect(pill?.textContent).toContain('Sonnet 4.5');
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

    it('should disable model button while coordinator mode is changing', () => {
      const { container } = render(
        <SessionStatusBar {...defaultProps} coordinatorSwitching={true} />
      );

      const modelButton = container.querySelector(
        '.control-btn[title*="Switch Model"]'
      ) as HTMLButtonElement;
      expect(modelButton?.disabled).toBe(true);
    });

    it('should show spinner when switching models', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} modelSwitching={true} />);

      const spinner = container.querySelector('[class*="animate-spin"]');
      expect(spinner).toBeTruthy();
    });
  });

  describe('Auto-Scroll Toggle', () => {
    it('should show enabled state when autoScroll is true', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} autoScroll={true} />);

      const buttons = Array.from(container.querySelectorAll('.control-btn'));
      const autoScrollButton = buttons.find(
        (btn) => btn.getAttribute('title')?.includes('Auto-scroll') || false
      );
      expect(autoScrollButton?.className).toContain('border-success');
    });

    it('should show disabled state when autoScroll is false', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} autoScroll={false} />);

      const buttons = Array.from(container.querySelectorAll('.control-btn'));
      const autoScrollButton = buttons.find(
        (btn) => btn.getAttribute('title')?.includes('Auto-scroll') || false
      );
      expect(autoScrollButton?.className).toContain('border-line-strong/80');
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

      const svg = container.querySelector('svg circle');
      expect(svg).toBeTruthy();
    });

    it('should use default max context when not provided', () => {
      const { container } = render(
        <SessionStatusBar {...defaultProps} contextUsage={mockContextUsage} />
      );

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

      const svgText = container.querySelector('svg text');
      expect(svgText?.textContent).toBe('25');
    });
  });

  describe('Layout', () => {
    it('should have separator between controls and context', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} />);

      const separator = container.querySelector('.bg-fg-faint');
      expect(separator).toBeTruthy();
    });

    it('should have proper flex layout', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} />);

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

      const dropdown = container.querySelector('[data-testid="model-dropdown"]')!;
      expect(dropdown.textContent).toContain('Opus 4.5');
      expect(dropdown.textContent).not.toContain('Sonnet 4.5');
      expect(dropdown.textContent).not.toContain('Haiku 4.5');
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

      fireEvent.click(modelButton);
      expect(container.textContent).toContain('Select Model');

      fireEvent.click(modelButton);
      expect(container.textContent).not.toContain('Select Model');
    });

    it('should close thinking dropdown when opening model dropdown', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} />);

      const buttons = Array.from(container.querySelectorAll('.control-btn'));
      const thinkingButton = buttons.find(
        (btn) => btn.getAttribute('title')?.includes('Thinking:') || false
      )!;
      fireEvent.click(thinkingButton);
      expect(container.textContent).toContain('Thinking Level');

      const modelButton = container.querySelector(
        '.control-btn[title*="Switch Model"]'
      ) as HTMLButtonElement;
      fireEvent.click(modelButton);

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

      fireEvent.click(thinkingButton);
      expect(container.textContent).toContain('Thinking Level');

      fireEvent.click(thinkingButton);
      expect(container.textContent).not.toContain('Thinking Level');
    });

    it('should close model dropdown when opening thinking dropdown', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} />);

      const modelButton = container.querySelector(
        '.control-btn[title*="Switch Model"]'
      ) as HTMLButtonElement;
      fireEvent.click(modelButton);
      expect(container.textContent).toContain('Select Model');

      const buttons = Array.from(container.querySelectorAll('.control-btn'));
      const thinkingButton = buttons.find(
        (btn) => btn.getAttribute('title')?.includes('Thinking:') || false
      )!;
      fireEvent.click(thinkingButton);

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

      const allButtons = Array.from(container.querySelectorAll('button'));
      const think16kButton = allButtons.find((btn) => btn.textContent?.includes('Think 16k'));
      fireEvent.click(think16kButton!);

      rerender(<SessionStatusBar {...defaultProps} thinkingLevel="think16k" />);

      const updatedButtons = Array.from(container.querySelectorAll('.control-btn'));
      const updatedThinkingButton = updatedButtons.find(
        (btn) => btn.getAttribute('title')?.includes('Thinking:') || false
      );
      expect(updatedThinkingButton?.getAttribute('title')).toContain('Think 16k');
    });
  });

  describe('ThinkingLevelIcon Brightness', () => {
    const getThinkingIcon = (container: Element) => {
      const buttons = Array.from(container.querySelectorAll('.control-btn'));
      const thinkingButton = buttons.find(
        (btn) => btn.getAttribute('title')?.includes('Thinking:') || false
      );
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
      expect(svg?.className.baseVal || svg?.getAttribute('class')).toContain('text-fg-muted');
    });

    it('should show amber-600 icon for think8k level', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} thinkingLevel="think8k" />);

      const svg = getThinkingIcon(container);
      expect(svg?.className.baseVal || svg?.getAttribute('class')).toContain('text-warning');
    });

    it('should show amber-500 icon for think16k level', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} thinkingLevel="think16k" />);

      const svg = getThinkingIcon(container);
      expect(svg?.className.baseVal || svg?.getAttribute('class')).toContain('text-warning');
    });

    it('should show amber-300 icon for think32k level', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} thinkingLevel="think32k" />);

      const svg = getThinkingIcon(container);
      expect(svg?.className.baseVal || svg?.getAttribute('class')).toContain('text-warning');
    });
  });

  describe('ThinkingBorderRing', () => {
    it('should not show border ring for off level', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} thinkingLevel="off" />);

      const buttons = Array.from(container.querySelectorAll('.control-btn'));
      const thinkingButton = buttons.find(
        (btn) => btn.getAttribute('title')?.includes('Thinking:') || false
      );
      expect(thinkingButton?.className).toContain('border-line-strong/80');
    });

    it('should show border ring for think8k level', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} thinkingLevel="think8k" />);

      const buttons = Array.from(container.querySelectorAll('.control-btn'));
      const thinkingButton = buttons.find(
        (btn) => btn.getAttribute('title')?.includes('Thinking:') || false
      );
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

  describe('Model Pill — tier label', () => {
    it('should show the tier label with brand prefix stripped for an opus model', () => {
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

      const pill = container.querySelector('[data-testid="model-pill"]');
      expect(pill?.textContent).toContain('Opus 4');
      expect(pill?.querySelector('svg')).toBeTruthy();
    });

    it('should show the tier label for a haiku model', () => {
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

      const pill = container.querySelector('[data-testid="model-pill"]');
      expect(pill?.textContent).toContain('Haiku 3');
    });

    it('should show a placeholder when no model info', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} currentModelInfo={null} />);

      const pill = container.querySelector('[data-testid="model-pill"]');
      expect(pill?.textContent).toContain('Select model');
    });
  });

  describe('Model Pill — provider identity', () => {
    const pillProvider = (container: { querySelector: (sel: string) => Element | null }) =>
      container.querySelector('[data-testid="model-pill"]')?.getAttribute('data-provider');

    const cases: Array<[string, string]> = [
      ['anthropic', 'anthropic'],
      ['anthropic-copilot', 'anthropic-copilot'],
      ['anthropic-codex', 'anthropic-codex'],
      ['glm', 'glm'],
      ['kimi', 'kimi'],
      ['minimax', 'minimax'],
    ];

    for (const [provider] of cases) {
      it(`should stamp the pill with the ${provider} provider`, () => {
        const { container } = render(
          <SessionStatusBar {...defaultProps} currentModelInfo={{ ...mockModelInfo, provider }} />
        );
        expect(pillProvider(container)).toBe(provider);
      });
    }

    it('should stamp an unknown provider as-is', () => {
      const { container } = render(
        <SessionStatusBar
          {...defaultProps}
          currentModelInfo={{ ...mockModelInfo, provider: 'some-unknown-provider' }}
        />
      );
      expect(pillProvider(container)).toBe('some-unknown-provider');
    });

    it('should leave data-provider empty when provider is undefined', () => {
      const { container } = render(
        <SessionStatusBar
          {...defaultProps}
          currentModelInfo={{ ...mockModelInfo, provider: undefined }}
        />
      );
      expect(pillProvider(container)).toBe('');
    });

    it('should render a provider logo inside the pill', () => {
      const { container } = render(
        <SessionStatusBar
          {...defaultProps}
          currentModelInfo={{ ...mockModelInfo, provider: 'anthropic-copilot' }}
        />
      );
      const pill = container.querySelector('[data-testid="model-pill"]');
      expect(pill?.querySelector('svg')).toBeTruthy();
    });
  });

  describe('Model Dropdown — provider group headers', () => {
    it('should render provider group header label when dropdown is open', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} />);

      const modelButton = container.querySelector(
        '.control-btn[title*="Switch Model"]'
      ) as HTMLButtonElement;
      fireEvent.click(modelButton);

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

      const dropdown = container.querySelector('[data-testid="model-dropdown"]')!;
      const providerDots = Array.from(
        dropdown.querySelectorAll('.w-2.h-2.rounded-full.flex-shrink-0')
      );
      expect(providerDots.length).toBeGreaterThan(0);
    });

    it('should show gray availability dot when provider is not authenticated', () => {
      const { container } = render(<SessionStatusBar {...defaultProps} />);

      const modelButton = container.querySelector(
        '.control-btn[title*="Switch Model"]'
      ) as HTMLButtonElement;
      fireEvent.click(modelButton);

      const dropdown = container.querySelector('[data-testid="model-dropdown"]')!;
      expect(dropdown.querySelector('.bg-fg-faint')).toBeTruthy();
    });

    it('should show green availability dot when provider is authenticated', async () => {
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

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const modelButton = container.querySelector(
        '.control-btn[title*="Switch Model"]'
      ) as HTMLButtonElement;
      fireEvent.click(modelButton);

      const dropdown = container.querySelector('[data-testid="model-dropdown"]')!;
      expect(dropdown.querySelector('.bg-success')).toBeTruthy();
    });
  });

  describe('Model Dropdown — errorKind-aware availability', () => {
    function renderWithAuthStatus(
      providers: Array<{ id: string; isAuthenticated: boolean; errorKind?: string }>
    ) {
      mockGetHubIfConnected.mockReturnValue({
        request: vi.fn().mockImplementation((method: string) => {
          if (method === 'auth.providers') {
            return Promise.resolve({
              providers: providers.map((p) => ({ displayName: p.id, ...p })),
            });
          }
          return Promise.resolve(null);
        }),
        onEvent: vi.fn(() => () => {}),
        onConnection: vi.fn(() => () => {}),
        isConnected: vi.fn(() => true),
      });

      return render(<SessionStatusBar {...defaultProps} />);
    }

    async function openModelDropdown(container: HTMLElement) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      const modelButton = container.querySelector(
        '.control-btn[title*="Switch Model"]'
      ) as HTMLButtonElement;
      fireEvent.click(modelButton);
    }

    it('renders a transient failure as neutral, not danger', async () => {
      const { container } = renderWithAuthStatus([
        { id: 'anthropic', isAuthenticated: false, errorKind: 'transient' },
      ]);

      await openModelDropdown(container);

      const dropdown = container.querySelector('[data-testid="model-dropdown"]')!;
      expect(dropdown.querySelector('.bg-fg-faint')).toBeTruthy();
      expect(dropdown.querySelector('.bg-danger')).toBeFalsy();
    });

    it('renders a degraded tone for an authenticated provider with a transient failure', async () => {
      const { container } = renderWithAuthStatus([
        { id: 'anthropic', isAuthenticated: true, errorKind: 'transient' },
      ]);

      await openModelDropdown(container);

      const dropdown = container.querySelector('[data-testid="model-dropdown"]')!;
      expect(dropdown.querySelector('.bg-fg-faint')).toBeTruthy();
      expect(dropdown.querySelector('.bg-success')).toBeFalsy();
    });

    it('renders a definitive credential failure as danger', async () => {
      const { container } = renderWithAuthStatus([
        { id: 'anthropic', isAuthenticated: false, errorKind: 'credential' },
      ]);

      await openModelDropdown(container);

      const dropdown = container.querySelector('[data-testid="model-dropdown"]')!;
      expect(dropdown.querySelector('.bg-danger')).toBeTruthy();
    });

    it('keeps a transiently failed provider selectable', async () => {
      const { container } = renderWithAuthStatus([
        { id: 'anthropic', isAuthenticated: false, errorKind: 'transient' },
      ]);

      await openModelDropdown(container);

      const dropdown = container.querySelector('[data-testid="model-dropdown"]')!;
      expect(dropdown.textContent).toContain('Opus 4.5');
      expect(dropdown.textContent).toContain('Sonnet 4.5');
      expect(dropdown.textContent).toContain('Haiku 4.5');
    });

    it('blocks non-current models of the active provider under a definitive failure', async () => {
      const { container } = renderWithAuthStatus([
        { id: 'anthropic', isAuthenticated: false, errorKind: 'credential' },
      ]);

      await openModelDropdown(container);

      const dropdown = container.querySelector('[data-testid="model-dropdown"]')!;
      expect(dropdown.textContent).toContain('Sonnet 4.5');
      expect(dropdown.textContent).not.toContain('Opus 4.5');
      expect(dropdown.textContent).not.toContain('Haiku 4.5');
    });
  });
});
