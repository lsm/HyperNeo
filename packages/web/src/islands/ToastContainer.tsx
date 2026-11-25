import { toastsSignal } from '../lib/toast.ts';
import { ToastItem } from '../components/ui/Toast.tsx';

export default function ToastContainer() {
  const toasts = toastsSignal.value;

  return (
    <div class="fixed inset-x-4 top-4 z-50 ml-auto flex max-h-[40dvh] max-w-sm flex-col gap-3 overflow-y-auto overscroll-y-contain pointer-events-none">
      {toasts.slice(-3).map((toast) => (
        <div key={toast.id} class="shrink-0 pointer-events-auto">
          <ToastItem toast={toast} />
        </div>
      ))}
    </div>
  );
}
