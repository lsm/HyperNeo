// @ts-nocheck
import { describe, it, expect } from 'vitest';

import { render } from '@testing-library/preact';
import { AuthStatusCard } from '../AuthStatusCard';

describe('AuthStatusCard', () => {
  describe('Default Variant', () => {
    it('should render authenticating state', () => {
      const { container } = render(<AuthStatusCard isAuthenticating={true} />);
      expect(container.textContent).toContain('Authenticating...');
    });

    it('should render authenticated state', () => {
      const { container } = render(<AuthStatusCard isAuthenticating={false} />);
      expect(container.textContent).toContain('Authentication Complete');
    });

    it('should show spinner when authenticating', () => {
      const { container } = render(<AuthStatusCard isAuthenticating={true} />);
      const spinner = container.querySelector('.animate-spin');
      expect(spinner).toBeTruthy();
    });

    it('should not show spinner when not authenticating', () => {
      const { container } = render(<AuthStatusCard isAuthenticating={false} />);
      const spinner = container.querySelector('.animate-spin');
      expect(spinner).toBeNull();
    });

    it('should apply custom className', () => {
      const { container } = render(
        <AuthStatusCard isAuthenticating={false} className="custom-auth-class" />
      );
      const wrapper = container.querySelector('.custom-auth-class');
      expect(wrapper).toBeTruthy();
    });
  });

  describe('Output Messages', () => {
    it('should display output messages', () => {
      const { container } = render(
        <AuthStatusCard isAuthenticating={false} output={['Login successful', 'Session created']} />
      );
      expect(container.textContent).toContain('Login successful');
      expect(container.textContent).toContain('Session created');
    });

    it('should join output messages with newlines', () => {
      const { container } = render(
        <AuthStatusCard isAuthenticating={false} output={['Line 1', 'Line 2']} />
      );
      const outputDiv = container.querySelector('.whitespace-pre-wrap');
      expect(outputDiv?.textContent).toContain('Line 1');
      expect(outputDiv?.textContent).toContain('Line 2');
    });

    it('should not show output section when output is empty', () => {
      const { container } = render(<AuthStatusCard isAuthenticating={false} output={[]} />);
      const outputDiv = container.querySelector('.whitespace-pre-wrap');
      expect(outputDiv).toBeNull();
    });

    it('should not show output section when output is undefined', () => {
      const { container } = render(<AuthStatusCard isAuthenticating={false} />);
      const outputDiv = container.querySelector('.whitespace-pre-wrap');
      expect(outputDiv).toBeNull();
    });
  });

  describe('Error Display', () => {
    it('should display error message', () => {
      const { container } = render(
        <AuthStatusCard isAuthenticating={false} error="Authentication failed" />
      );
      expect(container.textContent).toContain('Error: Authentication failed');
    });

    it('should show error in red color', () => {
      const { container } = render(<AuthStatusCard isAuthenticating={false} error="Failed" />);
      const errorDiv = container.querySelector('.text-danger');
      expect(errorDiv).toBeTruthy();
    });

    it('should not show error section when no error', () => {
      const { container } = render(<AuthStatusCard isAuthenticating={false} />);
      const content = container.textContent || '';
      expect(content.includes('Error:')).toBe(false);
    });
  });

  describe('Compact Variant', () => {
    it('should render in compact style', () => {
      const { container } = render(<AuthStatusCard isAuthenticating={true} variant="compact" />);
      const card = container.querySelector('.py-1');
      expect(card).toBeTruthy();
    });

    it('should show "Authenticating..." in compact mode when authenticating', () => {
      const { container } = render(<AuthStatusCard isAuthenticating={true} variant="compact" />);
      expect(container.textContent).toContain('Authenticating...');
    });

    it('should show "Authenticated" in compact mode when done', () => {
      const { container } = render(<AuthStatusCard isAuthenticating={false} variant="compact" />);
      expect(container.textContent).toContain('Authenticated');
    });

    it('should show smaller spinner in compact mode', () => {
      const { container } = render(<AuthStatusCard isAuthenticating={true} variant="compact" />);
      const svg = container.querySelector('.animate-spin svg');
      expect(svg?.className).toContain('w-3');
    });
  });

  describe('Inline Variant', () => {
    it('should render as inline element', () => {
      const { container } = render(<AuthStatusCard isAuthenticating={false} variant="inline" />);
      const card = container.querySelector('.inline-flex');
      expect(card).toBeTruthy();
    });

    it('should show emoji for authenticating in inline mode', () => {
      const { container } = render(<AuthStatusCard isAuthenticating={true} variant="inline" />);
      expect(container.textContent).toContain('Authenticating...');
    });

    it('should show checkmark for authenticated in inline mode', () => {
      const { container } = render(<AuthStatusCard isAuthenticating={false} variant="inline" />);
      expect(container.textContent).toContain('Authenticated');
    });
  });

  describe('Styling', () => {
    it('should have blue background color', () => {
      const { container } = render(<AuthStatusCard isAuthenticating={false} />);
      const card = container.querySelector('.bg-accent\\/10');
      expect(card).toBeTruthy();
    });

    it('should have blue border color', () => {
      const { container } = render(<AuthStatusCard isAuthenticating={false} />);
      const card = container.querySelector('.border-accent\\/40');
      expect(card).toBeTruthy();
    });

    it('should have rounded corners in default mode', () => {
      const { container } = render(<AuthStatusCard isAuthenticating={false} />);
      const card = container.querySelector('.rounded');
      expect(card).toBeTruthy();
    });
  });

  describe('Combined States', () => {
    it('should show output and error together', () => {
      const { container } = render(
        <AuthStatusCard
          isAuthenticating={false}
          output={['Some progress']}
          error="But failed at the end"
        />
      );
      expect(container.textContent).toContain('Some progress');
      expect(container.textContent).toContain('But failed at the end');
    });

    it('should handle authenticating with partial output', () => {
      const { container } = render(
        <AuthStatusCard
          isAuthenticating={true}
          output={['Connecting...', 'Waiting for response...']}
        />
      );
      expect(container.textContent).toContain('Authenticating...');
      expect(container.textContent).toContain('Connecting...');
      expect(container.textContent).toContain('Waiting for response...');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty string error', () => {
      const { container } = render(<AuthStatusCard isAuthenticating={false} error="" />);
      expect(container.textContent?.includes('Error:')).toBe(false);
    });

    it('should handle single output message', () => {
      const { container } = render(
        <AuthStatusCard isAuthenticating={false} output={['Single message']} />
      );
      expect(container.textContent).toContain('Single message');
    });

    it('should handle many output messages', () => {
      const messages = Array(10)
        .fill(0)
        .map((_, i) => `Message ${i}`);
      const { container } = render(<AuthStatusCard isAuthenticating={false} output={messages} />);
      expect(container.textContent).toContain('Message 0');
      expect(container.textContent).toContain('Message 9');
    });

    it('should handle very long error message', () => {
      const longError = 'A'.repeat(500);
      const { container } = render(<AuthStatusCard isAuthenticating={false} error={longError} />);
      expect(container.textContent).toContain(longError);
    });
  });
});
