// @ts-nocheck

import { render, cleanup } from '@testing-library/preact';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../ui/Button.tsx', () => ({
  Button: ({ children, onClick, variant, size }) => (
    <button data-testid="button" data-variant={variant} data-size={size} onClick={onClick}>
      {children}
    </button>
  ),
}));

import { OAuthModal } from '../OAuthModal';

describe('OAuthModal', () => {
  const mockOnCancel = vi.fn(() => {});
  const mockOnComplete = vi.fn(() => {});

  beforeEach(() => {
    document.body.innerHTML = '';
    mockOnCancel.mockClear();
    mockOnComplete.mockClear();
  });

  afterEach(() => {
    cleanup();
    document.body.style.overflow = '';
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('Rendering', () => {
    it('should render title with provider name', () => {
      render(
        <OAuthModal
          providerName="TestProvider"
          onCancel={mockOnCancel}
          onComplete={mockOnComplete}
        />
      );
      const title = document.body.querySelector('h3');
      expect(title?.textContent).toBe('Authenticate with TestProvider');
    });

    it('should render loading indicator', () => {
      render(
        <OAuthModal
          providerName="TestProvider"
          onCancel={mockOnCancel}
          onComplete={mockOnComplete}
        />
      );
      const spinner = document.body.querySelector('.animate-spin');
      expect(spinner).toBeTruthy();

      const waitingContainer = document.body.querySelector(
        '.flex.items-center.justify-center.py-4'
      );
      expect(waitingContainer?.textContent).toContain('Waiting for authentication');
    });

    it('should render close button (X) in header', () => {
      render(
        <OAuthModal
          providerName="TestProvider"
          onCancel={mockOnCancel}
          onComplete={mockOnComplete}
        />
      );
      const headerButton = document.body.querySelector('.flex.items-center.justify-between button');
      expect(headerButton).toBeTruthy();
      expect(headerButton?.querySelector('svg')).toBeTruthy();
    });

    it('should render Cancel button in footer', () => {
      render(
        <OAuthModal
          providerName="TestProvider"
          onCancel={mockOnCancel}
          onComplete={mockOnComplete}
        />
      );
      const buttons = document.body.querySelectorAll('[data-testid="button"]');
      const cancelButton = Array.from(buttons).find((btn) => btn.textContent === 'Cancel');
      expect(cancelButton).toBeTruthy();
    });
  });

  describe('Device Flow', () => {
    it('should show user code when userCode and verificationUri provided', () => {
      render(
        <OAuthModal
          providerName="TestProvider"
          userCode="ABCD-1234"
          verificationUri="https://example.com/verify"
          onCancel={mockOnCancel}
          onComplete={mockOnComplete}
        />
      );

      const codeElement = document.body.querySelector('code');
      expect(codeElement?.textContent).toBe('ABCD-1234');
    });

    it('should show verification URL link when userCode and verificationUri provided', () => {
      render(
        <OAuthModal
          providerName="TestProvider"
          userCode="ABCD-1234"
          verificationUri="https://example.com/verify"
          onCancel={mockOnCancel}
          onComplete={mockOnComplete}
        />
      );

      const link = document.body.querySelector('a[href="https://example.com/verify"]');
      expect(link).toBeTruthy();
      expect(link?.textContent).toBe('https://example.com/verify');
    });

    it('should show Copy Code button in device flow', () => {
      render(
        <OAuthModal
          providerName="TestProvider"
          userCode="ABCD-1234"
          verificationUri="https://example.com/verify"
          onCancel={mockOnCancel}
          onComplete={mockOnComplete}
        />
      );

      const buttons = document.body.querySelectorAll('[data-testid="button"]');
      const copyButton = Array.from(buttons).find((btn) => btn.textContent?.includes('Copy Code'));
      expect(copyButton).toBeTruthy();
    });

    it('should show Open Verification URL button in device flow', () => {
      render(
        <OAuthModal
          providerName="TestProvider"
          userCode="ABCD-1234"
          verificationUri="https://example.com/verify"
          onCancel={mockOnCancel}
          onComplete={mockOnComplete}
        />
      );

      const buttons = document.body.querySelectorAll('[data-testid="button"]');
      const openButton = Array.from(buttons).find((btn) =>
        btn.textContent?.includes('Open Verification URL')
      );
      expect(openButton).toBeTruthy();
    });

    it('should call clipboard.writeText when Copy Code button is clicked', async () => {
      const writeTextMock = vi.fn().mockResolvedValue(undefined);

      vi.stubGlobal('navigator', {
        clipboard: {
          writeText: writeTextMock,
        },
      });

      render(
        <OAuthModal
          providerName="TestProvider"
          userCode="ABCD-1234"
          verificationUri="https://example.com/verify"
          onCancel={mockOnCancel}
          onComplete={mockOnComplete}
        />
      );

      const buttons = document.body.querySelectorAll('[data-testid="button"]');
      const copyButton = Array.from(buttons).find((btn) => btn.textContent?.includes('Copy Code'));
      copyButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(writeTextMock).toHaveBeenCalledWith('ABCD-1234');
    });

    it('should open verification URL in new window when Open Verification URL button is clicked', () => {
      const openMock = vi.spyOn(window, 'open').mockImplementation(() => null);

      render(
        <OAuthModal
          providerName="TestProvider"
          userCode="ABCD-1234"
          verificationUri="https://example.com/verify"
          onCancel={mockOnCancel}
          onComplete={mockOnComplete}
        />
      );

      const buttons = document.body.querySelectorAll('[data-testid="button"]');
      const openButton = Array.from(buttons).find((btn) =>
        btn.textContent?.includes('Open Verification URL')
      );
      openButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(openMock).toHaveBeenCalledWith('https://example.com/verify', '_blank');
    });
  });

  describe('Redirect Flow', () => {
    it('should show Open Auth URL button when only authUrl provided', () => {
      render(
        <OAuthModal
          providerName="TestProvider"
          authUrl="https://example.com/auth"
          onCancel={mockOnCancel}
          onComplete={mockOnComplete}
        />
      );

      const buttons = document.body.querySelectorAll('[data-testid="button"]');
      const openButton = Array.from(buttons).find((btn) =>
        btn.textContent?.includes('Open Auth URL')
      );
      expect(openButton).toBeTruthy();
    });

    it('should not show device flow UI when only authUrl provided', () => {
      render(
        <OAuthModal
          providerName="TestProvider"
          authUrl="https://example.com/auth"
          onCancel={mockOnCancel}
          onComplete={mockOnComplete}
        />
      );

      const codeElement = document.body.querySelector('code');
      expect(codeElement).toBeNull();
    });

    it('should open auth URL in new window when Open Auth URL button is clicked', () => {
      const openMock = vi.spyOn(window, 'open').mockImplementation(() => null);

      render(
        <OAuthModal
          providerName="TestProvider"
          authUrl="https://example.com/auth"
          onCancel={mockOnCancel}
          onComplete={mockOnComplete}
        />
      );

      const buttons = document.body.querySelectorAll('[data-testid="button"]');
      const openButton = Array.from(buttons).find((btn) =>
        btn.textContent?.includes('Open Auth URL')
      );
      openButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(openMock).toHaveBeenCalledWith('https://example.com/auth', '_blank');
    });

    it('should prefer device flow when both authUrl and device flow params provided', () => {
      render(
        <OAuthModal
          providerName="TestProvider"
          authUrl="https://example.com/auth"
          userCode="ABCD-1234"
          verificationUri="https://example.com/verify"
          onCancel={mockOnCancel}
          onComplete={mockOnComplete}
        />
      );

      const codeElement = document.body.querySelector('code');
      expect(codeElement?.textContent).toBe('ABCD-1234');

      const buttons = document.body.querySelectorAll('[data-testid="button"]');
      const openButton = Array.from(buttons).find((btn) =>
        btn.textContent?.includes('Open Verification URL')
      );
      expect(openButton).toBeTruthy();
    });
  });

  describe('Interactions', () => {
    it('should call onCancel when Escape key is pressed', () => {
      render(
        <OAuthModal
          providerName="TestProvider"
          onCancel={mockOnCancel}
          onComplete={mockOnComplete}
        />
      );

      const escapeEvent = new KeyboardEvent('keydown', { key: 'Escape' });
      window.dispatchEvent(escapeEvent);

      expect(mockOnCancel).toHaveBeenCalledTimes(1);
    });

    it('should call onCancel when Cancel button is clicked', () => {
      render(
        <OAuthModal
          providerName="TestProvider"
          onCancel={mockOnCancel}
          onComplete={mockOnComplete}
        />
      );

      const buttons = document.body.querySelectorAll('[data-testid="button"]');
      const cancelButton = Array.from(buttons).find((btn) => btn.textContent === 'Cancel');
      cancelButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(mockOnCancel).toHaveBeenCalledTimes(1);
    });

    it('should call onCancel when backdrop is clicked', () => {
      render(
        <OAuthModal
          providerName="TestProvider"
          onCancel={mockOnCancel}
          onComplete={mockOnComplete}
        />
      );

      const backdrop = document.body.querySelector('.bg-black\\/60');
      backdrop?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(mockOnCancel).toHaveBeenCalledTimes(1);
    });

    it('should call onCancel when close button (X) in header is clicked', () => {
      render(
        <OAuthModal
          providerName="TestProvider"
          onCancel={mockOnCancel}
          onComplete={mockOnComplete}
        />
      );

      const headerButton = document.body.querySelector('.flex.items-center.justify-between button');
      headerButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(mockOnCancel).toHaveBeenCalledTimes(1);
    });
  });
});
