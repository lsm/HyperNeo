import { useState } from 'preact/hooks';
import type { VNode } from 'preact';
import { Transition, Toaster, useToast } from '../../src/mod.ts';
import type { ToastVariant } from '../../src/mod.ts';
import { CheckCircle, Inbox, X } from 'lucide-preact';

interface NotificationItem {
  id: number;
  variant: ToastVariant;
  title: string;
  description: string;
  timestamp: Date;
  read: boolean;
}

const iconColorMap: Record<ToastVariant, string> = {
  success: 'text-green-400',
  error: 'text-red-400',
  info: 'text-accent-400',
  warning: 'text-yellow-400',
};

const iconBgMap: Record<ToastVariant, string> = {
  success: 'bg-green-400/10',
  error: 'bg-red-400/10',
  info: 'bg-accent-400/10',
  warning: 'bg-yellow-400/10',
};

const borderColorMap: Record<ToastVariant, string> = {
  success: 'border-l-green-500',
  error: 'border-l-red-500',
  info: 'border-l-accent-500',
  warning: 'border-l-yellow-500',
};

function CheckCircleIcon() {
  return (
    <svg class="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
      <path
        fill-rule="evenodd"
        d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z"
        clip-rule="evenodd"
      />
    </svg>
  );
}

function XCircleIcon() {
  return (
    <svg class="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
      <path
        fill-rule="evenodd"
        d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z"
        clip-rule="evenodd"
      />
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg class="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
      <path
        fill-rule="evenodd"
        d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z"
        clip-rule="evenodd"
      />
    </svg>
  );
}

function ExclamationIcon() {
  return (
    <svg class="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
      <path
        fill-rule="evenodd"
        d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z"
        clip-rule="evenodd"
      />
    </svg>
  );
}

function BellIcon() {
  return (
    <svg class="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
      <path d="M10 2a6 6 0 00-6 6v3.586l-.707.707A1 1 0 004 14h12a1 1 0 00.707-1.707L16 11.586V8a6 6 0 00-6-6zM10 18a3 3 0 01-3-3h6a3 3 0 01-3 3z" />
    </svg>
  );
}

const iconMap: Record<ToastVariant, () => VNode> = {
  success: CheckCircleIcon,
  error: XCircleIcon,
  info: InfoIcon,
  warning: ExclamationIcon,
};

function NotificationStack() {
  const { toast } = useToast();

  return (
    <div class="space-y-4">
      <div class="flex gap-3 flex-wrap">
        <button
          onClick={() =>
            toast({
              title: 'File uploaded',
              description: 'image-banner.png has been uploaded to your project.',
              variant: 'success',
              duration: 5000,
            })
          }
          class="px-4 py-2 rounded-lg bg-green-900/30 border border-green-700 text-green-300 text-sm font-medium hover:bg-green-900/50 transition-colors cursor-pointer"
        >
          Success notification
        </button>
        <button
          onClick={() =>
            toast({
              title: 'Build failed',
              description: '3 errors found in src/components/App.tsx',
              variant: 'error',
              duration: 8000,
            })
          }
          class="px-4 py-2 rounded-lg bg-red-900/30 border border-red-700 text-red-300 text-sm font-medium hover:bg-red-900/50 transition-colors cursor-pointer"
        >
          Error notification
        </button>
        <button
          onClick={() =>
            toast({
              title: 'Deploy complete',
              description: 'Your changes are now live at example.com',
              variant: 'info',
              duration: 5000,
            })
          }
          class="px-4 py-2 rounded-lg bg-surface-2 border border-surface-border text-text-primary text-sm font-medium hover:border-accent-500 transition-colors cursor-pointer"
        >
          Info notification
        </button>
        <button
          onClick={() =>
            toast({
              title: 'Storage limit warning',
              description: 'You have used 85% of your storage quota.',
              variant: 'warning',
              duration: 0,
            })
          }
          class="px-4 py-2 rounded-lg bg-yellow-900/30 border border-yellow-700 text-yellow-300 text-sm font-medium hover:bg-yellow-900/50 transition-colors cursor-pointer"
        >
          Warning notification
        </button>
        <button
          onClick={() =>
            toast({
              title: 'Deployment in progress',
              description: 'This may take a few minutes...',
              variant: 'info',
              showProgress: true,
              duration: 10000,
            })
          }
          class="px-4 py-2 rounded-lg bg-surface-2 border border-surface-border text-text-primary text-sm font-medium hover:border-accent-500 transition-colors cursor-pointer"
        >
          With progress bar
        </button>
      </div>

      <p class="text-xs text-text-muted">
        Typed notifications using <code class="text-accent-400 font-mono">ToastVariant</code> with{' '}
        <code class="text-accent-400 font-mono">data-variant</code> attribute for styling.
      </p>

      <Toaster
        position="bottom-right"
        class="fixed bottom-4 right-4 z-50 flex flex-col gap-2 w-80"
      />
    </div>
  );
}

