import { describe, expect, it } from 'vitest';
import { artifactPreviewStack, previewWorkspace } from '../artifact-preview-store.ts';
import type {
  PreviewWorkspaceEvent,
  PreviewWorkspaceState,
} from '../artifact-preview-workspace.ts';

const file = (artifactId: string, title = artifactId) => ({ artifactId, title });
const open = (state: PreviewWorkspaceState, artifactId: string, title = artifactId) =>
  previewWorkspace.step(state, { kind: 'open', file: file(artifactId, title) });
const ids = (state: PreviewWorkspaceState) => state.files.map((item) => item.artifactId);

describe('previewWorkspace', () => {
  it('reopens a file from Work without duplicating or reordering its tab', () => {
    const first = open(previewWorkspace.empty(), 'report', 'Report');
    const second = open(first, 'page', 'Website');
    const work = previewWorkspace.step(second, { kind: 'select', artifactId: null });
    expect(work.open).toBe(true);
    expect(work.selectedId).toBeNull();
    expect(ids(work)).toEqual(['report', 'page']);
    const reopened = open(work, 'report', 'Report');
    expect(reopened.selectedId).toBe('report');
    expect(ids(reopened)).toEqual(['report', 'page']);
    expect(reopened.files).toBe(second.files);
  });

  it('keeps distinct snapshots with the same title as separate tabs', () => {
    const before = open(previewWorkspace.empty(), 'snapshot-1', 'Report');
    const after = open(before, 'snapshot-2', 'Report');
    expect(ids(after)).toEqual(['snapshot-1', 'snapshot-2']);
    expect(after.selectedId).toBe('snapshot-2');
    expect(before.files).toEqual([file('snapshot-1', 'Report')]);
  });

  it('closes the active tab into its left predecessor, then the persistent Work tab', () => {
    let state = open(open(open(previewWorkspace.empty(), 'a'), 'b'), 'c');
    state = previewWorkspace.step(state, { kind: 'select', artifactId: 'b' });
    state = previewWorkspace.step(state, { kind: 'close', artifactId: 'b' });
    expect(state.selectedId).toBe('a');
    expect(ids(state)).toEqual(['a', 'c']);
    state = previewWorkspace.step(state, { kind: 'close', artifactId: 'a' });
    expect(state.selectedId).toBeNull();
    expect(ids(state)).toEqual(['c']);
    state = previewWorkspace.step(state, { kind: 'close', artifactId: 'c' });
    expect(state).toEqual({ open: true, selectedId: null, files: [] });
    expect(open(state, 'd').selectedId).toBe('d');
  });

  it.each(['a', 'c'])('closes background tab %s while preserving the selected file', (id) => {
    let state = open(open(open(previewWorkspace.empty(), 'a'), 'b'), 'c');
    state = previewWorkspace.step(state, { kind: 'select', artifactId: 'b' });
    const after = previewWorkspace.step(state, { kind: 'close', artifactId: id });
    expect(after.selectedId).toBe('b');
    expect(ids(after)).not.toContain(id);
    expect(after.open).toBe(true);
  });

  it('updates a title without changing identity/order or mutating earlier state', () => {
    const before = open(open(previewWorkspace.empty(), 'a', 'Loading'), 'b');
    Object.freeze(before.files[0]);
    Object.freeze(before.files);
    Object.freeze(before);
    const input = file('a', 'Report');
    const after = previewWorkspace.step(before, { kind: 'open', file: input });
    input.title = 'Changed by caller';
    expect(after.files[0]).toEqual(file('a', 'Report'));
    expect(after.files[1]).toBe(before.files[1]);
    expect(before.files[0].title).toBe('Loading');
    expect(ids(after)).toEqual(['a', 'b']);
    expect(after.selectedId).toBe('a');
  });

  it('ignores stale file events and clears files only when the workspace is dismissed', () => {
    const closed = previewWorkspace.empty();
    expect(previewWorkspace.step(closed, { kind: 'select', artifactId: 'missing' })).toBe(closed);
    const state = open(closed, 'a');
    expect(previewWorkspace.step(state, { kind: 'close', artifactId: 'missing' })).toBe(state);
    expect(previewWorkspace.step(state, { kind: 'select', artifactId: 'missing' })).toBe(state);
    const dismissed = previewWorkspace.step(state, { kind: 'dismiss' });
    expect(dismissed).toEqual({ open: false, files: [], selectedId: null });
    expect(ids(open(dismissed, 'b'))).toEqual(['b']);
  });

  it('updates background metadata without selecting it or reopening a closed file', () => {
    const state = open(open(previewWorkspace.empty(), 'a', 'Loading'), 'b');
    const after = previewWorkspace.step(state, { kind: 'update', file: file('a', 'Report') });
    expect(after.selectedId).toBe('b');
    expect(after.files[0]).toEqual(file('a', 'Report'));
    const closed = previewWorkspace.step(after, { kind: 'close', artifactId: 'a' });
    expect(previewWorkspace.step(closed, { kind: 'update', file: file('a') })).toBe(closed);
    const work = previewWorkspace.step(after, { kind: 'select', artifactId: null });
    expect(previewWorkspace.step(work, { kind: 'update', file: file('a') }).selectedId).toBeNull();
  });

  it('keeps selected files present and identities unique across long user flows', () => {
    const currentPreview = artifactPreviewStack.value;
    let state = previewWorkspace.empty();
    const events: PreviewWorkspaceEvent[] = [];
    for (let index = 0; index < 40; index++) {
      events.push(
        { kind: 'open', file: file(`file-${index % 9}`, `Title ${index}`) },
        { kind: 'select', artifactId: index % 3 ? `file-${index % 7}` : null },
        { kind: 'close', artifactId: `file-${(index + 4) % 9}` }
      );
      if (index % 11 === 0) events.push({ kind: 'dismiss' });
    }
    for (const event of events) {
      state = previewWorkspace.step(state, event);
      expect(new Set(ids(state)).size).toBe(state.files.length);
      if (state.selectedId !== null) expect(ids(state)).toContain(state.selectedId);
      if (!state.open) expect(state.files).toEqual([]);
    }
    expect(artifactPreviewStack.value).toBe(currentPreview);
  });
});
