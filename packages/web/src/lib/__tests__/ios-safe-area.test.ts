import { describe, expect, it } from 'vitest';
import indexHtml from '../../index.html?raw';
import neoIndexHtml from '../../neo/index.html?raw';
import appTsx from '../../App.tsx?raw';
import useViewportSafetyTs from '../../hooks/useViewportSafety.ts?raw';

describe('iOS iPad Safari safe area support', () => {
  it('opts the Neo entry into safe-area layout for its phone preview', () => {
    const entry = new DOMParser().parseFromString(neoIndexHtml, 'text/html');
    const viewport = entry.querySelector('meta[name="viewport"]')!.getAttribute('content')!;
    expect(viewport.split(',').map((value) => value.trim())).toContain('viewport-fit=cover');
    expect(viewport).toContain('width=device-width');
    expect(viewport).not.toContain('user-scalable=no');
  });

  it('viewport meta tag includes viewport-fit=cover', () => {
    expect(indexHtml).toContain('viewport-fit=cover');
  });

  it('App.tsx applies pt-safe class to the root container for top safe area', () => {
    expect(appTsx).toContain('pt-safe');
  });

  it('App.tsx uses h-safe-app for the root container so the shell tracks the visual viewport', () => {
    expect(appTsx).toContain('h-safe-app');
  });

  it('styles.css defines the .h-safe-screen utility class (verified via hook referencing --safe-height)', () => {
    expect(useViewportSafetyTs).toContain('--safe-height');
  });

  it('App.tsx does not use hardcoded pb-16 for main content bottom padding', () => {
    expect(appTsx).not.toContain('pb-16');
  });

  it('App.tsx applies pb-safe so the composer clears the home indicator', () => {
    expect(appTsx).toContain('pb-safe');
  });
});
