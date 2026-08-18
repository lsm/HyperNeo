import { signal } from '@preact/signals';

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface Toast {
  id: string;
  type: ToastType;
  message: string;
  duration?: number;
}

export const toastsSignal = signal<Toast[]>([]);

let toastIdCounter = 0;

function showToast(message: string, type: ToastType = 'info', duration = 5000) {
  const id = `toast-${++toastIdCounter}`;
  const toast: Toast = { id, message, type, duration };

  toastsSignal.value = [...toastsSignal.value, toast];

  if (duration > 0) {
    setTimeout(() => {
      dismissToast(id);
    }, duration);
  }

  return id;
}

export function dismissToast(id: string) {
  toastsSignal.value = toastsSignal.value.filter((t) => t.id !== id);
}

export const toast = {
  success: (message: string, duration?: number) => showToast(message, 'success', duration),
  error: (message: string, duration?: number) => showToast(message, 'error', duration),
  info: (message: string, duration?: number) => showToast(message, 'info', duration),
  warning: (message: string, duration?: number) => showToast(message, 'warning', duration),

  approved: (title = 'Task approved') => showToast(title, 'success'),
  rejected: (title = 'Task rejected', message?: string) =>
    showToast(message ? `${title}: ${message}` : title, 'info'),
  completed: (title = 'Task completed') => showToast(title, 'success'),
  interrupted: (title = 'Task interrupted') => showToast(title, 'info'),
};
