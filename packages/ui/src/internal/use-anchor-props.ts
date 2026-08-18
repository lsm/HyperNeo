import { useMemo } from 'preact/hooks';

export type Align = 'start' | 'end';

export type Placement = 'top' | 'right' | 'bottom' | 'left';

export type AnchorTo = `${Placement}` | `${Placement} ${Align}`;

export type AnchorToWithSelection =
  | `${Placement | 'selection'}`
  | `${Placement | 'selection'} ${Align}`;

type BaseAnchorProps = {
  gap: number | string;

  offset: number | string;

  padding: number | string;
};

export type AnchorProps =
  | false
  | AnchorTo
  | Partial<
      BaseAnchorProps & {
        to: AnchorTo;
      }
    >;

export type AnchorPropsWithSelection =
  | false
  | AnchorToWithSelection
  | Partial<
      BaseAnchorProps & {
        to: AnchorToWithSelection;
      }
    >;

export type InternalFloatingPanelProps = Partial<{
  inner: {
    listRef: React.MutableRefObject<(HTMLElement | null)[]>;
    index: number;
  };
}>;

export function useResolvedAnchor<T extends AnchorProps | AnchorPropsWithSelection>(
  anchor?: T
): Exclude<T, boolean | string> | null {
  return useMemo(() => {
    if (!anchor) return null;
    if (typeof anchor === 'string') return { to: anchor } as Exclude<T, boolean | string>;
    return anchor as Exclude<T, boolean | string>;
  }, [anchor]);
}
