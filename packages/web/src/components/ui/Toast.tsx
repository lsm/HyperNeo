import { useEffect, useState } from 'preact/hooks';
import { cn } from '../../lib/utils.ts';
import { borderColors } from '../../lib/design-tokens.ts';
import type { Toast, ToastType } from '../../lib/toast.ts';
import { dismissToast } from '../../lib/toast.ts';

interface ToastItemProps {
  toast: Toast;
}

function ToastItem({ toast }: ToastItemProps) {
  const [progress, setProgress] = useState(100);
  const [isExiting, setIsExiting] = useState(false);

  useEffect(() => {
    if (!toast.duration || toast.duration <= 0) return;

    const interval = 50;
    const steps = toast.duration / interval;
    const decrement = 100 / steps;

    let currentProgress = 100;
    const timer = setInterval(() => {
      currentProgress -= decrement;
      if (currentProgress <= 0) {
        clearInterval(timer);
        setProgress(0);
      } else {
        setProgress(currentProgress);
      }
    }, interval);

    return () => clearInterval(timer);
  }, [toast.duration]);

  const handleDismiss = () => {
    setIsExiting(true);
    setTimeout(() => dismissToast(toast.id), 150);
  };

  const getIcon = (type: ToastType) => {
    switch (type) {
      case 'success':
        return (
          <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
            <path
              fill-rule="evenodd"
              d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
              clip-rule="evenodd"
            />
          </svg>
        );
      case 'error':
        return (
          <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
            <path
              fill-rule="evenodd"
              d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
              clip-rule="evenodd"
            />
          </svg>
        );
      case 'warning':
        return (
          <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
            <path
              fill-rule="evenodd"
              d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
              clip-rule="evenodd"
            />
          </svg>
        );
      case 'info':
      default:
        return (
          <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
            <path
              fill-rule="evenodd"
              d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
              clip-rule="evenodd"
            />
          </svg>
        );
    }
  };

  const getStyles = (type: ToastType) => {
    switch (type) {
      case 'success':
        return `bg-green-500/10 ${borderColors.special.toast.success} text-green-400`;
      case 'error':
        return `bg-red-500/10 ${borderColors.special.toast.error} text-red-400`;
      case 'warning':
        return `bg-yellow-500/10 ${borderColors.special.toast.warning} text-yellow-400`;
      case 'info':
      default:
        return `bg-blue-500/10 ${borderColors.special.toast.info} text-blue-400`;
    }
  };

  const getProgressColor = (type: ToastType) => {
    switch (type) {
      case 'success':
        return 'bg-green-500';
      case 'error':
        return 'bg-red-500';
      case 'warning':
        return 'bg-yellow-500';
      case 'info':
      default:
        return 'bg-blue-500';
    }
  };

  return (
    <div
      class={cn(
        'relative flex items-start gap-3 p-4 rounded-lg border shadow-lg backdrop-blur-sm overflow-hidden transition-all duration-150',
        getStyles(toast.type),
        isExiting ? 'opacity-0 translate-x-full' : 'opacity-100 translate-x-0 animate-slideInRight'
      )}
      role="alert"
    >
      <div class="flex-shrink-0">{getIcon(toast.type)}</div>

      <div class="flex-1 text-sm text-gray-100 pt-0.5">{toast.message}</div>

      <button
        onClick={handleDismiss}
        class="flex-shrink-0 text-gray-400 hover:text-gray-100 transition-colors"
        aria-label="Dismiss notification"
      >
        <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
          <path
            fill-rule="evenodd"
            d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
            clip-rule="evenodd"
          />
        </svg>
      </button>

      {toast.duration && toast.duration > 0 && (
        <div class="absolute bottom-0 left-0 right-0 h-1 bg-white/10">
          <div
            class={cn('h-full transition-all', getProgressColor(toast.type))}
            style={{ width: `${progress}%` }}
          />
        </div>
      )}
    </div>
  );
}

export { ToastItem };
