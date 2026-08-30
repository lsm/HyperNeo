// @ts-nocheck

import { render, fireEvent } from '@testing-library/preact';
import { describe, it, expect, vi } from 'vitest';
import { ActionBar } from '../ActionBar';

describe('ActionBar', () => {
  describe('Type styling', () => {
    it('renders with amber border and bg for type=review', () => {
      const { getByTestId } = render(
        <ActionBar
          type="review"
          title="Review needed"
          primaryAction={{ label: 'Approve', onClick: vi.fn() }}
        />
      );
      const bar = getByTestId('action-bar');
      expect(bar.className).toContain('border-l-amber-500');
      expect(bar.className).toContain('bg-warning/30');
    });

    it('renders with red border and bg for type=needs_attention', () => {
      const { getByTestId } = render(
        <ActionBar
          type="needs_attention"
          title="Needs attention"
          primaryAction={{ label: 'Fix', onClick: vi.fn() }}
        />
      );
      const bar = getByTestId('action-bar');
      expect(bar.className).toContain('border-l-red-500');
      expect(bar.className).toContain('bg-danger/30');
    });

    it('renders with blue border and bg for type=confirm', () => {
      const { getByTestId } = render(
        <ActionBar
          type="confirm"
          title="Confirm action"
          primaryAction={{ label: 'Confirm', onClick: vi.fn() }}
        />
      );
      const bar = getByTestId('action-bar');
      expect(bar.className).toContain('border-l-blue-500');
      expect(bar.className).toContain('bg-accent/30');
    });
  });

  describe('Title and description', () => {
    it('renders the title', () => {
      const { getByText } = render(
        <ActionBar
          type="review"
          title="Review the PR"
          primaryAction={{ label: 'Approve', onClick: vi.fn() }}
        />
      );
      expect(getByText('Review the PR')).toBeTruthy();
    });

    it('renders description when provided', () => {
      const { getByText } = render(
        <ActionBar
          type="review"
          title="Review"
          description="Please check the changes"
          primaryAction={{ label: 'Approve', onClick: vi.fn() }}
        />
      );
      expect(getByText('Please check the changes')).toBeTruthy();
    });

    it('does not render description element when omitted', () => {
      const { queryByText } = render(
        <ActionBar
          type="review"
          title="Review"
          primaryAction={{ label: 'Approve', onClick: vi.fn() }}
        />
      );
      expect(queryByText('Please check the changes')).toBeNull();
    });
  });

  describe('Primary action', () => {
    it('renders primary button with given label', () => {
      const { getByTestId } = render(
        <ActionBar
          type="review"
          title="Review"
          primaryAction={{ label: 'Approve', onClick: vi.fn() }}
        />
      );
      expect(getByTestId('action-bar-primary').textContent).toContain('Approve');
    });

    it('calls primaryAction.onClick when primary button is clicked', () => {
      const onClick = vi.fn();
      const { getByTestId } = render(
        <ActionBar type="review" title="Review" primaryAction={{ label: 'Approve', onClick }} />
      );
      fireEvent.click(getByTestId('action-bar-primary'));
      expect(onClick).toHaveBeenCalledOnce();
    });

    it('shows spinner when loading=true', () => {
      const { getByTestId } = render(
        <ActionBar
          type="review"
          title="Review"
          primaryAction={{ label: 'Approve', onClick: vi.fn(), loading: true }}
        />
      );
      const btn = getByTestId('action-bar-primary');
      expect(btn.querySelector('svg.animate-spin')).not.toBeNull();
    });

    it('disables primary button when loading=true', () => {
      const { getByTestId } = render(
        <ActionBar
          type="review"
          title="Review"
          primaryAction={{ label: 'Approve', onClick: vi.fn(), loading: true }}
        />
      );
      expect((getByTestId('action-bar-primary') as HTMLButtonElement).disabled).toBe(true);
    });

    it('uses approve variant class when variant=approve', () => {
      const { getByTestId } = render(
        <ActionBar
          type="review"
          title="Review"
          primaryAction={{ label: 'Approve', onClick: vi.fn(), variant: 'approve' }}
        />
      );
      expect(getByTestId('action-bar-primary').className).toContain('bg-emerald-600');
    });

    it('uses danger variant class when variant=danger', () => {
      const { getByTestId } = render(
        <ActionBar
          type="needs_attention"
          title="Danger"
          primaryAction={{ label: 'Delete', onClick: vi.fn(), variant: 'danger' }}
        />
      );
      expect(getByTestId('action-bar-primary').className).toContain('bg-danger');
    });
  });

  describe('Secondary action', () => {
    it('does not render secondary button when not provided', () => {
      const { queryByTestId } = render(
        <ActionBar
          type="review"
          title="Review"
          primaryAction={{ label: 'Approve', onClick: vi.fn() }}
        />
      );
      expect(queryByTestId('action-bar-secondary')).toBeNull();
    });

    it('renders secondary button with given label', () => {
      const { getByTestId } = render(
        <ActionBar
          type="review"
          title="Review"
          primaryAction={{ label: 'Approve', onClick: vi.fn() }}
          secondaryAction={{ label: 'Reject', onClick: vi.fn() }}
        />
      );
      expect(getByTestId('action-bar-secondary').textContent).toContain('Reject');
    });

    it('calls secondaryAction.onClick when secondary button is clicked', () => {
      const onClick = vi.fn();
      const { getByTestId } = render(
        <ActionBar
          type="review"
          title="Review"
          primaryAction={{ label: 'Approve', onClick: vi.fn() }}
          secondaryAction={{ label: 'Reject', onClick }}
        />
      );
      fireEvent.click(getByTestId('action-bar-secondary'));
      expect(onClick).toHaveBeenCalledOnce();
    });

    it('disables secondary button when disabled=true', () => {
      const { getByTestId } = render(
        <ActionBar
          type="review"
          title="Review"
          primaryAction={{ label: 'Approve', onClick: vi.fn() }}
          secondaryAction={{ label: 'Reject', onClick: vi.fn(), disabled: true }}
        />
      );
      expect((getByTestId('action-bar-secondary') as HTMLButtonElement).disabled).toBe(true);
    });
  });

  describe('Meta slot', () => {
    it('renders meta content when provided', () => {
      const { getByTestId } = render(
        <ActionBar
          type="review"
          title="Review"
          primaryAction={{ label: 'Approve', onClick: vi.fn() }}
          meta={<span data-testid="pr-link">PR #42</span>}
        />
      );
      expect(getByTestId('pr-link')).toBeTruthy();
    });
  });
});
