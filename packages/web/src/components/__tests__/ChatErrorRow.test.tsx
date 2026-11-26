// @ts-nocheck
import { describe, it, expect, vi } from 'vitest';

import { render, fireEvent, cleanup, screen, within } from '@testing-library/preact';
import { ChatErrorRow } from '../ChatErrorRow';

describe('ChatErrorRow', () => {
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
        <ChatErrorRow error="Test error message" onDismiss={mockOnDismiss} />
      );

      expect(container.textContent).toContain('Test error message');
    });

    it('should render dismiss button', () => {
      const { container } = render(<ChatErrorRow error="Test error" onDismiss={mockOnDismiss} />);

      const dismissButton = container.querySelector('[aria-label="Dismiss error"]');
      expect(dismissButton).toBeTruthy();
    });
  });

  it('shows a source title and the actionable cause before Details opens', () => {
    render(
      <ChatErrorRow
        error="An unexpected error occurred. Please try again."
        details={{
          title: 'Codex could not start',
          message: 'No executable was found at the configured path.\nFull client log',
          recoverySuggestions: ['Check the configured Codex executable path.'],
        }}
        onViewDetails={mockOnViewDetails}
        onDismiss={mockOnDismiss}
      />
    );
    const row = within(screen.getByRole('alert'));
    expect(row.getByText('Codex could not start', { selector: 'strong' })).toBeTruthy();
    expect(row.getByText('Check the configured Codex executable path.')).toBeTruthy();
    expect(row.queryByText(/full client log/i)).toBeNull();
  });

  it.each([
    ['Usage limit reached. Try again after 9 PM.', 'Usage limit reached', 'Try again after 9 PM.'],
    [
      'Lost connection: Check your network and retry.',
      'Lost connection',
      'Check your network and retry.',
    ],
  ])('shows the failure and next step from %s', (error, title, cause) => {
    render(<ChatErrorRow error={error} onDismiss={mockOnDismiss} />);
    const row = within(screen.getByRole('alert'));
    expect(row.getByText(title, { selector: 'strong' })).toBeTruthy();
    expect(row.getByText(cause)).toBeTruthy();
  });

  describe('Details Button', () => {
    it('should not render Details button when hasDetails is false', () => {
      const { container } = render(
        <ChatErrorRow
          error="Test error"
          hasDetails={false}
          onViewDetails={mockOnViewDetails}
          onDismiss={mockOnDismiss}
        />
      );

      expect(container.textContent).not.toContain('Details');
    });

    it('should not render Details button when hasDetails is not provided', () => {
      const { container } = render(<ChatErrorRow error="Test error" onDismiss={mockOnDismiss} />);

      expect(container.textContent).not.toContain('Details');
    });

    it('should render Details button when hasDetails is true and onViewDetails is provided', () => {
      const { container } = render(
        <ChatErrorRow
          error="Test error"
          hasDetails={true}
          onViewDetails={mockOnViewDetails}
          onDismiss={mockOnDismiss}
        />
      );

      expect(container.textContent).toContain('Details');
    });

    it('should not render Details button when hasDetails is true but onViewDetails is not provided', () => {
      const { container } = render(
        <ChatErrorRow error="Test error" hasDetails={true} onDismiss={mockOnDismiss} />
      );

      expect(container.textContent).not.toContain('Details');
    });

    it('should call onViewDetails when Details button is clicked', () => {
      const { container } = render(
        <ChatErrorRow
          error="Test error"
          hasDetails={true}
          onViewDetails={mockOnViewDetails}
          onDismiss={mockOnDismiss}
        />
      );

      const viewDetailsButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Details')
      )!;
      fireEvent.click(viewDetailsButton);

      expect(mockOnViewDetails).toHaveBeenCalledTimes(1);
    });
  });

  describe('Dismiss Functionality', () => {
    it('should call onDismiss when dismiss button is clicked', () => {
      const { container } = render(<ChatErrorRow error="Test error" onDismiss={mockOnDismiss} />);

      const dismissButton = container.querySelector('[aria-label="Dismiss error"]')!;
      fireEvent.click(dismissButton);

      expect(mockOnDismiss).toHaveBeenCalledTimes(1);
    });

    it('should call onDismiss only once per click', () => {
      const { container } = render(<ChatErrorRow error="Test error" onDismiss={mockOnDismiss} />);

      const dismissButton = container.querySelector('[aria-label="Dismiss error"]')!;
      fireEvent.click(dismissButton);
      fireEvent.click(dismissButton);

      expect(mockOnDismiss).toHaveBeenCalledTimes(2);
    });
  });

  describe('Error Message Variations', () => {
    it('should display short error messages', () => {
      const { container } = render(<ChatErrorRow error="Error" onDismiss={mockOnDismiss} />);

      expect(container.textContent).toContain('Error');
    });

    it('should display long error messages', () => {
      const longError =
        'This is a very long error message that describes a complex problem that occurred during the operation and provides detailed information about what went wrong.';
      const { container } = render(<ChatErrorRow error={longError} onDismiss={mockOnDismiss} />);

      expect(container.textContent).toContain(longError);
    });

    it('should display error messages with special characters', () => {
      const specialError = 'Error: <script>alert("xss")</script>';
      const { container } = render(<ChatErrorRow error={specialError} onDismiss={mockOnDismiss} />);

      expect(container.querySelector('strong')?.textContent).toBe('<script>alert("xss")</script>');
      expect(container.querySelector('script')).toBeNull();
    });
  });
});
