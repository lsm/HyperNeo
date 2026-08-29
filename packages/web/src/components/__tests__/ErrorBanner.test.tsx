// @ts-nocheck
import { describe, it, expect, vi } from 'vitest';

import { render, fireEvent, cleanup } from '@testing-library/preact';
import { ErrorBanner } from '../ErrorBanner';

describe('ErrorBanner', () => {
  const mockOnDismiss = vi.fn(() => {});
  const mockOnViewDetails = vi.fn(() => {});

  beforeEach(() => {
    cleanup();
    mockOnDismiss.mockClear();
    mockOnViewDetails.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  describe('Basic Rendering', () => {
    it('should render error message', () => {
      const { container } = render(
        <ErrorBanner error="Test error message" onDismiss={mockOnDismiss} />
      );

      expect(container.textContent).toContain('Test error message');
    });

    it('should have correct data-testid', () => {
      const { container } = render(<ErrorBanner error="Test error" onDismiss={mockOnDismiss} />);

      const banner = container.querySelector('[data-testid="error-banner"]');
      expect(banner).toBeTruthy();
    });

    it('should render dismiss button', () => {
      const { container } = render(<ErrorBanner error="Test error" onDismiss={mockOnDismiss} />);

      const dismissButton = container.querySelector('[aria-label="Dismiss error"]');
      expect(dismissButton).toBeTruthy();
    });
  });

  describe('View Details Button', () => {
    it('should not render View Details button when hasDetails is false', () => {
      const { container } = render(
        <ErrorBanner
          error="Test error"
          hasDetails={false}
          onViewDetails={mockOnViewDetails}
          onDismiss={mockOnDismiss}
        />
      );

      expect(container.textContent).not.toContain('View Details');
    });

    it('should not render View Details button when hasDetails is not provided', () => {
      const { container } = render(<ErrorBanner error="Test error" onDismiss={mockOnDismiss} />);

      expect(container.textContent).not.toContain('View Details');
    });

    it('should render View Details button when hasDetails is true and onViewDetails is provided', () => {
      const { container } = render(
        <ErrorBanner
          error="Test error"
          hasDetails={true}
          onViewDetails={mockOnViewDetails}
          onDismiss={mockOnDismiss}
        />
      );

      expect(container.textContent).toContain('View Details');
    });

    it('should not render View Details button when hasDetails is true but onViewDetails is not provided', () => {
      const { container } = render(
        <ErrorBanner error="Test error" hasDetails={true} onDismiss={mockOnDismiss} />
      );

      expect(container.textContent).not.toContain('View Details');
    });

    it('should call onViewDetails when View Details button is clicked', () => {
      const { container } = render(
        <ErrorBanner
          error="Test error"
          hasDetails={true}
          onViewDetails={mockOnViewDetails}
          onDismiss={mockOnDismiss}
        />
      );

      const viewDetailsButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('View Details')
      )!;
      fireEvent.click(viewDetailsButton);

      expect(mockOnViewDetails).toHaveBeenCalledTimes(1);
    });
  });

  describe('Dismiss Functionality', () => {
    it('should call onDismiss when dismiss button is clicked', () => {
      const { container } = render(<ErrorBanner error="Test error" onDismiss={mockOnDismiss} />);

      const dismissButton = container.querySelector('[aria-label="Dismiss error"]')!;
      fireEvent.click(dismissButton);

      expect(mockOnDismiss).toHaveBeenCalledTimes(1);
    });

    it('should call onDismiss only once per click', () => {
      const { container } = render(<ErrorBanner error="Test error" onDismiss={mockOnDismiss} />);

      const dismissButton = container.querySelector('[aria-label="Dismiss error"]')!;
      fireEvent.click(dismissButton);
      fireEvent.click(dismissButton);

      expect(mockOnDismiss).toHaveBeenCalledTimes(2);
    });
  });

  describe('Error Message Variations', () => {
    it('should display short error messages', () => {
      const { container } = render(<ErrorBanner error="Error" onDismiss={mockOnDismiss} />);

      expect(container.textContent).toContain('Error');
    });

    it('should display long error messages', () => {
      const longError =
        'This is a very long error message that describes a complex problem that occurred during the operation and provides detailed information about what went wrong.';
      const { container } = render(<ErrorBanner error={longError} onDismiss={mockOnDismiss} />);

      expect(container.textContent).toContain(longError);
    });

    it('should display error messages with special characters', () => {
      const specialError = 'Error: <script>alert("xss")</script>';
      const { container } = render(<ErrorBanner error={specialError} onDismiss={mockOnDismiss} />);

      expect(container.textContent).toContain(specialError);
    });
  });

  describe('Styling', () => {
    it('should have error styling with red colors', () => {
      const { container } = render(<ErrorBanner error="Test error" onDismiss={mockOnDismiss} />);

      const banner = container.querySelector('[data-testid="error-banner"]')!;
      expect(banner.className).toContain('bg-surface');
    });

    it('should have error text styling', () => {
      const { container } = render(<ErrorBanner error="Test error" onDismiss={mockOnDismiss} />);

      const errorText = container.querySelector('.text-danger');
      expect(errorText).toBeTruthy();
    });
  });
});
