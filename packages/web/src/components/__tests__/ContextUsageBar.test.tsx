// @ts-nocheck

import { render, cleanup, fireEvent } from '@testing-library/preact';
import type { ContextInfo } from '@hyperneo/shared';
import ContextUsageBar from '../ContextUsageBar';

describe('ContextUsageBar', () => {
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

  beforeEach(() => {
    cleanup();
  });

  afterEach(() => {
    cleanup();
  });

  describe('Basic Rendering', () => {
    it('should render circle indicator with percentage', () => {
      const { container } = render(<ContextUsageBar contextUsage={mockContextUsage} />);

      const svg = container.querySelector('svg');
      expect(svg).toBeTruthy();

      const svgText = container.querySelector('svg text');
      expect(svgText?.textContent).toBe('25');
    });

    it('should render progress arc in circle', () => {
      const { container } = render(<ContextUsageBar contextUsage={mockContextUsage} />);

      const circles = container.querySelectorAll('svg circle');
      expect(circles.length).toBe(2);
    });
  });

  describe('Color Coding', () => {
    it('should show green color for low usage (< 60%)', () => {
      const lowUsage: ContextInfo = { ...mockContextUsage, percentUsed: 25 };
      const { container } = render(<ContextUsageBar contextUsage={lowUsage} />);

      const percentText = container.querySelector('.text-success-soft');
      expect(percentText).toBeTruthy();
    });

    it('should show yellow color for medium usage (60-74%)', () => {
      const mediumUsage: ContextInfo = { ...mockContextUsage, percentUsed: 65 };
      const { container } = render(<ContextUsageBar contextUsage={mediumUsage} />);

      const percentText = container.querySelector('.text-warning-soft');
      expect(percentText).toBeTruthy();
    });

    it('should show orange color for high usage (75-89%)', () => {
      const highUsage: ContextInfo = { ...mockContextUsage, percentUsed: 80 };
      const { container } = render(<ContextUsageBar contextUsage={highUsage} />);

      const percentText = container.querySelector('.text-warning-soft');
      expect(percentText).toBeTruthy();
    });

    it('should show red color for critical usage (>= 90%)', () => {
      const criticalUsage: ContextInfo = {
        ...mockContextUsage,
        percentUsed: 95,
      };
      const { container } = render(<ContextUsageBar contextUsage={criticalUsage} />);

      const percentText = container.querySelector('.text-danger-soft');
      expect(percentText).toBeTruthy();
    });
  });

  describe('Progress Bar Width', () => {
    it('should set progress bar width in dropdown based on percentage', () => {
      const { container } = render(<ContextUsageBar contextUsage={mockContextUsage} />);

      const clickable = container.querySelector('[title="Click for context details"]')!;
      fireEvent.click(clickable);

      const progressFill = container.querySelector('.bg-success');
      const style = progressFill?.getAttribute('style');
      expect(style).toContain('width: 25%');
    });

    it('should cap progress bar at 100% in dropdown', () => {
      const overUsage: ContextInfo = { ...mockContextUsage, percentUsed: 150 };
      const { container } = render(<ContextUsageBar contextUsage={overUsage} />);

      const clickable = container.querySelector('[title="Click for context details"]')!;
      fireEvent.click(clickable);

      const progressFill = container.querySelector('.bg-danger');
      const style = progressFill?.getAttribute('style');
      expect(style).toContain('width: 100%');
    });
  });

  describe('Clickable Indicator', () => {
    it('should have cursor-pointer when tokens are available', () => {
      const { container } = render(<ContextUsageBar contextUsage={mockContextUsage} />);

      const clickable = container.querySelector('.cursor-pointer');
      expect(clickable).toBeTruthy();
    });

    it('should have title indicating clickability', () => {
      const { container } = render(<ContextUsageBar contextUsage={mockContextUsage} />);

      const clickable = container.querySelector('[title="Click for context details"]');
      expect(clickable).toBeTruthy();
    });

    it('should show loading title when no tokens', () => {
      const emptyUsage: ContextInfo = { ...mockContextUsage, totalUsed: 0 };
      const { container } = render(<ContextUsageBar contextUsage={emptyUsage} />);

      const clickable = container.querySelector('[title="Context data loading..."]');
      expect(clickable).toBeTruthy();
    });
  });

  describe('Dropdown Toggle', () => {
    it('should show dropdown when clicked', () => {
      const { container } = render(<ContextUsageBar contextUsage={mockContextUsage} />);

      const clickable = container.querySelector('[title="Click for context details"]')!;
      fireEvent.click(clickable);

      expect(container.textContent).toContain('Context Usage');
      expect(container.textContent).toContain('Context Window');
    });

    it('should not show dropdown when no tokens', () => {
      const emptyUsage: ContextInfo = { ...mockContextUsage, totalUsed: 0 };
      const { container } = render(<ContextUsageBar contextUsage={emptyUsage} />);

      const clickable = container.querySelector('[title="Context data loading..."]')!;
      fireEvent.click(clickable);

      expect(container.textContent).not.toContain('Context Window');
    });

    it('should hide dropdown when close button is clicked', () => {
      const { container } = render(<ContextUsageBar contextUsage={mockContextUsage} />);

      const clickable = container.querySelector('[title="Click for context details"]')!;
      fireEvent.click(clickable);

      const closeButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.querySelector('line')
      );
      if (closeButton) {
        fireEvent.click(closeButton);
      }
    });
  });

  describe('Dropdown Content', () => {
    it('should show total token count', () => {
      const { container } = render(<ContextUsageBar contextUsage={mockContextUsage} />);

      const clickable = container.querySelector('[title="Click for context details"]')!;
      fireEvent.click(clickable);

      expect(container.textContent).toContain('50,000');
      expect(container.textContent).toContain('200,000');
    });

    it('should show breakdown categories', () => {
      const { container } = render(<ContextUsageBar contextUsage={mockContextUsage} />);

      const clickable = container.querySelector('[title="Click for context details"]')!;
      fireEvent.click(clickable);

      expect(container.textContent).toContain('Breakdown');
      expect(container.textContent).toContain('System Prompt');
      expect(container.textContent).toContain('Messages');
      expect(container.textContent).toContain('Free Space');
    });

    it('should show category token counts in k-notation', () => {
      const { container } = render(<ContextUsageBar contextUsage={mockContextUsage} />);

      const clickable = container.querySelector('[title="Click for context details"]')!;
      fireEvent.click(clickable);

      expect(container.textContent).toContain('5.0k');
      expect(container.textContent).toContain('40.0k');
      expect(container.textContent).toContain('155.0k');
    });

    it('should show category percentages', () => {
      const { container } = render(<ContextUsageBar contextUsage={mockContextUsage} />);

      const clickable = container.querySelector('[title="Click for context details"]')!;
      fireEvent.click(clickable);

      expect(container.textContent).toContain('2.5%');
      expect(container.textContent).toContain('20.0%');
      expect(container.textContent).toContain('77.5%');
    });

    it('should show model info when available', () => {
      const { container } = render(<ContextUsageBar contextUsage={mockContextUsage} />);

      const clickable = container.querySelector('[title="Click for context details"]')!;
      fireEvent.click(clickable);

      expect(container.textContent).toContain('Model:');
      expect(container.textContent).toContain('sonnet');
    });

    it('should not show model info when not available', () => {
      const noModelUsage: ContextInfo = {
        ...mockContextUsage,
        model: undefined,
      };
      const { container } = render(<ContextUsageBar contextUsage={noModelUsage} />);

      const clickable = container.querySelector('[title="Click for context details"]')!;
      fireEvent.click(clickable);

      expect(container.textContent).not.toContain('Model:');
    });
  });

  describe('Category Colors', () => {
    it('should show gray color for system categories', () => {
      const { container } = render(<ContextUsageBar contextUsage={mockContextUsage} />);

      const clickable = container.querySelector('[title="Click for context details"]')!;
      fireEvent.click(clickable);

      const systemRow = Array.from(container.querySelectorAll('.bg-fg-faint'));
      expect(systemRow.length).toBeGreaterThan(0);
    });

    it('should show blue color for messages category', () => {
      const { container } = render(<ContextUsageBar contextUsage={mockContextUsage} />);

      const clickable = container.querySelector('[title="Click for context details"]')!;
      fireEvent.click(clickable);

      const messagesRow = container.querySelector('.bg-accent');
      expect(messagesRow).toBeTruthy();
    });
  });

  describe('Max Context Fallback', () => {
    it('should use explicit max context when SDK capacity is unavailable', () => {
      const usageWithoutCapacity: ContextInfo = {
        totalUsed: 50000,
        totalCapacity: 0,
        percentUsed: 25,
      };
      const { container } = render(
        <ContextUsageBar contextUsage={usageWithoutCapacity} maxContextTokens={200000} />
      );

      const svgText = container.querySelector('svg text');
      expect(svgText?.textContent).toBe('25');
    });

    it('should not invent a 200k capacity when no max context is provided', () => {
      const usageWithoutCapacity: ContextInfo = {
        totalUsed: 50000,
        totalCapacity: 0,
        percentUsed: 25,
      };
      const { container } = render(<ContextUsageBar contextUsage={usageWithoutCapacity} />);

      const clickable = container.querySelector('[title="Click for context details"]')!;
      fireEvent.click(clickable);

      expect(container.textContent).toContain('50,000 / 0');
      expect(container.textContent).not.toContain('200,000');
    });

    it('should use SDK capacity over model metadata fallback when SDK capacity is available', () => {
      const { container } = render(
        <ContextUsageBar contextUsage={mockContextUsage} maxContextTokens={100000} />
      );

      const clickable = container.querySelector('[title="Click for context details"]')!;
      fireEvent.click(clickable);

      expect(container.textContent).toContain('50,000 / 200,000');
      expect(container.textContent).not.toContain('100,000');
    });

    it('should show Codex metadata capacity when context info has corrected capacity', () => {
      const codexUsage: ContextInfo = {
        ...mockContextUsage,
        totalUsed: 64000,
        totalCapacity: 128000,
        percentUsed: 50,
        model: 'gpt-5.4-mini',
      };
      const { container } = render(
        <ContextUsageBar contextUsage={codexUsage} maxContextTokens={200000} />
      );

      const clickable = container.querySelector('[title="Click for context details"]')!;
      fireEvent.click(clickable);

      expect(container.textContent).toContain('64,000 / 128,000');
      expect(container.textContent).not.toContain('200,000');
    });
  });

  describe('Empty/Loading State', () => {
    it('should handle undefined contextUsage', () => {
      const { container } = render(<ContextUsageBar contextUsage={undefined} />);

      const svgText = container.querySelector('svg text');
      expect(svgText?.textContent).toBe('0');
    });

    it('should show 0 when totalUsed is 0', () => {
      const emptyUsage: ContextInfo = {
        totalUsed: 0,
        totalCapacity: 200000,
        percentUsed: 0,
      };
      const { container } = render(<ContextUsageBar contextUsage={emptyUsage} />);

      const svgText = container.querySelector('svg text');
      expect(svgText?.textContent).toBe('0');
    });
  });

  describe('Keyboard Accessibility', () => {
    it('should close dropdown on Escape key', () => {
      const { container } = render(<ContextUsageBar contextUsage={mockContextUsage} />);

      const clickable = container.querySelector('[title="Click for context details"]')!;
      fireEvent.click(clickable);

      fireEvent.keyDown(document, { key: 'Escape' });
    });
  });

  describe('Click Outside to Close', () => {
    it('should close dropdown when clicking outside', async () => {
      const { container } = render(<ContextUsageBar contextUsage={mockContextUsage} />);

      const clickable = container.querySelector('[title="Click for context details"]')!;
      fireEvent.click(clickable);

      expect(container.textContent).toContain('Context Window');

      await new Promise((resolve) => setTimeout(resolve, 10));

      fireEvent.click(document.body);

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(container.textContent).not.toContain('Context Window');
    });

    it('should not close dropdown when clicking inside indicator', async () => {
      const { container } = render(<ContextUsageBar contextUsage={mockContextUsage} />);

      const clickable = container.querySelector('[title="Click for context details"]')!;
      fireEvent.click(clickable);

      await new Promise((resolve) => setTimeout(resolve, 10));

      fireEvent.click(clickable);
    });

    it('should not close dropdown when clicking inside dropdown', async () => {
      const { container } = render(<ContextUsageBar contextUsage={mockContextUsage} />);

      const clickable = container.querySelector('[title="Click for context details"]')!;
      fireEvent.click(clickable);

      await new Promise((resolve) => setTimeout(resolve, 10));

      const dropdownHeading = container.querySelector('h3');
      if (dropdownHeading) {
        fireEvent.click(dropdownHeading);

        expect(container.textContent).toContain('Context Window');
      }
    });
  });

  describe('Category Sort Order', () => {
    it('should sort categories by type order and hide autocompact buffer rows', () => {
      const usageWithAllCategories: ContextInfo = {
        totalUsed: 100000,
        totalCapacity: 200000,
        percentUsed: 50,
        breakdown: {
          'Free Space': { tokens: 5000, percent: 2.5 },
          Messages: { tokens: 30000, percent: 15 },
          'System Prompt': { tokens: 10000, percent: 5 },
          'System Tools': { tokens: 5000, percent: 2.5 },
          'MCP Tools': { tokens: 10000, percent: 5 },
          'Input Context': { tokens: 20000, percent: 10 },
          'Output Tokens': { tokens: 10000, percent: 5 },
          Autocompact: { tokens: 5000, percent: 2.5 },
        },
      };
      const { container } = render(<ContextUsageBar contextUsage={usageWithAllCategories} />);

      const clickable = container.querySelector('[title="Click for context details"]')!;
      fireEvent.click(clickable);

      expect(container.textContent).toContain('System Prompt');
      expect(container.textContent).toContain('System Tools');
      expect(container.textContent).toContain('MCP Tools');
      expect(container.textContent).toContain('Messages');
      expect(container.textContent).toContain('Input Context');
      expect(container.textContent).toContain('Output Tokens');
      expect(container.textContent).toContain('Free Space');
      const categoryLabels = Array.from(
        container.querySelectorAll('.text-fg-muted.flex-1.min-w-0.truncate')
      ).map((el) => el.textContent);
      expect(categoryLabels).not.toContain('Autocompact');
    });

    it('should handle input tokens category', () => {
      const usageWithInputTokens: ContextInfo = {
        totalUsed: 50000,
        totalCapacity: 200000,
        percentUsed: 25,
        breakdown: {
          'Input Tokens': { tokens: 10000, percent: 5 },
        },
      };
      const { container } = render(<ContextUsageBar contextUsage={usageWithInputTokens} />);

      const clickable = container.querySelector('[title="Click for context details"]')!;
      fireEvent.click(clickable);

      expect(container.textContent).toContain('Input Tokens');
    });

    it('should handle output category', () => {
      const usageWithOutput: ContextInfo = {
        totalUsed: 50000,
        totalCapacity: 200000,
        percentUsed: 25,
        breakdown: {
          Output: { tokens: 10000, percent: 5 },
        },
      };
      const { container } = render(<ContextUsageBar contextUsage={usageWithOutput} />);

      const clickable = container.querySelector('[title="Click for context details"]')!;
      fireEvent.click(clickable);

      expect(container.textContent).toContain('Output');
      const greenRow = container.querySelector('.bg-success');
      expect(greenRow).toBeTruthy();
    });

    it('should handle unknown categories', () => {
      const usageWithUnknown: ContextInfo = {
        totalUsed: 50000,
        totalCapacity: 200000,
        percentUsed: 25,
        breakdown: {
          'Unknown Category': { tokens: 10000, percent: 5 },
        },
      };
      const { container } = render(<ContextUsageBar contextUsage={usageWithUnknown} />);

      const clickable = container.querySelector('[title="Click for context details"]')!;
      fireEvent.click(clickable);

      expect(container.textContent).toContain('Unknown Category');
      const indigoRow = container.querySelector('.bg-accent-hover');
      expect(indigoRow).toBeTruthy();
    });
  });

  describe('Category Colors Extended', () => {
    it('should show purple color for MCP tools category', () => {
      const usageWithMcp: ContextInfo = {
        ...mockContextUsage,
        breakdown: {
          'MCP Tools': { tokens: 10000, percent: 5 },
        },
      };
      const { container } = render(<ContextUsageBar contextUsage={usageWithMcp} />);

      const clickable = container.querySelector('[title="Click for context details"]')!;
      fireEvent.click(clickable);

      const purpleRow = container.querySelector('.bg-cat-purple');
      expect(purpleRow).toBeTruthy();
    });

    it('should show cyan color for input context category', () => {
      const usageWithInput: ContextInfo = {
        ...mockContextUsage,
        breakdown: {
          'Input Context': { tokens: 10000, percent: 5 },
        },
      };
      const { container } = render(<ContextUsageBar contextUsage={usageWithInput} />);

      const clickable = container.querySelector('[title="Click for context details"]')!;
      fireEvent.click(clickable);

      const cyanRow = container.querySelector('.bg-cat-cyan');
      expect(cyanRow).toBeTruthy();
    });

    it('should not render autocompact as a breakdown row even when present', () => {
      const usageWithAutocompact: ContextInfo = {
        ...mockContextUsage,
        autoCompactThreshold: 180000,
        isAutoCompactEnabled: true,
        breakdown: {
          Autocompact: { tokens: 10000, percent: 5 },
        },
      };
      const { container } = render(<ContextUsageBar contextUsage={usageWithAutocompact} />);

      const clickable = container.querySelector('[title="Click for context details"]')!;
      fireEvent.click(clickable);

      const categoryLabels = Array.from(
        container.querySelectorAll('.text-fg-muted.flex-1.min-w-0.truncate')
      ).map((el) => el.textContent);
      expect(categoryLabels).not.toContain('Autocompact');
      expect(container.querySelector('[data-testid="autocompact-buffer-zone"]')).toBeTruthy();
    });
  });

  describe('Percentage Calculation', () => {
    it('should calculate percentage when percent is null', () => {
      const usageWithNullPercent: ContextInfo = {
        totalUsed: 50000,
        totalCapacity: 200000,
        percentUsed: 25,
        breakdown: {
          Messages: { tokens: 20000, percent: null as unknown as number },
        },
      };
      const { container } = render(<ContextUsageBar contextUsage={usageWithNullPercent} />);

      const clickable = container.querySelector('[title="Click for context details"]')!;
      fireEvent.click(clickable);

      expect(container.textContent).toContain('10.0%');
    });

    it('should avoid non-finite percentages when percent and capacity are unavailable', () => {
      const usageWithUnknownCapacity: ContextInfo = {
        totalUsed: 50000,
        totalCapacity: 0,
        percentUsed: 25,
        breakdown: {
          Messages: { tokens: 20000, percent: null as unknown as number },
        },
      };
      const { container } = render(<ContextUsageBar contextUsage={usageWithUnknownCapacity} />);

      const clickable = container.querySelector('[title="Click for context details"]')!;
      fireEvent.click(clickable);

      expect(container.textContent).toContain('0.0%');
      expect(container.textContent).not.toContain('Infinity');
      expect(container.textContent).not.toContain('NaN');
    });
  });

  describe('Autocompact Buffer Zone', () => {
    const usageWithAutoCompact: ContextInfo = {
      totalUsed: 50000,
      totalCapacity: 200000,
      percentUsed: 25,
      model: 'sonnet',
      breakdown: {
        Messages: { tokens: 50000, percent: 25 },
      },
      autoCompactThreshold: 160000,
      isAutoCompactEnabled: true,
    };

    it('should render buffer zone when auto-compact is enabled', () => {
      const { container } = render(<ContextUsageBar contextUsage={usageWithAutoCompact} />);

      const clickable = container.querySelector('[title="Click for context details"]')!;
      fireEvent.click(clickable);

      const bufferZone = container.querySelector('[data-testid="autocompact-buffer-zone"]');
      expect(bufferZone).toBeTruthy();
    });

    it('should render buffer zone when the daemon backstop owns the threshold', () => {
      const usage: ContextInfo = {
        ...usageWithAutoCompact,
        isAutoCompactEnabled: false,
        daemonBackstopActive: true,
      };
      const { container } = render(<ContextUsageBar contextUsage={usage} />);

      const clickable = container.querySelector('[title="Click for context details"]')!;
      fireEvent.click(clickable);

      const bufferZone = container.querySelector('[data-testid="autocompact-buffer-zone"]');
      expect(bufferZone).toBeTruthy();
    });

    it('should size the buffer zone using (capacity - threshold) / capacity', () => {
      const { container } = render(<ContextUsageBar contextUsage={usageWithAutoCompact} />);

      const clickable = container.querySelector('[title="Click for context details"]')!;
      fireEvent.click(clickable);

      const bufferZone = container.querySelector(
        '[data-testid="autocompact-buffer-zone"]'
      ) as HTMLElement;
      expect(bufferZone?.style.width).toBe('20%');
    });

    it('should match the reserved autocompact breakdown percentage', () => {
      const usage: ContextInfo = {
        totalUsed: 226963,
        totalCapacity: 272000,
        percentUsed: 83,
        model: 'gpt-5.5',
        breakdown: {
          Messages: { tokens: 193926, percent: 71.3 },
          'Reserved for Autocompact': { tokens: 33037, percent: 12.1 },
        },
        autoCompactThreshold: 238963,
        isAutoCompactEnabled: true,
      };
      const { container } = render(<ContextUsageBar contextUsage={usage} />);

      const clickable = container.querySelector('[title="Click for context details"]')!;
      fireEvent.click(clickable);

      const bufferZone = container.querySelector(
        '[data-testid="autocompact-buffer-zone"]'
      ) as HTMLElement;
      const marker = container.querySelector(
        '[data-testid="autocompact-threshold-marker"]'
      ) as HTMLElement;

      expect(Number.parseFloat(bufferZone?.style.width ?? '')).toBeCloseTo(12.14595588235294, 5);
      expect(Number.parseFloat(marker?.style.left ?? '')).toBeCloseTo(87.85404411764706, 5);
      const categoryLabels = Array.from(
        container.querySelectorAll('.text-fg-muted.flex-1.min-w-0.truncate')
      ).map((el) => el.textContent);
      expect(categoryLabels).not.toContain('Reserved for Autocompact');
    });

    it('should render threshold marker at autoCompactThreshold position', () => {
      const { container } = render(<ContextUsageBar contextUsage={usageWithAutoCompact} />);

      const clickable = container.querySelector('[title="Click for context details"]')!;
      fireEvent.click(clickable);

      const marker = container.querySelector(
        '[data-testid="autocompact-threshold-marker"]'
      ) as HTMLElement;
      expect(marker).toBeTruthy();
      expect(marker?.style.left).toBe('80%');
    });

    it('should render a buffer arc on the circle indicator', () => {
      const { container } = render(<ContextUsageBar contextUsage={usageWithAutoCompact} />);

      const bufferArc = container.querySelector('[data-testid="autocompact-buffer-arc"]');
      expect(bufferArc).toBeTruthy();
    });

    it('should expose tooltip text on the buffer zone', () => {
      const { container } = render(<ContextUsageBar contextUsage={usageWithAutoCompact} />);

      const clickable = container.querySelector('[title="Click for context details"]')!;
      fireEvent.click(clickable);

      const bufferZone = container.querySelector('[data-testid="autocompact-buffer-zone"]');
      expect(bufferZone?.getAttribute('title')).toContain('Autocompact buffer');
    });

    it('should expose tooltip text on the threshold marker', () => {
      const { container } = render(<ContextUsageBar contextUsage={usageWithAutoCompact} />);

      const clickable = container.querySelector('[title="Click for context details"]')!;
      fireEvent.click(clickable);

      const marker = container.querySelector('[data-testid="autocompact-threshold-marker"]');
      expect(marker?.getAttribute('title')).toBe('Autocompact threshold');
    });

    it('should not render buffer zone when isAutoCompactEnabled is false', () => {
      const usage: ContextInfo = {
        ...usageWithAutoCompact,
        isAutoCompactEnabled: false,
      };
      const { container } = render(<ContextUsageBar contextUsage={usage} />);

      const clickable = container.querySelector('[title="Click for context details"]')!;
      fireEvent.click(clickable);

      expect(container.querySelector('[data-testid="autocompact-buffer-zone"]')).toBeFalsy();
      expect(container.querySelector('[data-testid="autocompact-threshold-marker"]')).toBeFalsy();
      expect(container.querySelector('[data-testid="autocompact-buffer-arc"]')).toBeFalsy();
    });

    it('should not render buffer zone when autoCompactThreshold is 0', () => {
      const usage: ContextInfo = {
        ...usageWithAutoCompact,
        autoCompactThreshold: 0,
      };
      const { container } = render(<ContextUsageBar contextUsage={usage} />);

      const clickable = container.querySelector('[title="Click for context details"]')!;
      fireEvent.click(clickable);

      expect(container.querySelector('[data-testid="autocompact-buffer-zone"]')).toBeFalsy();
      expect(container.querySelector('[data-testid="autocompact-threshold-marker"]')).toBeFalsy();
      expect(container.querySelector('[data-testid="autocompact-buffer-arc"]')).toBeFalsy();
    });

    it('should not render buffer zone when threshold equals or exceeds capacity', () => {
      const usage: ContextInfo = {
        ...usageWithAutoCompact,
        autoCompactThreshold: 200000,
      };
      const { container } = render(<ContextUsageBar contextUsage={usage} />);

      const clickable = container.querySelector('[title="Click for context details"]')!;
      fireEvent.click(clickable);

      expect(container.querySelector('[data-testid="autocompact-buffer-zone"]')).toBeFalsy();
      expect(container.querySelector('[data-testid="autocompact-buffer-arc"]')).toBeFalsy();
    });

    it('should not render buffer zone when threshold/enabled fields are missing', () => {
      const { container } = render(<ContextUsageBar contextUsage={mockContextUsage} />);

      const clickable = container.querySelector('[title="Click for context details"]')!;
      fireEvent.click(clickable);

      expect(container.querySelector('[data-testid="autocompact-buffer-zone"]')).toBeFalsy();
      expect(container.querySelector('[data-testid="autocompact-threshold-marker"]')).toBeFalsy();
      expect(container.querySelector('[data-testid="autocompact-buffer-arc"]')).toBeFalsy();
    });

    it('should not change the displayed percentage number', () => {
      const { container } = render(<ContextUsageBar contextUsage={usageWithAutoCompact} />);

      const svgText = container.querySelector('svg text');
      expect(svgText?.textContent).toBe('25');

      const clickable = container.querySelector('[title="Click for context details"]')!;
      fireEvent.click(clickable);

      expect(container.textContent).toContain('25.0%');
    });
  });

  describe('Unmount Behavior', () => {
    it('should clean up event listeners on unmount', () => {
      const { container, unmount } = render(<ContextUsageBar contextUsage={mockContextUsage} />);

      const clickable = container.querySelector('[title="Click for context details"]')!;
      fireEvent.click(clickable);

      unmount();
    });
  });
});
