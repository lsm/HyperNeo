import { hasNativeFolderPicker } from './runtime-capabilities.ts';

if (hasNativeFolderPicker()) {
  document.documentElement.classList.add('tauri-desktop');
  const titlebar = document.createElement('div');
  titlebar.className = 'desktop-drag-strip';
  titlebar.setAttribute('data-tauri-drag-region', '');
  document.body.prepend(titlebar);
}
