import { describe, it, expect, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/preact';
import { CollapsibleSection } from '../CollapsibleSection';

describe('CollapsibleSection', () => {
  afterEach(() => cleanup());

  it('renders title and children when expanded by default', () => {
    const { getByText } = render(
      <CollapsibleSection title="Tasks">
        <div>Task content</div>
      </CollapsibleSection>
    );

    expect(getByText('Tasks')).toBeTruthy();
    expect(getByText('Task content')).toBeTruthy();
    expect(getByText('▼')).toBeTruthy();
  });

  it('hides children when defaultExpanded is false', () => {
    const { getByText, queryByText } = render(
      <CollapsibleSection title="Sessions" defaultExpanded={false}>
        <div>Session content</div>
      </CollapsibleSection>
    );

    expect(getByText('Sessions')).toBeTruthy();
    expect(queryByText('Session content')).toBeNull();
    expect(getByText('▶')).toBeTruthy();
  });

  it('toggles children visibility on header click', () => {
    const { getByText, queryByText, getByRole } = render(
      <CollapsibleSection title="Tasks">
        <div>Task content</div>
      </CollapsibleSection>
    );

    expect(getByText('Task content')).toBeTruthy();

    fireEvent.click(getByRole('button'));
    expect(queryByText('Task content')).toBeNull();
    expect(getByText('▶')).toBeTruthy();

    fireEvent.click(getByRole('button'));
    expect(getByText('Task content')).toBeTruthy();
    expect(getByText('▼')).toBeTruthy();
  });

  it('renders count and headerRight slot', () => {
    const { getByText } = render(
      <CollapsibleSection title="Sessions" count={2} headerRight={<span>+</span>}>
        <div>Content</div>
      </CollapsibleSection>
    );

    expect(getByText('(2)')).toBeTruthy();
    expect(getByText('+')).toBeTruthy();
  });
});
