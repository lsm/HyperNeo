import { useEffect } from 'preact/hooks';

const KEYBOARD_THRESHOLD = 50;

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

function updateKeyboardHeight(vv: VisualViewport): void {
  const height = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
  document.documentElement.style.setProperty('--keyboard-height', `${height}px`);
}

function isKeyboardVisible(vv: VisualViewport): boolean {
  return window.innerHeight - vv.height > KEYBOARD_THRESHOLD;
}

export function useViewportSafety(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) {
      return;
    }

    const ipadSafari = isIpadSafari();
    let keyboardOpen = false;
    let savedBottomBarHeight: string | null = null;

    const handleResize = () => {
      if (ipadSafari) {
        updateSafeHeight(vv);
      }

      const kbVisible = isKeyboardVisible(vv);

      if (kbVisible && !keyboardOpen) {
        keyboardOpen = true;
        document.documentElement.classList.add('keyboard-open');

        document.documentElement.style.setProperty('--safe-height', `${vv.height}px`);

        updateKeyboardHeight(vv);

        savedBottomBarHeight =
          document.documentElement.style.getPropertyValue('--bottom-bar-height');
        document.documentElement.style.setProperty('--bottom-bar-height', '0px');
      } else if (kbVisible && keyboardOpen) {
        document.documentElement.style.setProperty('--safe-height', `${vv.height}px`);
        updateKeyboardHeight(vv);
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

        window.dispatchEvent(new Event('resize'));
      }
    };

    if (ipadSafari) {
      updateSafeHeight(vv);
    }

    if (isKeyboardVisible(vv)) {
      keyboardOpen = true;
      document.documentElement.classList.add('keyboard-open');
      document.documentElement.style.setProperty('--safe-height', `${vv.height}px`);
      updateKeyboardHeight(vv);
      savedBottomBarHeight = document.documentElement.style.getPropertyValue('--bottom-bar-height');
      document.documentElement.style.setProperty('--bottom-bar-height', '0px');
    }

    vv.addEventListener('resize', handleResize);
    window.addEventListener('resize', handleResize);

    return () => {
      vv.removeEventListener('resize', handleResize);
      window.removeEventListener('resize', handleResize);

      document.documentElement.classList.remove('keyboard-open');
      document.documentElement.style.removeProperty('--safe-height');
      document.documentElement.style.removeProperty('--keyboard-height');
      if (savedBottomBarHeight !== null) {
        document.documentElement.style.setProperty('--bottom-bar-height', savedBottomBarHeight);
      }
    };
  }, []);
}
