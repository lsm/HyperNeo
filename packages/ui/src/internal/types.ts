import type { ComponentType, JSX } from 'preact';

export type ElementType = keyof JSX.IntrinsicElements | ComponentType<Record<string, unknown>>;

export enum Features {
  None = 0,
  RenderStrategy = 1,
  Static = 2,
}

export enum RenderStrategy {
  Unmount = 0,
  Hidden = 1,
}
