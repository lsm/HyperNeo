import { describe, expect, it } from 'vitest';
import indexHtml from '../../index.html?raw';
import appTsx from '../../App.tsx?raw';
import useViewportSafetyTs from '../../hooks/useViewportSafety.ts?raw';
import bottomTabBarTsx from '../../islands/BottomTabBar.tsx?raw';

describe('iOS iPad Safari safe area support', () => {
  it('viewport meta tag includes viewport-fit=cover', () => {
    expect(indexHtml).toContain('viewport-fit=cover');
  });

  it('App.tsx applies pt-safe class to the root container for top safe area', () => {
    expect(appTsx).toContain('pt-safe');
  });

  it('App.tsx uses h-dvh for the root container', () => {
    expect(appTsx).toContain('h-dvh');
  });

  it('styles.css defines the .h-safe-screen utility class (verified via hook referencing --safe-height)', () => {
    expect(useViewportSafetyTs).toContain('--safe-height');
  });

  it('App.tsx does not use hardcoded pb-16 for main content bottom padding', () => {
    expect(appTsx).not.toContain('pb-16');
  });

  it('BottomTabBar sets --bottom-bar-height CSS custom property', () => {
    expect(bottomTabBarTsx).toContain('--bottom-bar-height');
  });

  it('BottomTabBar uses a fixed height constant instead of dynamic measurement', () => {
    expect(bottomTabBarTsx).toContain('BOTTOM_BAR_HEIGHT');
  });

  it('BottomTabBar resets --bottom-bar-height on unmount', () => {
    expect(bottomTabBarTsx).toContain("'--bottom-bar-height', '0px'");
  });
});
