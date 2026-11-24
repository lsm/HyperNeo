import { toastsSignal } from '../lib/toast.ts';
import { ToastItem } from '../components/ui/Toast.tsx';

export default function ToastContainer() {
  const toasts = toastsSignal.value;

  return (
    <div class="fixed top-4 right-4 z-50 flex max-h-[40dvh] w-[calc(100%-2rem)] max-w-sm flex-col gap-3 overflow-y-auto overscroll-y-contain pointer-events-none">
      {toasts.slice(-3).map((toast) => (
        <div key={toast.id} class="shrink-0 pointer-events-auto">
          <ToastItem toast={toast} />
        </div>
      ))}
    </div>
  );
}
