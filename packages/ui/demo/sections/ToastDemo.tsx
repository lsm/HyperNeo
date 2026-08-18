import { useState } from 'preact/hooks';
import {
  Toast,
  ToastAction,
  ToastDescription,
  ToastProgress,
  Toaster,
  ToastTitle,
  useToast,
} from '../../src/mod.ts';
import type { ToastVariant } from '../../src/mod.ts';

interface DemoToast {
  id: number;
  type: ToastVariant;
  title: string;
  description: string;
  show: boolean;
  showProgress?: boolean;
}

let demoToastId = 0;

const borderColorMap: Record<ToastVariant, string> = {
  success: 'border-l-green-500',
  error: 'border-l-red-500',
  info: 'border-l-accent-500',
  warning: 'border-l-yellow-500',
};

const iconColorMap: Record<ToastVariant, string> = {
  success: 'text-green-400',
  error: 'text-red-400',
  info: 'text-accent-400',
  warning: 'text-yellow-400',
};

const iconMap: Record<ToastVariant, string> = {
  success: '✓',
  error: '✕',
  info: 'ℹ',
  warning: '⚠',
};

const messages: Record<ToastVariant, { title: string; description: string }> = {
  success: { title: 'Changes saved', description: 'Your file was saved successfully.' },
  error: { title: 'Something went wrong', description: 'Please check the logs and try again.' },
  info: { title: 'Update available', description: 'A new version has been released.' },
  warning: { title: 'Storage almost full', description: 'You have used 95% of your storage.' },
};

function ToastStack() {
  const [toasts, setToasts] = useState<DemoToast[]>([]);

  function add(type: ToastVariant, showProgress = false) {
    const id = ++demoToastId;
    setToasts((prev) => [...prev, { id, type, show: true, showProgress, ...messages[type] }]);
  }

  function dismiss(id: number) {
    setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, show: false } : t)));
  }

  function remove(id: number) {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }

  return (
    <div class="space-y-4">
      <div class="flex gap-3 flex-wrap">
        <button
          onClick={() => add('success')}
          class="px-4 py-2 rounded-lg bg-green-900/30 border border-green-700 text-green-300 text-sm font-medium hover:bg-green-900/50 transition-colors cursor-pointer"
        >
          Success toast
        </button>
        <button
          onClick={() => add('error')}
          class="px-4 py-2 rounded-lg bg-red-900/30 border border-red-700 text-red-300 text-sm font-medium hover:bg-red-900/50 transition-colors cursor-pointer"
        >
          Error toast
        </button>
        <button
          onClick={() => add('warning')}
          class="px-4 py-2 rounded-lg bg-yellow-900/30 border border-yellow-700 text-yellow-300 text-sm font-medium hover:bg-yellow-900/50 transition-colors cursor-pointer"
        >
          Warning toast
        </button>
        <button
          onClick={() => add('info')}
          class="px-4 py-2 rounded-lg bg-surface-2 border border-surface-border text-text-primary text-sm font-medium hover:border-accent-500 transition-colors cursor-pointer"
        >
          Info toast
        </button>
        <button
          onClick={() => add('success', true)}
          class="px-4 py-2 rounded-lg bg-surface-2 border border-surface-border text-text-primary text-sm font-medium hover:border-accent-500 transition-colors cursor-pointer"
        >
          Success with progress
        </button>
      </div>

      <div class="space-y-2 max-w-sm">
        {toasts.map((t) => (
          <Toast
            key={t.id}
            show={t.show}
            duration={4000}
            variant={t.type}
            showProgress={t.showProgress}
            afterLeave={() => remove(t.id)}
            class={`flex flex-col bg-surface-1 border border-surface-border border-l-4 rounded-lg shadow-lg transition-all duration-200 data-[closed]:opacity-0 data-[closed]:translate-y-1 ${borderColorMap[t.type]}`}
          >
            <div class="flex items-start gap-3 p-4">
              <span class={`text-sm font-bold shrink-0 mt-0.5 ${iconColorMap[t.type]}`}>
                {iconMap[t.type]}
              </span>
              <div class="flex-1 min-w-0">
                <ToastTitle class="text-sm font-semibold text-text-primary">{t.title}</ToastTitle>
                <ToastDescription class="text-xs text-text-tertiary mt-0.5">
                  {t.description}
                </ToastDescription>
              </div>
              <ToastAction
                onClick={() => dismiss(t.id)}
                class="shrink-0 text-text-muted hover:text-text-secondary transition-colors cursor-pointer text-xs"
              >
                ✕
              </ToastAction>
            </div>
            {t.showProgress && (
              <ToastProgress class="h-1 bg-surface-border rounded-b-lg overflow-hidden">
                <div
                  class="h-full transition-all duration-75 ease-linear"
                  style={{ width: '100%', backgroundColor: 'var(--color-accent-500)' }}
                  data-progress-bar
                />
              </ToastProgress>
            )}
          </Toast>
        ))}
      </div>

      <p class="text-xs text-text-muted">Auto-dismisses after 4 s. Click ✕ to dismiss early.</p>
    </div>
  );
}

