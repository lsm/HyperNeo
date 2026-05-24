export const NATIVE_FOLDER_PICKER_TIMEOUT_MS = 10 * 60 * 1000 + 5 * 1000;

export function hasNativeFolderPicker(): boolean {
  if (typeof window === 'undefined') return false;
  return '__TAURI_INTERNALS__' in window || 'isTauri' in window;
}
