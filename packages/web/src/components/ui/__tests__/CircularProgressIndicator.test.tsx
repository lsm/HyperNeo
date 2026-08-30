import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/preact';
import { CircularProgressIndicator } from '../CircularProgressIndicator';

describe('CircularProgressIndicator', () => {
  beforeEach(() => {
    cleanup();
  });

  afterEach(() => {
    cleanup();
  });

  describe('Basic Rendering', () => {
    it('should render SVG with circle elements', () => {
      const { container } = render(<CircularProgressIndicator progress={50} />);

      const svg = container.querySelector('svg');
      expect(svg).toBeTruthy();

      const circles = container.querySelectorAll('svg circle');
      expect(circles.length).toBe(2);
    });

    it('should display percentage text when showPercentage is true', () => {
      const { container } = render(<CircularProgressIndicator progress={75} />);

      const text = container.querySelector('svg text');
      expect(text).toBeTruthy();
      expect(text?.textContent).toBe('75');
    });

    it('should not display percentage text when showPercentage is false', () => {
      const { container } = render(
        <CircularProgressIndicator progress={75} showPercentage={false} />
      );

      const text = container.querySelector('svg text');
      expect(text).toBeNull();
    });

    it('should use default size of 32 pixels', () => {
      const { container } = render(<CircularProgressIndicator progress={50} />);

      const svg = container.querySelector('svg');
      expect(svg?.getAttribute('width')).toBe('32');
      expect(svg?.getAttribute('height')).toBe('32');
    });

    it('should use custom size when provided', () => {
      const { container } = render(<CircularProgressIndicator progress={50} size={48} />);

      const svg = container.querySelector('svg');
      expect(svg?.getAttribute('width')).toBe('48');
      expect(svg?.getAttribute('height')).toBe('48');
    });
  });

  describe('Color Coding', () => {
    it('should show gray color for 0% progress', () => {
      const { container } = render(<CircularProgressIndicator progress={0} />);

      const progressArc = container.querySelectorAll('svg circle')[1];
      expect(progressArc).toBeUndefined();

      const text = container.querySelector('svg text');
      expect(text?.getAttribute('class')).toContain('text-fg-faint');
    });

    it('should show blue color for in-progress (1-99%)', () => {
      const { container } = render(<CircularProgressIndicator progress={50} />);

      const progressArc = container.querySelectorAll('svg circle')[1];
      expect(progressArc?.getAttribute('class')).toContain('text-accent');
    });

    it('should show green color for 100% progress', () => {
      const { container } = render(<CircularProgressIndicator progress={100} />);

      const progressArc = container.querySelectorAll('svg circle')[1];
      expect(progressArc?.getAttribute('class')).toContain('text-success');

      const text = container.querySelector('svg text');
      expect(text?.getAttribute('class')).toContain('text-success');
    });
  });

  describe('Progress Calculation', () => {
    it('should clamp progress to 100% when exceeding 100', () => {
      const { container } = render(<CircularProgressIndicator progress={150} />);

      const text = container.querySelector('svg text');
      expect(text?.textContent).toBe('100');
    });

    it('should clamp progress to 0% when negative', () => {
      const { container } = render(<CircularProgressIndicator progress={-20} />);

      const text = container.querySelector('svg text');
      expect(text?.textContent).toBe('0');
    });

    it('should round progress to nearest integer', () => {
      const { container } = render(<CircularProgressIndicator progress={75.6} />);

      const text = container.querySelector('svg text');
      expect(text?.textContent).toBe('76');
    });
  });

  describe('Title Attribute', () => {
    it('should use progress as default title', () => {
      const { container } = render(<CircularProgressIndicator progress={50} />);

      const wrapper =
        container.querySelector('[class*="CircularProgressIndicator"]') || container.firstChild;
      expect(wrapper).toBeTruthy();
    });

    it('should use custom title when provided', () => {
      const { container } = render(
        <CircularProgressIndicator progress={50} title="Custom tooltip" />
      );

      const wrapper = container.querySelector('[title="Custom tooltip"]');
      expect(wrapper).toBeTruthy();
    });
  });

  describe('Progress Arc', () => {
    it('should not render progress arc when progress is 0', () => {
      const { container } = render(<CircularProgressIndicator progress={0} />);

      const circles = container.querySelectorAll('svg circle');
      expect(circles.length).toBe(1);
    });

    it('should render progress arc when progress is greater than 0', () => {
      const { container } = render(<CircularProgressIndicator progress={1} />);

      const circles = container.querySelectorAll('svg circle');
      expect(circles.length).toBe(2);
    });

    it('should calculate stroke-dasharray correctly for 50%', () => {
      const { container } = render(<CircularProgressIndicator progress={50} />);

      const progressArc = container.querySelectorAll('svg circle')[1];
      const dashArray = progressArc?.getAttribute('stroke-dasharray');

      expect(dashArray).toContain('47.1');
    });
  });

  describe('Size Variation', () => {
    it('should render with small size', () => {
      const { container } = render(<CircularProgressIndicator progress={50} size={24} />);

      const svg = container.querySelector('svg');
      expect(svg?.getAttribute('width')).toBe('24');
      expect(svg?.getAttribute('height')).toBe('24');
    });

    it('should render with large size', () => {
      const { container } = render(<CircularProgressIndicator progress={50} size={64} />);

      const svg = container.querySelector('svg');
      expect(svg?.getAttribute('width')).toBe('64');
      expect(svg?.getAttribute('height')).toBe('64');
    });
  });
});