function ToastWithAction() {
  const [show, setShow] = useState(false);

  return (
    <div class="space-y-3">
      <button
        onClick={() => setShow(true)}
        class="px-4 py-2 rounded-lg bg-surface-2 border border-surface-border text-sm text-text-primary hover:border-accent-500 transition-colors cursor-pointer"
      >
        Show toast with action
      </button>

      <div class="max-w-sm">
        <Toast
          show={show}
          duration={0}
          afterLeave={() => setShow(false)}
          class="flex items-start gap-3 bg-surface-1 border border-surface-border border-l-4 border-l-accent-500 rounded-lg p-4 shadow-lg transition-all duration-200 data-[closed]:opacity-0 data-[closed]:translate-y-1"
        >
          <span class="text-accent-400 text-sm font-bold shrink-0 mt-0.5">ℹ</span>
          <div class="flex-1 min-w-0">
            <ToastTitle class="text-sm font-semibold text-text-primary">Confirm action</ToastTitle>
            <ToastDescription class="text-xs text-text-tertiary mt-0.5">
              This toast stays open (duration: 0) until you act.
            </ToastDescription>
            <div class="flex gap-2 mt-3">
              <ToastAction
                onClick={() => setShow(false)}
                class="px-3 py-1 rounded bg-accent-500 hover:bg-accent-600 text-white text-xs font-medium transition-colors cursor-pointer"
              >
                Confirm
              </ToastAction>
              <ToastAction
                onClick={() => setShow(false)}
                class="px-3 py-1 rounded bg-surface-3 hover:bg-surface-border text-text-secondary text-xs font-medium transition-colors cursor-pointer"
              >
                Cancel
              </ToastAction>
            </div>
          </div>
        </Toast>
      </div>
      <p class="text-xs text-text-muted">No auto-dismiss — requires explicit user action.</p>
    </div>
  );
}

function ToasterSection() {
  const { toast } = useToast();

  return (
    <div class="space-y-3">
      <div class="flex gap-3 flex-wrap">
        <button
          onClick={() =>
            toast({
              title: 'Deployed successfully',
              description: 'Your build is live.',
              variant: 'success',
              duration: 3000,
            })
          }
          class="px-4 py-2 rounded-lg bg-surface-2 border border-surface-border text-sm text-text-primary hover:border-accent-500 transition-colors cursor-pointer"
        >
          Success (3 s)
        </button>
        <button
          onClick={() =>
            toast({
              title: 'Something went wrong',
              description: 'Please check the logs.',
              variant: 'error',
              duration: 5000,
            })
          }
          class="px-4 py-2 rounded-lg bg-surface-2 border border-surface-border text-sm text-text-primary hover:border-accent-500 transition-colors cursor-pointer"
        >
          Error (5 s)
        </button>
        <button
          onClick={() =>
            toast({
              title: 'Persistent notification',
              description: 'Set duration: 0 to keep open.',
              duration: 0,
            })
          }
          class="px-4 py-2 rounded-lg bg-surface-2 border border-surface-border text-sm text-text-primary hover:border-accent-500 transition-colors cursor-pointer"
        >
          No auto-dismiss
        </button>
        <button
          onClick={() =>
            toast({
              title: 'With icon',
              description: 'Custom icon rendered before title.',
              icon: <span class="text-lg">🎯</span>,
              duration: 3000,
            })
          }
          class="px-4 py-2 rounded-lg bg-surface-2 border border-surface-border text-sm text-text-primary hover:border-accent-500 transition-colors cursor-pointer"
        >
          With custom icon
        </button>
        <button
          onClick={() =>
            toast({
              title: 'With progress',
              description: 'Shows remaining time.',
              variant: 'info',
              showProgress: true,
              duration: 3000,
            })
          }
          class="px-4 py-2 rounded-lg bg-surface-2 border border-surface-border text-sm text-text-primary hover:border-accent-500 transition-colors cursor-pointer"
        >
          With progress bar
        </button>
      </div>
      <p class="text-xs text-text-muted">
        Toasts render via the <code class="text-accent-400 font-mono">Toaster</code> portal at
        bottom-right of the viewport.
      </p>
      <Toaster
        position="bottom-right"
        class="fixed bottom-4 right-4 z-50 flex flex-col gap-2 w-72"
      />
    </div>
  );
}

export function ToastDemo() {
  return (
    <div class="space-y-8">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">
          Typed toasts — success / error / warning / info with data-variant
        </h3>
        <ToastStack />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">
          Toast with ToastAction (persistent, duration: 0)
        </h3>
        <ToastWithAction />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">
          useToast() hook + Toaster portal — variant, icon, progress
        </h3>
        <ToasterSection />
      </div>
    </div>
  );
}
