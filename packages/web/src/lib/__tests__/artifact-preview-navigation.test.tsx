import { effect } from '@preact/signals';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactCards } from '../../components/artifacts/ArtifactCards.tsx';
import {
  artifactPreviewStack,
  artifactPreviewWorkspace,
  backArtifactPreview,
  closeArtifactPreview,
  openArtifactPreview,
  pushArtifactPreview,
  replaceArtifactPreview,
  takeArtifactPreviewOpener,
} from '../artifact-preview-store.ts';

const target = (artifactId: string, title = artifactId) => ({
  kind: 'artifact' as const,
  artifactId,
  title,
});
const ids = () => artifactPreviewWorkspace.state.value.files.map((file) => file.artifactId);

beforeEach(() => {
  closeArtifactPreview();
  takeArtifactPreviewOpener();
});
afterEach(() => {
  closeArtifactPreview();
  takeArtifactPreviewOpener();
  cleanup();
});

describe('preview workspace navigation', () => {
  it('opens from a real artifact card with its title and reuses the same file tab', () => {
    render(
      <ArtifactCards
        artifacts={[
          { daemonId: 'd', artifactId: 'a', title: 'Report', kind: 'markdown', byteLength: 12 },
        ]}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open preview: Report' }));
    expect(artifactPreviewStack.value).toEqual([target('a', 'Report')]);
    expect(artifactPreviewWorkspace.state.value.files).toEqual([
      { artifactId: 'a', title: 'Report' },
    ]);
    artifactPreviewWorkspace.select(null);
    fireEvent.click(screen.getByRole('button', { name: 'Open preview: Report' }));
    expect(ids()).toEqual(['a']);
    expect(artifactPreviewWorkspace.state.value.selectedId).toBe('a');
  });

  it('switches files without losing tabs and closes active tabs into the left neighbor', () => {
    openArtifactPreview(target('a'));
    openArtifactPreview(target('b'));
    openArtifactPreview(target('c'));
    artifactPreviewWorkspace.select('b');
    artifactPreviewWorkspace.close('b');
    expect(artifactPreviewStack.value).toEqual([target('a')]);
    expect(ids()).toEqual(['a', 'c']);
    artifactPreviewWorkspace.close('a');
    expect(artifactPreviewStack.value).toEqual([]);
    expect(artifactPreviewWorkspace.state.value.selectedId).toBeNull();
    expect(artifactPreviewWorkspace.state.value.open).toBe(true);
    artifactPreviewWorkspace.select('c');
    expect(artifactPreviewStack.value).toEqual([target('c')]);
    artifactPreviewWorkspace.close('c');
    expect(artifactPreviewWorkspace.state.value).toEqual({
      open: true,
      files: [],
      selectedId: null,
    });
  });

  it('keeps the active viewer stack stable during background close and metadata updates', () => {
    openArtifactPreview(target('a'));
    openArtifactPreview(target('b'));
    const stack = artifactPreviewStack.value;
    artifactPreviewWorkspace.close('a');
    artifactPreviewWorkspace.update({ artifactId: 'b', title: 'Resolved report' });
    expect(artifactPreviewStack.value).toBe(stack);
    expect(artifactPreviewWorkspace.state.value.files[0].title).toBe('Resolved report');
    artifactPreviewWorkspace.update({ artifactId: 'a', title: 'Late response' });
    artifactPreviewWorkspace.select('missing');
    artifactPreviewWorkspace.close('missing');
    expect(artifactPreviewStack.value).toBe(stack);
    expect(ids()).toEqual(['b']);
    artifactPreviewWorkspace.select(null);
    artifactPreviewWorkspace.update({ artifactId: 'b', title: 'Final title' });
    expect(artifactPreviewStack.value).toEqual([]);
    expect(artifactPreviewWorkspace.state.value.selectedId).toBeNull();
    openArtifactPreview({ kind: 'artifact', artifactId: 'b' });
    expect(artifactPreviewWorkspace.state.value.files[0].title).toBe('Final title');
  });

  it('preserves reference drill-down and synchronizes artifact push/replace/back', () => {
    const reference = {
      kind: 'reference' as const,
      source: { kind: 'publication' as const, id: 'p' },
      reference: 'docs/report.md',
    };
    openArtifactPreview(target('a'));
    pushArtifactPreview(reference);
    replaceArtifactPreview({ ...reference, context: { kind: 'todo', id: 't' } });
    expect(artifactPreviewStack.value).toEqual([
      target('a'),
      { ...reference, context: { kind: 'todo', id: 't' } },
    ]);
    expect(ids()).toEqual(['a']);
    backArtifactPreview();
    expect(artifactPreviewStack.value).toEqual([target('a')]);
    pushArtifactPreview(target('b'));
    replaceArtifactPreview(target('c'));
    expect(ids()).toEqual(['a', 'b', 'c']);
    backArtifactPreview();
    expect(artifactPreviewWorkspace.state.value.selectedId).toBe('a');
    backArtifactPreview();
    expect(artifactPreviewWorkspace.state.value).toEqual({
      open: false,
      files: [],
      selectedId: null,
    });
  });

  it('publishes coherent stack/selection snapshots in one signal batch', () => {
    const observed: { stack: string | null; selected: string | null }[] = [];
    const dispose = effect(() => {
      const top = artifactPreviewStack.value.at(-1);
      observed.push({
        stack: top?.kind === 'artifact' ? top.artifactId : null,
        selected: artifactPreviewWorkspace.state.value.selectedId,
      });
    });
    try {
      openArtifactPreview(target('a'));
      openArtifactPreview(target('b'));
      artifactPreviewWorkspace.close('b');
      closeArtifactPreview();
      expect(observed).toEqual([
        { stack: null, selected: null },
        { stack: 'a', selected: 'a' },
        { stack: 'b', selected: 'b' },
        { stack: 'a', selected: 'a' },
        { stack: null, selected: null },
      ]);
    } finally {
      dispose();
    }
  });

  it('keeps the source focus opener through file switches and root dismissal', () => {
    render(
      <>
        <button>Source</button>
        <button>Tab</button>
      </>
    );
    const source = screen.getByRole('button', { name: 'Source' });
    source.focus();
    openArtifactPreview(target('a'));
    screen.getByRole('button', { name: 'Tab' }).focus();
    artifactPreviewWorkspace.select(null);
    artifactPreviewWorkspace.select('a');
    closeArtifactPreview();
    expect(takeArtifactPreviewOpener()).toBe(source);
    expect(artifactPreviewWorkspace.state.value.open).toBe(false);
  });
});
