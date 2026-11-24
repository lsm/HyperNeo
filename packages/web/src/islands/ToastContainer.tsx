import { toastsSignal } from '../lib/toast.ts';
import { ToastItem } from '../components/ui/Toast.tsx';

export default function ToastContainer() {
  const toasts = toastsSignal.value;

  return (
    <div class="fixed inset-x-4 top-4 z-50 ml-auto flex max-w-sm flex-col gap-3 pointer-events-none">
      {toasts.slice(-3).map((toast) => (
        <div key={toast.id} class="pointer-events-auto">
          <ToastItem toast={toast} />
        </div>
      ))}
    </div>
  );
}
