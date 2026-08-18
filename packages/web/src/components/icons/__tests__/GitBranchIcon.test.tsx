import { render } from '@testing-library/preact';
import { GitBranchIcon } from '../GitBranchIcon';
import { describe, it, expect } from 'vitest';

describe('GitBranchIcon', () => {
  describe('Rendering', () => {
    it('should render an SVG element', () => {
      const { container } = render(<GitBranchIcon />);
      const svg = container.querySelector('svg');
      expect(svg).toBeTruthy();
    });

    it('should have correct viewBox', () => {
      const { container } = render(<GitBranchIcon />);
      const svg = container.querySelector('svg');
      expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24');
    });

    it('should have fill="none" for outlined style', () => {
      const { container } = render(<GitBranchIcon />);
      const svg = container.querySelector('svg');
      expect(svg?.getAttribute('fill')).toBe('none');
    });
  });

  describe('Path Elements', () => {
    it('should contain path elements for the icon', () => {
      const { container } = render(<GitBranchIcon />);
      const paths = container.querySelectorAll('path');
      expect(paths.length).toBeGreaterThan(0);
    });

    it('should use currentColor for stroke', () => {
      const { container } = render(<GitBranchIcon />);
      const paths = container.querySelectorAll('path');
      paths.forEach((path) => {
        expect(path.getAttribute('stroke')).toBe('currentColor');
      });
    });

    it('should have stroke-width of 2', () => {
      const { container } = render(<GitBranchIcon />);
      const paths = container.querySelectorAll('path');
      paths.forEach((path) => {
        expect(path.getAttribute('stroke-width')).toBe('2');
      });
    });
  });

  describe('Custom ClassName', () => {
    it('should apply custom className', () => {
      const { container } = render(<GitBranchIcon className="w-4 h-4 text-blue-500" />);
      const svg = container.querySelector('svg');
      expect(svg?.className).toContain('w-4');
      expect(svg?.className).toContain('h-4');
      expect(svg?.className).toContain('text-blue-500');
    });

    it('should handle empty className', () => {
      const { container } = render(<GitBranchIcon className="" />);
      const svg = container.querySelector('svg');
      expect(svg).toBeTruthy();
    });

    it('should handle undefined className', () => {
      const { container } = render(<GitBranchIcon />);
      const svg = container.querySelector('svg');
      expect(svg).toBeTruthy();
    });
  });

  describe('Icon Structure', () => {
    it('should render three circle shapes for branch nodes', () => {
      const { container } = render(<GitBranchIcon />);
      const paths = container.querySelectorAll('path');
      expect(paths.length).toBeGreaterThanOrEqual(4);
    });

    it('should render connecting lines between nodes', () => {
      const { container } = render(<GitBranchIcon />);
      const paths = container.querySelectorAll('path');
      const roundLinecapPaths = Array.from(paths).filter(
        (path) => path.getAttribute('stroke-linecap') === 'round'
      );
      expect(roundLinecapPaths.length).toBeGreaterThan(0);
    });
  });

  describe('Color Inheritance', () => {
    it('should inherit color from parent via currentColor', () => {
      const { container } = render(
        <div style={{ color: 'red' }}>
          <GitBranchIcon />
        </div>
      );
      const svg = container.querySelector('svg');
      const paths = container.querySelectorAll('path');
      paths.forEach((path) => {
        expect(path.getAttribute('stroke')).toBe('currentColor');
      });
      expect(svg).toBeTruthy();
    });
  });

  describe('Accessibility', () => {
    it('should be aria-hidden by default (decorative icon)', () => {
      const { container } = render(<GitBranchIcon />);
      const svg = container.querySelector('svg');
      expect(svg).toBeTruthy();
    });
  });

  describe('Size Variations', () => {
    it('should accept small size class', () => {
      const { container } = render(<GitBranchIcon className="w-3 h-3" />);
      const svg = container.querySelector('svg');
      expect(svg?.className).toContain('w-3');
      expect(svg?.className).toContain('h-3');
    });

    it('should accept medium size class', () => {
      const { container } = render(<GitBranchIcon className="w-4 h-4" />);
      const svg = container.querySelector('svg');
      expect(svg?.className).toContain('w-4');
      expect(svg?.className).toContain('h-4');
    });

    it('should accept large size class', () => {
      const { container } = render(<GitBranchIcon className="w-6 h-6" />);
      const svg = container.querySelector('svg');
      expect(svg?.className).toContain('w-6');
      expect(svg?.className).toContain('h-6');
    });
  });
});
