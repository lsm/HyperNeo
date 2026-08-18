import type { ComponentType, JSX, VNode } from 'preact';

export type ElementType = keyof JSX.IntrinsicElements | ComponentType<Record<string, unknown>>;

export type PropsOf<T extends ElementType> = T extends keyof JSX.IntrinsicElements
  ? JSX.IntrinsicElements[T]
  : T extends ComponentType<infer P>
    ? P
    : never;

export type Render<SlotType, DefaultTag extends ElementType = 'div'> = {
  as?: DefaultTag | ElementType;
  children?: VNode | ((slot: SlotType) => VNode);
  refName?: string;
};

export interface HasDisplayName {
  displayName: string;
}

export enum Features {
  None = 0,
  RenderStrategy = 1,
  Static = 2,
}

export enum RenderStrategy {
  Unmount = 0,
  Hidden = 1,
}
