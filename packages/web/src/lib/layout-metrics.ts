export const MIN_MESSAGES_BOTTOM_PADDING_PX = 128;
export const MAX_MESSAGES_BOTTOM_PADDING_PX = 320;
const COMPOSER_CLEARANCE_PX = 16;

export function getMessagesBottomPaddingPx(footerHeightPx: number): number {
  if (!Number.isFinite(footerHeightPx) || footerHeightPx <= 0) {
    return MIN_MESSAGES_BOTTOM_PADDING_PX;
  }

  const normalizedFooterHeightPx = Math.ceil(footerHeightPx);
  const computedPaddingPx = normalizedFooterHeightPx + COMPOSER_CLEARANCE_PX;
  return Math.min(
    MAX_MESSAGES_BOTTOM_PADDING_PX,
    Math.max(MIN_MESSAGES_BOTTOM_PADDING_PX, computedPaddingPx)
  );
}
