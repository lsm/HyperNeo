// @ts-nocheck
import { cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import { InspectBadge, InspectPanel, InspectPanelHeader } from '../InspectPanel';

describe('InspectPanel', () => {
  afterEach(() => cleanup());

  it('renders the header slot followed by the body', () => {
    const { container } = render(
      <InspectPanel header={<div data-testid="hdr" />}>
        <div data-testid="body" />
      </InspectPanel>
    );
    expect(container.querySelector('[data-testid="hdr"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="body"]')).toBeTruthy();
    expect(container.firstElementChild.className).toContain('flex h-full min-w-0 flex-col');
  });

  it('replaces header + body with the empty-state surface when provided', () => {
    const { container } = render(
      <InspectPanel header={<div data-testid="hdr" />} emptyState={<p>Not found</p>}>
        <div data-testid="body" />
      </InspectPanel>
    );
    expect(container.querySelector('[data-testid="hdr"]')).toBeNull();
    expect(container.querySelector('[data-testid="body"]')).toBeNull();
    expect(container.textContent).toContain('Not found');
  });
});

describe('InspectPanelHeader', () => {
  afterEach(() => cleanup());

  it('renders the title as a truncated heading with the bottom hairline', () => {
    const { container } = render(<InspectPanelHeader title="Release health" />);
    const heading = container.querySelector('h2');
    expect(heading?.textContent).toBe('Release health');
    expect(heading.className).toContain('truncate');
    expect(container.querySelector('.pr-12')).toBeTruthy();
    expect(container.querySelector('.bg-fill-strong')).toBeTruthy();
  });

  it('renders inline actions and a badges row', () => {
    const { container } = render(
      <InspectPanelHeader
        title="Ship task panel"
        actions={<button type="button">Edit</button>}
        badges={<span data-testid="badge">Open</span>}
      />
    );
    expect(container.querySelector('button')?.textContent).toBe('Edit');
    expect(container.querySelector('[data-testid="badge"]')).toBeTruthy();
  });
});

describe('InspectBadge', () => {
  afterEach(() => cleanup());

  it('applies the unified tone soft classes when a tone is given', () => {
    const { container } = render(<InspectBadge tone="warning">High Priority</InspectBadge>);
    const badge = container.querySelector('span');
    expect(badge?.textContent).toContain('High Priority');
    expect(badge.className).toContain('border-warning/30');
    expect(badge.className).toContain('bg-warning/10');
  });

  it('omits tone classes and honors a bespoke class when no tone is given', () => {
    const { container } = render(<InspectBadge class="font-mono text-fg-soft">#{42}</InspectBadge>);
    const badge = container.querySelector('span');
    expect(badge.className).toContain('font-mono');
    expect(badge.className).not.toContain('border-warning');
  });
});
