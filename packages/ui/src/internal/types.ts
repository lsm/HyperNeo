import type { ComponentType, JSX, VNode } from 'preact';

// Polymorphic "as" prop support
export type ElementType = keyof JSX.IntrinsicElements | ComponentType<Record<string, unknown>>;

// Extract props from an element type
export type PropsOf<T extends ElementType> = T extends keyof JSX.IntrinsicElements
  ? JSX.IntrinsicElements[T]
  : T extends ComponentType<infer P>
    ? P
    : never;

// Render prop pattern: children can be a function receiving slot data
export type Render<SlotType, DefaultTag extends ElementType = 'div'> = {
  as?: DefaultTag | ElementType;
  children?: VNode | ((slot: SlotType) => VNode);
  refName?: string;
};

// Component with display name (for devtools)
export interface HasDisplayName {
  displayName: string;
}

// Enum helper
export enum Features {
  None = 0,
  RenderStrategy = 1,
  Static = 2,
}

// Render strategy
export enum RenderStrategy {
  Unmount = 0,
  Hidden = 1,
}
