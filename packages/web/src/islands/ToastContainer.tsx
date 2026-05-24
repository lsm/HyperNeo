import { toastsSignal } from '../lib/toast.ts';
import { ToastItem } from '../components/ui/Toast.tsx';

export default function ToastContainer() {
  const toasts = toastsSignal.value;

  return (
    <div class="fixed top-4 right-4 z-50 flex flex-col gap-3 pointer-events-none max-w-sm w-full">
      {toasts.slice(-3).map((toast) => (
        <div key={toast.id} class="pointer-events-auto">
          <ToastItem toast={toast} />
        </div>
      ))}
    </div>
  );
}
