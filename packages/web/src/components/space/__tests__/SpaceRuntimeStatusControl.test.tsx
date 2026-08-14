// @ts-nocheck
/**
 * Unit tests for SpaceRuntimeStatusControl (the compact header pill + kebab).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/preact';
import { signal } from '@preact/signals';
import type { RuntimeState } from '@hyperneo/shared';

let mockRuntimeState: ReturnType<typeof signal<RuntimeState | null>>;
const mockPauseSpace = vi.fn().mockResolvedValue(undefined);
const mockResumeSpace = vi.fn().mockResolvedValue(undefined);
const mockStopSpace = vi.fn().mockResolvedValue(undefined);
const mockStartSpace = vi.fn().mockResolvedValue(undefined);

vi.mock('../../../lib/space-store', () => ({
  get spaceStore() {
    return {
      runtimeState: mockRuntimeState,
      pauseSpace: mockPauseSpace,
      resumeSpace: mockResumeSpace,
      stopSpace: mockStopSpace,
      startSpace: mockStartSpace,
    };
  },
}));

// Stub ConfirmModal so Stop's confirmation flow is testable without portals.
vi.mock('../../ui/ConfirmModal', () => ({
  ConfirmModal: ({ isOpen, onConfirm, confirmText, title }: any) =>
    isOpen ? (
      <div role="dialog">
        <h2>{title}</h2>
        <button type="button" onClick={onConfirm}>
          {confirmText}
        </button>
      </div>
    ) : null,
}));

mockRuntimeState = signal<RuntimeState | null>(null);

import { SpaceRuntimeStatusControl } from '../SpaceRuntimeStatusControl';

describe('SpaceRuntimeStatusControl', () => {
  beforeEach(() => {
    cleanup();
    mockRuntimeState.value = null;
    mockPauseSpace.mockClear();
    mockResumeSpace.mockClear();
    mockStopSpace.mockClear();
    mockStartSpace.mockClear();
  });

  afterEach(() => cleanup());

  it('renders nothing when there is no runtime state', () => {
    const { container } = render(<SpaceRuntimeStatusControl />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the live state label in the pill', () => {
    mockRuntimeState.value = 'running';
    const { getByText, rerender } = render(<SpaceRuntimeStatusControl />);
    expect(getByText('Running')).toBeTruthy();
    mockRuntimeState.value = 'paused';
    rerender(<SpaceRuntimeStatusControl />);
    expect(getByText('Paused')).toBeTruthy();
    mockRuntimeState.value = 'stopped';
    rerender(<SpaceRuntimeStatusControl />);
    expect(getByText('Stopped')).toBeTruthy();
  });

  it('offers Pause and Stop when running', () => {
    mockRuntimeState.value = 'running';
    const { getByRole, queryByRole } = render(<SpaceRuntimeStatusControl />);
    fireEvent.click(getByRole('button', { name: /Open runtime controls/i }));
    expect(getByRole('menuitem', { name: 'Pause' })).toBeTruthy();
    expect(getByRole('menuitem', { name: 'Stop…' })).toBeTruthy();
    expect(queryByRole('menuitem', { name: 'Resume' })).toBeNull();
    expect(queryByRole('menuitem', { name: 'Start' })).toBeNull();
  });

  it('offers Resume and Stop when paused', () => {
    mockRuntimeState.value = 'paused';
    const { getByRole, queryByRole } = render(<SpaceRuntimeStatusControl />);
    fireEvent.click(getByRole('button', { name: /Open runtime controls/i }));
    expect(getByRole('menuitem', { name: 'Resume' })).toBeTruthy();
    expect(getByRole('menuitem', { name: 'Stop…' })).toBeTruthy();
    expect(queryByRole('menuitem', { name: 'Pause' })).toBeNull();
  });

  it('offers only Start when stopped', () => {
    mockRuntimeState.value = 'stopped';
    const { getByRole, queryByRole } = render(<SpaceRuntimeStatusControl />);
    fireEvent.click(getByRole('button', { name: /Open runtime controls/i }));
    expect(getByRole('menuitem', { name: 'Start' })).toBeTruthy();
    expect(queryByRole('menuitem', { name: 'Pause' })).toBeNull();
    expect(queryByRole('menuitem', { name: 'Stop…' })).toBeNull();
  });

  it('calls pauseSpace when Pause is chosen', async () => {
    mockRuntimeState.value = 'running';
    const { getByRole } = render(<SpaceRuntimeStatusControl />);
    fireEvent.click(getByRole('button', { name: /Open runtime controls/i }));
    await fireEvent.click(getByRole('menuitem', { name: 'Pause' }));
    expect(mockPauseSpace).toHaveBeenCalledTimes(1);
  });

  it('calls resumeSpace when Resume is chosen', async () => {
    mockRuntimeState.value = 'paused';
    const { getByRole } = render(<SpaceRuntimeStatusControl />);
    fireEvent.click(getByRole('button', { name: /Open runtime controls/i }));
    await fireEvent.click(getByRole('menuitem', { name: 'Resume' }));
    expect(mockResumeSpace).toHaveBeenCalledTimes(1);
  });

  it('calls startSpace when Start is chosen', async () => {
    mockRuntimeState.value = 'stopped';
    const { getByRole } = render(<SpaceRuntimeStatusControl />);
    fireEvent.click(getByRole('button', { name: /Open runtime controls/i }));
    await fireEvent.click(getByRole('menuitem', { name: 'Start' }));
    expect(mockStartSpace).toHaveBeenCalledTimes(1);
  });

  it('opens a Stop confirmation and calls stopSpace when confirmed', async () => {
    mockRuntimeState.value = 'running';
    const { getByRole } = render(<SpaceRuntimeStatusControl />);
    fireEvent.click(getByRole('button', { name: /Open runtime controls/i }));
    fireEvent.click(getByRole('menuitem', { name: 'Stop…' }));
    // ConfirmModal stub renders the confirm button.
    const confirm = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.textContent === 'Stop Space'
    )!;
    await fireEvent.click(confirm);
    expect(mockStopSpace).toHaveBeenCalledTimes(1);
  });
});
