import { useEffect } from 'preact/hooks';

const KEYBOARD_THRESHOLD = 50;

function isZoomed(vv: VisualViewport): boolean {
  return Math.abs(vv.scale - 1) > 0.01;
}

function isIpadSafari(): boolean {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') {
    return false;
  }
  const ua = navigator.userAgent;
  const hasTouch = navigator.maxTouchPoints > 1;
  const isSafariUA =
    ua.includes('Safari') &&
    !ua.includes('Chrome') &&
    !ua.includes('CriOS') &&
    !ua.includes('FxiOS');
  return hasTouch && isSafariUA;
}

function updateSafeHeight(vv: VisualViewport): void {
  document.documentElement.style.setProperty('--safe-height', `${vv.height}px`);
}

function updateKeyboardHeight(vv: VisualViewport, fullHeight: number): void {
  const height = Math.max(0, fullHeight - vv.height);
  document.documentElement.style.setProperty('--keyboard-height', `${height}px`);
}

function isEditingText(): boolean {
  const active = document.activeElement;
  return (
    active instanceof HTMLTextAreaElement ||
    active instanceof HTMLInputElement ||
    (active instanceof HTMLElement && active.isContentEditable)
  );
}

function resetDocumentScroll(): void {
  window.scrollTo({ left: 0, top: 0, behavior: 'instant' });
}

function resetDocumentPan(vv: VisualViewport): void {
  if (window.scrollY > 0 || vv.offsetTop > 0) resetDocumentScroll();
}

export function useViewportSafety(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) {
      return;
    }

    const ipadSafari = isIpadSafari();
    let keyboardOpen = false;
    const touch = navigator.maxTouchPoints > 0;
    let fullHeight = window.innerHeight;
    let fullWidth = window.innerWidth;
    const isKeyboardVisible = (viewport: VisualViewport) => {
      if (!touch || !isEditingText() || window.innerWidth !== fullWidth) {
        fullHeight = window.innerHeight;
        fullWidth = window.innerWidth;
      }
      return fullHeight - viewport.height > KEYBOARD_THRESHOLD;
    };
    let savedBottomBarHeight: string | null = null;

    const handleResize = () => {
      if (isZoomed(vv)) return;

      if (ipadSafari) {
        updateSafeHeight(vv);
      }

      const kbVisible = isKeyboardVisible(vv);

      if (kbVisible && !keyboardOpen) {
        keyboardOpen = true;
        document.documentElement.classList.add('keyboard-open');

        document.documentElement.style.setProperty('--safe-height', `${vv.height}px`);

        updateKeyboardHeight(vv, fullHeight);

        savedBottomBarHeight =
          document.documentElement.style.getPropertyValue('--bottom-bar-height');
        document.documentElement.style.setProperty('--bottom-bar-height', '0px');
        resetDocumentPan(vv);
      } else if (kbVisible && keyboardOpen) {
        document.documentElement.style.setProperty('--safe-height', `${vv.height}px`);
        updateKeyboardHeight(vv, fullHeight);
        resetDocumentPan(vv);
      } else if (!kbVisible && keyboardOpen) {
        keyboardOpen = false;
        document.documentElement.classList.remove('keyboard-open');

        if (!ipadSafari) {
          document.documentElement.style.removeProperty('--safe-height');
        }

        document.documentElement.style.removeProperty('--keyboard-height');

        if (savedBottomBarHeight !== null) {
          document.documentElement.style.setProperty('--bottom-bar-height', savedBottomBarHeight);
          savedBottomBarHeight = null;
        }

        resetDocumentScroll();

        window.dispatchEvent(new Event('resize'));
      }
    };

    if (ipadSafari) {
      updateSafeHeight(vv);
    }

    if (!isZoomed(vv) && isKeyboardVisible(vv)) {
      keyboardOpen = true;
      document.documentElement.classList.add('keyboard-open');
      document.documentElement.style.setProperty('--safe-height', `${vv.height}px`);
      updateKeyboardHeight(vv, fullHeight);
      savedBottomBarHeight = document.documentElement.style.getPropertyValue('--bottom-bar-height');
      document.documentElement.style.setProperty('--bottom-bar-height', '0px');
    }

    const handleScroll = () => {
      if (keyboardOpen && !isZoomed(vv)) resetDocumentPan(vv);
    };

    let focusTimer: ReturnType<typeof setTimeout> | undefined;
    const handleFocusOut = () => {
      clearTimeout(focusTimer);
      focusTimer = setTimeout(handleResize, 0);
    };

    vv.addEventListener('resize', handleResize);
    vv.addEventListener('scroll', handleScroll);
    window.addEventListener('resize', handleResize);
    document.addEventListener('focusout', handleFocusOut);

    return () => {
      vv.removeEventListener('resize', handleResize);
      vv.removeEventListener('scroll', handleScroll);
      window.removeEventListener('resize', handleResize);
      document.removeEventListener('focusout', handleFocusOut);
      clearTimeout(focusTimer);

      document.documentElement.classList.remove('keyboard-open');
      document.documentElement.style.removeProperty('--safe-height');
      document.documentElement.style.removeProperty('--keyboard-height');
      if (savedBottomBarHeight !== null) {
        document.documentElement.style.setProperty('--bottom-bar-height', savedBottomBarHeight);
      }
    };
  }, []);
}
