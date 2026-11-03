import { cleanup, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import { registerWebExtension, type SpaceWebExtension } from '../../lib/web-extensions';
import { SectionSwitcher } from '../SectionSwitcher';

describe('SectionSwitcher', () => {
  afterEach(() => cleanup());

  it('offers Spaces while Space is available', () => {
    registerWebExtension('space', { store: {} } as SpaceWebExtension);
    render(<SectionSwitcher />);
    expect(screen.getByRole('tab', { name: 'Chats' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Spaces' })).toBeTruthy();
  });

  it('hides Spaces when the daemon does not provide Space', () => {
    registerWebExtension('space', null);
    render(<SectionSwitcher />);
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.getByRole('button', { name: 'Chats' })).toBeTruthy();
    expect(screen.queryByText('Spaces')).toBeNull();
  });
});