function NotificationCard({
  variant,
  title,
  description,
}: {
  variant: ToastVariant;
  title: string;
  description: string;
}) {
  const Icon = iconMap[variant];

  return (
    <div
      class={`flex items-start gap-3 p-4 bg-surface-1 border border-surface-border border-l-4 rounded-lg shadow-md ${borderColorMap[variant]}`}
    >
      <span
        class={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${iconBgMap[variant]} ${iconColorMap[variant]}`}
      >
        <Icon />
      </span>
      <div class="flex-1 min-w-0">
        <p class="text-sm font-medium text-text-primary">{title}</p>
        <p class="mt-0.5 text-xs text-text-tertiary">{description}</p>
      </div>
    </div>
  );
}

function NotificationGroup() {
  const [notifications, setNotifications] = useState<NotificationItem[]>([
    {
      id: 1,
      variant: 'success',
      title: 'Deployment successful',
      description: 'v2.3.1 is now live in production',
      timestamp: new Date(Date.now() - 5 * 60 * 1000),
      read: false,
    },
    {
      id: 2,
      variant: 'info',
      title: 'New comment',
      description: 'Sarah mentioned you in "API Design"',
      timestamp: new Date(Date.now() - 30 * 60 * 1000),
      read: false,
    },
    {
      id: 3,
      variant: 'warning',
      title: 'SSL certificate expiring',
      description: 'Renew within 7 days to avoid downtime',
      timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000),
      read: true,
    },
  ]);

  const unreadCount = notifications.filter((n) => !n.read).length;

  function dismiss(id: number) {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  }

  function markAllRead() {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  }

  return (
    <div class="space-y-4">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <BellIcon />
          <span class="text-sm font-medium text-text-primary">Notifications</span>
          {unreadCount > 0 && (
            <span class="px-2 py-0.5 text-xs font-medium bg-accent-500 text-white rounded-full">
              {unreadCount}
            </span>
          )}
        </div>
        {unreadCount > 0 && (
          <button
            type="button"
            onClick={markAllRead}
            class="text-xs text-accent-400 hover:text-accent-300 transition-colors cursor-pointer"
          >
            Mark all as read
          </button>
        )}
      </div>

      <div class="space-y-2">
        {notifications.map((notification) => (
          <div
            key={notification.id}
            class={`group relative p-4 bg-surface-1 border border-surface-border rounded-lg transition-colors ${
              notification.read
                ? 'opacity-60'
                : `border-l-4 ${borderColorMap[notification.variant]}`
            }`}
          >
            <NotificationCard
              variant={notification.variant}
              title={notification.title}
              description={notification.description}
            />
            <button
              type="button"
              onClick={() => dismiss(notification.id)}
              class="absolute top-2 right-2 p-1 rounded text-text-muted hover:text-text-primary hover:bg-surface-2 transition-colors cursor-pointer opacity-0 group-hover:opacity-100"
            >
              <svg class="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
              </svg>
            </button>
          </div>
        ))}
      </div>

      <p class="text-xs text-text-muted">
        Notification groups with unread badges, mark as read, and dismiss functionality.
      </p>
    </div>
  );
}

function InlineToastExamples() {
  return (
    <div class="space-y-4">
      <h4 class="text-sm font-medium text-text-secondary">Inline variants</h4>
      <div class="grid gap-3 sm:grid-cols-2">
        <NotificationCard
          variant="success"
          title="Changes saved"
          description="Your project has been updated successfully."
        />
        <NotificationCard
          variant="error"
          title="Payment failed"
          description="Please check your card details and try again."
        />
        <NotificationCard
          variant="info"
          title="Meeting in 10 minutes"
          description="Standup sync in the #engineering room."
        />
        <NotificationCard
          variant="warning"
          title="Low disk space"
          description="Only 2GB remaining. Consider freeing up space."
        />
      </div>
    </div>
  );
}

function NotificationWithAvatar() {
  const [show, setShow] = useState(false);

  return (
    <div class="space-y-4">
      <button
        type="button"
        onClick={() => setShow(true)}
        class="px-4 py-2 rounded-lg bg-surface-2 border border-surface-border text-sm text-text-primary hover:border-accent-500 transition-colors cursor-pointer"
      >
        Show avatar notification
      </button>

      <div
        aria-live="assertive"
        class="pointer-events-none fixed inset-0 flex items-end px-4 py-6 sm:items-start sm:p-6"
      >
        <div class="flex w-full flex-col items-center space-y-4 sm:items-end">
          <Transition show={show}>
            <div class="pointer-events-auto flex w-full max-w-md rounded-lg bg-surface-1 shadow-lg border border-surface-border transition-all duration-300 ease-out data-[closed]:opacity-0 data-[closed]:translate-y-2">
              <div class="w-0 flex-1 p-4">
                <div class="flex items-start">
                  <div class="shrink-0 pt-0.5">
                    <img
                      alt=""
                      src="https://images.unsplash.com/photo-1494790108377-be9c29b29330?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2.2&w=160&h=160&q=80"
                      class="h-10 w-10 rounded-full bg-surface-2"
                    />
                  </div>
                  <div class="ml-3 w-0 flex-1">
                    <p class="text-sm font-medium text-text-primary">Emilia Gates</p>
                    <p class="mt-1 text-sm text-text-secondary">Sure! 8:30pm works great!</p>
                  </div>
                </div>
              </div>
              <div class="flex border-l border-surface-border">
                <button
                  type="button"
                  onClick={() => setShow(false)}
                  class="flex w-full items-center justify-center rounded-none rounded-r-lg p-4 text-sm font-medium text-accent-400 hover:text-accent-300 focus:outline-none focus:ring-2 focus:ring-accent-500 focus:ring-inset transition-colors cursor-pointer"
                >
                  Reply
                </button>
              </div>
            </div>
          </Transition>
        </div>
      </div>

      <p class="text-xs text-text-muted">
        Notification with avatar using <code class="text-accent-400 font-mono">Transition</code>{' '}
        component.
      </p>
    </div>
  );
}

function NotificationWithSplitButtons() {
  const [show, setShow] = useState(false);

  return (
    <div class="space-y-4">
      <button
        type="button"
        onClick={() => setShow(true)}
        class="px-4 py-2 rounded-lg bg-surface-2 border border-surface-border text-sm text-text-primary hover:border-accent-500 transition-colors cursor-pointer"
      >
        Show split-button notification
      </button>

      <div
        aria-live="assertive"
        class="pointer-events-none fixed inset-0 flex items-end px-4 py-6 sm:items-start sm:p-6"
      >
        <div class="flex w-full flex-col items-center space-y-4 sm:items-end">
          <Transition show={show}>
            <div class="pointer-events-auto flex w-full max-w-md divide-x divide-surface-border rounded-lg bg-surface-1 shadow-lg border border-surface-border transition-all duration-300 ease-out data-[closed]:opacity-0 data-[closed]:translate-y-2 sm:data-[closed]:translate-x-2">
              <div class="flex w-0 flex-1 items-center p-4">
                <div class="w-full">
                  <p class="text-sm font-medium text-text-primary">Receive notifications</p>
                  <p class="mt-1 text-sm text-text-secondary">
                    Notifications may include alerts, sounds, and badges.
                  </p>
                </div>
              </div>
              <div class="flex">
                <div class="flex flex-col divide-y divide-surface-border">
                  <div class="flex h-0 flex-1">
                    <button
                      type="button"
                      onClick={() => setShow(false)}
                      class="flex w-full items-center justify-center rounded-none rounded-tr-lg px-4 py-3 text-sm font-medium text-accent-400 hover:text-accent-300 focus:outline-none focus:ring-2 focus:ring-accent-500 focus:ring-inset transition-colors cursor-pointer"
                    >
                      Reply
                    </button>
                  </div>
                  <div class="flex h-0 flex-1">
                    <button
                      type="button"
                      onClick={() => setShow(false)}
                      class="flex w-full items-center justify-center rounded-none rounded-br-lg px-4 py-3 text-sm font-medium text-text-secondary hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-accent-500 focus:ring-inset transition-colors cursor-pointer"
                    >
                      Don't allow
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </Transition>
        </div>
      </div>

      <p class="text-xs text-text-muted">
        Notification with split action buttons using{' '}
        <code class="text-accent-400 font-mono">Transition</code> component.
      </p>
    </div>
  );
}

function SimpleIconNotification() {
  const [show, setShow] = useState(false);

  return (
    <div class="space-y-4">
      <button
        type="button"
        onClick={() => setShow(true)}
        class="px-4 py-2 rounded-lg bg-surface-2 border border-surface-border text-sm text-text-primary hover:border-accent-500 transition-colors cursor-pointer"
      >
        Show simple notification
      </button>

      <div
        aria-live="assertive"
        class="pointer-events-none fixed inset-0 flex items-end px-4 py-6 sm:items-start sm:p-6"
      >
        <div class="flex w-full flex-col items-center space-y-4 sm:items-end">
          <Transition show={show}>
            <div class="pointer-events-auto w-full max-w-sm rounded-lg bg-surface-1 shadow-lg border border-surface-border transition-all duration-300 ease-out data-[closed]:opacity-0 data-[closed]:translate-y-2 data-[closed]:sm:translate-x-2">
              <div class="p-4">
                <div class="flex items-start">
                  <div class="shrink-0">
                    <CheckCircle class="size-6 text-green-400" />
                  </div>
                  <div class="ml-3 w-0 flex-1 pt-0.5">
                    <p class="text-sm font-medium text-text-primary">Successfully saved!</p>
                    <p class="mt-1 text-sm text-text-secondary">
                      Anyone with a link can now view this file.
                    </p>
                  </div>
                  <div class="ml-4 flex shrink-0">
                    <button
                      type="button"
                      onClick={() => setShow(false)}
                      class="inline-flex rounded-md text-text-muted hover:text-text-primary focus:outline-2 focus:outline-offset-2 focus:outline-accent-500 cursor-pointer"
                    >
                      <span class="sr-only">Close</span>
                      <X class="size-5" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </Transition>
        </div>
      </div>

      <p class="text-xs text-text-muted">
        Simple notification with icon using{' '}
        <code class="text-accent-400 font-mono">Transition</code> component.
      </p>
    </div>
  );
}

function CondensedNotification() {
  const [show, setShow] = useState(false);

  return (
    <div class="space-y-4">
      <button
        type="button"
        onClick={() => setShow(true)}
        class="px-4 py-2 rounded-lg bg-surface-2 border border-surface-border text-sm text-text-primary hover:border-accent-500 transition-colors cursor-pointer"
      >
        Show condensed notification
      </button>

      <div
        aria-live="assertive"
        class="pointer-events-none fixed inset-0 flex items-end px-4 py-6 sm:items-start sm:p-6"
      >
        <div class="flex w-full flex-col items-center space-y-4 sm:items-end">
          <Transition show={show}>
            <div class="pointer-events-auto w-full max-w-sm rounded-lg bg-surface-1 shadow-lg border border-surface-border transition-all duration-300 ease-out data-[closed]:opacity-0 data-[closed]:translate-y-2 data-[closed]:sm:translate-x-2">
              <div class="p-4">
                <div class="flex items-center">
                  <div class="flex w-0 flex-1 justify-between">
                    <p class="w-0 flex-1 text-sm font-medium text-text-primary">
                      Discussion archived
                    </p>
                    <button
                      type="button"
                      class="ml-3 shrink-0 rounded-md bg-surface-1 text-sm font-medium text-accent-400 hover:text-accent-300 focus:outline-2 focus:outline-offset-2 focus:outline-accent-500 dark:bg-gray-800 cursor-pointer"
                    >
                      Undo
                    </button>
                  </div>
                  <div class="ml-4 flex shrink-0">
                    <button
                      type="button"
                      onClick={() => setShow(false)}
                      class="inline-flex rounded-md text-text-muted hover:text-text-primary focus:outline-2 focus:outline-offset-2 focus:outline-accent-500 cursor-pointer"
                    >
                      <span class="sr-only">Close</span>
                      <X class="size-5" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </Transition>
        </div>
      </div>

      <p class="text-xs text-text-muted">
        Condensed notification with undo action using{' '}
        <code class="text-accent-400 font-mono">Transition</code> component.
      </p>
    </div>
  );
}

function NotificationWithActionsBelow() {
  const [show, setShow] = useState(false);

  return (
    <div class="space-y-4">
      <button
        type="button"
        onClick={() => setShow(true)}
        class="px-4 py-2 rounded-lg bg-surface-2 border border-surface-border text-sm text-text-primary hover:border-accent-500 transition-colors cursor-pointer"
      >
        Show notification with actions
      </button>

      <div
        aria-live="assertive"
        class="pointer-events-none fixed inset-0 flex items-end px-4 py-6 sm:items-start sm:p-6"
      >
        <div class="flex w-full flex-col items-center space-y-4 sm:items-end">
          <Transition show={show}>
            <div class="pointer-events-auto w-full max-w-sm rounded-lg bg-surface-1 shadow-lg border border-surface-border transition-all duration-300 ease-out data-[closed]:opacity-0 data-[closed]:translate-y-2 data-[closed]:sm:translate-x-2">
              <div class="p-4">
                <div class="flex items-start">
                  <div class="shrink-0">
                    <Inbox class="size-6 text-text-tertiary" />
                  </div>
                  <div class="ml-3 w-0 flex-1 pt-0.5">
                    <p class="text-sm font-medium text-text-primary">Discussion moved</p>
                    <p class="mt-1 text-sm text-text-secondary">
                      Lorem ipsum dolor sit amet consectetur adipisicing elit oluptatum tenetur.
                    </p>
                    <div class="mt-3 flex space-x-7">
                      <button
                        type="button"
                        class="rounded-md text-sm font-medium text-accent-400 hover:text-accent-300 focus:outline-2 focus:outline-offset-2 focus:outline-accent-500 cursor-pointer"
                      >
                        Undo
                      </button>
                      <button
                        type="button"
                        class="rounded-md text-sm font-medium text-text-secondary hover:text-text-primary focus:outline-2 focus:outline-offset-2 focus:outline-accent-500 cursor-pointer"
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                  <div class="ml-4 flex shrink-0">
                    <button
                      type="button"
                      onClick={() => setShow(false)}
                      class="inline-flex rounded-md text-text-muted hover:text-text-primary focus:outline-2 focus:outline-offset-2 focus:outline-accent-500 cursor-pointer"
                    >
                      <span class="sr-only">Close</span>
                      <X class="size-5" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </Transition>
        </div>
      </div>

      <p class="text-xs text-text-muted">
        Notification with actions below using{' '}
        <code class="text-accent-400 font-mono">Transition</code> component.
      </p>
    </div>
  );
}

function NotificationWithButtonsBelow() {
  const [show, setShow] = useState(false);

  return (
    <div class="space-y-4">
      <button
        type="button"
        onClick={() => setShow(true)}
        class="px-4 py-2 rounded-lg bg-surface-2 border border-surface-border text-sm text-text-primary hover:border-accent-500 transition-colors cursor-pointer"
      >
        Show notification with buttons
      </button>

      <div
        aria-live="assertive"
        class="pointer-events-none fixed inset-0 flex items-end px-4 py-6 sm:items-start sm:p-6"
      >
        <div class="flex w-full flex-col items-center space-y-4 sm:items-end">
          <Transition show={show}>
            <div class="pointer-events-auto w-full max-w-sm rounded-lg bg-surface-1 shadow-lg border border-surface-border transition-all duration-300 ease-out data-[closed]:opacity-0 data-[closed]:translate-y-2 data-[closed]:sm:translate-x-2">
              <div class="p-4">
                <div class="flex items-start">
                  <div class="shrink-0 pt-0.5">
                    <img
                      alt=""
                      src="https://images.unsplash.com/photo-1494790108377-be9c29b29330?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2.2&w=160&h=160&q=80"
                      class="size-10 rounded-full bg-surface-2"
                    />
                  </div>
                  <div class="ml-3 w-0 flex-1">
                    <p class="text-sm font-medium text-text-primary">Emilia Gates</p>
                    <p class="mt-1 text-sm text-text-secondary">Sent you an invite to connect.</p>
                    <div class="mt-4 flex">
                      <button
                        type="button"
                        class="inline-flex items-center rounded-md bg-accent-500 px-2.5 py-1.5 text-sm font-semibold text-white shadow-xs hover:bg-accent-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 cursor-pointer"
                      >
                        Accept
                      </button>
                      <button
                        type="button"
                        class="ml-3 inline-flex items-center rounded-md bg-surface-1 px-2.5 py-1.5 text-sm font-semibold text-text-primary shadow-xs inset-ring inset-ring-surface-border hover:bg-surface-2 dark:bg-white/10 dark:text-white dark:shadow-none dark:inset-ring-white/5 dark:hover:bg-white/20 cursor-pointer"
                      >
                        Decline
                      </button>
                    </div>
                  </div>
                  <div class="ml-4 flex shrink-0">
                    <button
                      type="button"
                      onClick={() => setShow(false)}
                      class="inline-flex rounded-md text-text-muted hover:text-text-primary focus:outline-2 focus:outline-offset-2 focus:outline-accent-500 cursor-pointer"
                    >
                      <span class="sr-only">Close</span>
                      <X class="size-5" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </Transition>
        </div>
      </div>

      <p class="text-xs text-text-muted">
        Notification with buttons below using{' '}
        <code class="text-accent-400 font-mono">Transition</code> component.
      </p>
    </div>
  );
}

function NotificationDemo() {
  return (
    <div class="space-y-8">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">
          Toast notifications — typed with variants
        </h3>
        <NotificationStack />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Inline notification cards</h3>
        <InlineToastExamples />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Notification group with state</h3>
        <NotificationGroup />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Notification with avatar</h3>
        <NotificationWithAvatar />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Notification with split buttons</h3>
        <NotificationWithSplitButtons />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Simple icon notification</h3>
        <SimpleIconNotification />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Condensed notification</h3>
        <CondensedNotification />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Notification with actions below</h3>
        <NotificationWithActionsBelow />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Notification with buttons below</h3>
        <NotificationWithButtonsBelow />
      </div>
    </div>
  );
}

export {
  NotificationDemo,
  NotificationWithAvatar,
  NotificationWithSplitButtons,
  SimpleIconNotification,
  CondensedNotification,
  NotificationWithActionsBelow,
  NotificationWithButtonsBelow,
};
