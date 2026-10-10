const INTERACTIVE =
  'a, button, input, textarea, select, label, summary, [role="button"], [role="link"], [contenteditable=""], [contenteditable="true"]';

export function blurComposerOnTap(event: MouseEvent): void {
  const area = event.currentTarget;
  const active = document.activeElement;
  if (!(area instanceof Element) || !(active instanceof HTMLTextAreaElement)) return;
  if (area.contains(active)) return;
  if (event.target instanceof Element && event.target.closest(INTERACTIVE)) return;
  if (!(document.getSelection()?.isCollapsed ?? true)) return;
  active.blur();
}
